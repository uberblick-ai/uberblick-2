/**
 * Project-local ownership for workflows adopted through `ub agents`.
 *
 * The package is fully validated before this module receives it. Files are
 * then treated as inert bytes: no hook is run, no agent is started, and only
 * the selected Git project's ordinary paths and ownership record are touched.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { type Io, processIo } from "./io.js";
import { resolveProjectRoot } from "./project.js";
import {
  checkedPayloadPath,
  checkedVersion,
  checkedWorkflow,
  contentDigest,
  DIGEST_FRAMING,
  fileMode,
  loadWorkflowPackage,
  type LoadedWorkflowPackage,
  type WorkflowManifest,
  type WorkflowMode,
  type WorkflowPackageEntry,
} from "./workflow-package.js";

export const WORKFLOW_RECORD = ".agents/workflow.lock.json";

export const AGENTS_INSTALL_HELP = `usage: ub agents install <workflow@version|package-path> [--project <dir>]

Adopt one validated workflow in the selected Git project. A local source is an
extracted package directory or a .tar.gz package; a published source is an exact
workflow@MAJOR.MINOR.PATCH name. The command starts no agent and commits nothing.

options:
  --project <dir>        select the Git project; defaults to the current project
  -h, --help             show this help
`;

export const AGENTS_UPDATE_HELP = `usage: ub agents update <workflow@version|package-path> [--project <dir>]

Replace the selected project's adopted workflow with one validated version.
Locally edited managed files are refused rather than overwritten.

options:
  --project <dir>        select the Git project; defaults to the current project
  -h, --help             show this help
`;

export const AGENTS_UNINSTALL_HELP = `usage: ub agents uninstall [--project <dir>]

Remove unchanged resources owned by the selected project's adopted workflow.
Edited resources are left in place and reported with a recovery action.

options:
  --project <dir>        select the Git project; defaults to the current project
  -h, --help             show this help
`;

export const AGENTS_LIST_HELP = `usage: ub agents list [--project <dir>]

Report the selected project's adopted workflow, version, source, roles and
whether its managed resources still match the durable ownership record.

options:
  --project <dir>        select the Git project; defaults to the current project
  -h, --help             show this help
`;

export const WORKFLOW_OPTIONS = { project: { type: "string" } } as const;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

interface ManagedResource {
  path: string;
  mode: WorkflowMode;
  sha256: string;
}

interface WorkflowSourceRecord {
  kind: "local" | "published";
  repository: string;
  commit: string;
}

type WorkflowStatus =
  | { state: "complete" }
  | {
      state: "partial";
      operation: "install" | "update" | "uninstall";
      targetVersion?: string;
    };

interface WorkflowRecord {
  recordVersion: 1;
  workflow: string;
  version: string;
  source: WorkflowSourceRecord;
  digest: WorkflowManifest["digest"];
  resources: ManagedResource[];
  status: WorkflowStatus;
}

interface ReadRecord {
  record: WorkflowRecord;
  text: string;
}

type PathState =
  | { kind: "absent" }
  | { kind: "file"; content: Buffer; mode: number }
  | { kind: "refused"; reason: string };

export interface AdoptionHooks {
  /** Test seam for a process that stops between otherwise ordinary mutations. */
  beforeMutation?: (operation: "write" | "remove", path: string, index: number) => void;
}

function fail(message: string): never {
  throw new Error(message);
}

class UsageError extends Error {}

function errno(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code === undefined ? "" : ` (${code})`;
}

function exactKeys(value: object, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function contains(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Check each existing ancestor without following a symlink. Missing ancestors
 * are either reported as an absent target or created one segment at a time.
 */
function safeParent(root: string, relative: string, create: boolean): { path: string; missing: boolean } {
  const segments = checkedPayloadPath(relative).split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (!missing(error)) fail(`cannot inspect ${current}${errno(error)}`);
      if (!create) return { path: dirname(join(root, relative)), missing: true };
      try {
        mkdirSync(current, { mode: 0o755 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          fail(`cannot create ${current}${errno(mkdirError)}`);
        }
      }
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(`refusing ${relative}: ancestor ${current} is not an ordinary directory`);
    }
    const resolved = resolve(current);
    if (!contains(root, resolved)) fail(`refusing ${relative}: ancestor resolves outside ${root}`);
  }
  return { path: dirname(join(root, relative)), missing: false };
}

function stateOf(root: string, relative: string): PathState {
  const parent = safeParent(root, relative, false);
  if (parent.missing) return { kind: "absent" };
  const path = join(root, relative);
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (missing(error)) return { kind: "absent" };
    return { kind: "refused", reason: `it could not be inspected${errno(error)}` };
  }
  if (before.isSymbolicLink()) return { kind: "refused", reason: "it is a symbolic link" };
  if (!before.isFile()) return { kind: "refused", reason: "it is not a regular file" };
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return { kind: "refused", reason: `it could not be opened${errno(error)}` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { kind: "refused", reason: "it is not a regular file" };
    if (stat.dev !== before.dev || stat.ino !== before.ino) {
      return { kind: "refused", reason: "it changed while it was inspected" };
    }
    return { kind: "file", content: readFileSync(fd), mode: stat.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

function expected(entry: WorkflowPackageEntry): ManagedResource {
  return { path: entry.path, mode: entry.mode, sha256: contentDigest(entry.content) };
}

function matches(state: PathState, resource: ManagedResource): boolean {
  return (
    state.kind === "file" &&
    state.mode === fileMode(resource.mode) &&
    contentDigest(state.content) === resource.sha256
  );
}

function writeAll(fd: number, content: Buffer): void {
  let written = 0;
  while (written < content.length) {
    written += writeSync(fd, content, written, content.length - written);
  }
}

type ReplaceExpectation =
  | { kind: "absent" }
  | { kind: "resource"; resource: ManagedResource }
  | { kind: "content"; content: Buffer };

/** Publish bytes beside their target, at the package's exact recorded mode. */
function writeManaged(root: string, entry: WorkflowPackageEntry, expectation: ReplaceExpectation): void {
  const parent = safeParent(root, entry.path, true).path;
  const target = join(root, entry.path);
  const temporary = join(
    parent,
    `.${basename(entry.path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let fd: number | null = null;
  let closeAttempted = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    fchmodSync(fd, fileMode(entry.mode));
    writeAll(fd, entry.content);
    closeAttempted = true;
    closeSync(fd);
    fd = null;
    if (expectation.kind === "absent") {
      linkSync(temporary, target);
    } else {
      const current = stateOf(root, entry.path);
      const expectedCurrent =
        expectation.kind === "resource"
          ? matches(current, expectation.resource)
          : current.kind === "file" && current.content.equals(expectation.content);
      if (!expectedCurrent) {
        fail(`refusing to replace ${entry.path}: it changed before publication`);
      }
      renameSync(temporary, target);
      return;
    }
  } finally {
    if (fd !== null && !closeAttempted) {
      try {
        closeSync(fd);
      } catch {
        // The unlink below is the important cleanup after a failed close.
      }
    }
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (!missing(error)) process.stderr.write(`ub: warning: could not remove ${temporary}${errno(error)}\n`);
    }
  }
}

function removeManaged(root: string, resource: ManagedResource): void {
  const state = stateOf(root, resource.path);
  if (!matches(state, resource)) fail(`refusing to remove changed managed file ${resource.path}`);
  unlinkSync(join(root, resource.path));
}

function recordText(record: WorkflowRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function readRecord(root: string): ReadRecord | null {
  const state = stateOf(root, WORKFLOW_RECORD);
  if (state.kind === "absent") return null;
  if (state.kind === "refused") fail(`refusing to read ${WORKFLOW_RECORD}: ${state.reason}`);
  const text = state.content.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`${WORKFLOW_RECORD} is not valid JSON; repair or move it before changing workflows`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${WORKFLOW_RECORD} is not a valid ownership record`);
  }
  const value = parsed as Record<string, unknown>;
  if (
    !exactKeys(value, ["recordVersion", "workflow", "version", "source", "digest", "resources", "status"]) ||
    value.recordVersion !== 1 ||
    !Array.isArray(value.resources)
  ) {
    fail(`${WORKFLOW_RECORD} is not a valid version 1 ownership record`);
  }
  const workflow = checkedWorkflow(value.workflow);
  checkedVersion(value.version);
  const source = value.source;
  if (source === null || typeof source !== "object" || Array.isArray(source) || !exactKeys(source, ["kind", "repository", "commit"])) {
    fail(`${WORKFLOW_RECORD} has an invalid source record`);
  }
  const sourceValue = source as Record<string, unknown>;
  if (
    (sourceValue.kind !== "local" && sourceValue.kind !== "published") ||
    typeof sourceValue.repository !== "string" ||
    sourceValue.repository === "" ||
    typeof sourceValue.commit !== "string" ||
    !COMMIT.test(sourceValue.commit)
  ) {
    fail(`${WORKFLOW_RECORD} has an invalid source record`);
  }
  const digest = value.digest;
  if (
    digest === null ||
    typeof digest !== "object" ||
    Array.isArray(digest) ||
    !exactKeys(digest, ["algorithm", "framing", "payload"]) ||
    (digest as Record<string, unknown>).algorithm !== "sha256" ||
    (digest as Record<string, unknown>).framing !== DIGEST_FRAMING ||
    typeof (digest as Record<string, unknown>).payload !== "string" ||
    !SHA256.test((digest as Record<string, unknown>).payload as string)
  ) {
    fail(`${WORKFLOW_RECORD} has an invalid digest record`);
  }
  const resources: ManagedResource[] = [];
  const aliases = new Set<string>();
  let previous: string | null = null;
  for (const raw of value.resources) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !exactKeys(raw, ["path", "mode", "sha256"])) {
      fail(`${WORKFLOW_RECORD} has an invalid resource record`);
    }
    const item = raw as Record<string, unknown>;
    const path = checkedPayloadPath(item.path);
    if (path.toLowerCase() === WORKFLOW_RECORD.toLowerCase()) {
      fail(`${WORKFLOW_RECORD} cannot own itself`);
    }
    if (
      (item.mode !== "100644" && item.mode !== "100755") ||
      typeof item.sha256 !== "string" ||
      !SHA256.test(item.sha256)
    ) {
      fail(`${WORKFLOW_RECORD} has an invalid resource record for ${path}`);
    }
    const alias = path.toLowerCase();
    if (aliases.has(alias) || (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(path)) >= 0)) {
      fail(`${WORKFLOW_RECORD} resources are not sorted and unique at ${path}`);
    }
    aliases.add(alias);
    previous = path;
    resources.push({ path, mode: item.mode, sha256: item.sha256 });
  }
  const status = value.status;
  if (status === null || typeof status !== "object" || Array.isArray(status)) {
    fail(`${WORKFLOW_RECORD} has an invalid status`);
  }
  const statusValue = status as Record<string, unknown>;
  let checkedStatus: WorkflowStatus;
  if (statusValue.state === "complete" && exactKeys(statusValue, ["state"])) {
    if (resources.length === 0) fail(`${WORKFLOW_RECORD} complete status declares no resources`);
    checkedStatus = { state: "complete" };
  } else if (
    statusValue.state === "partial" &&
    (statusValue.operation === "install" || statusValue.operation === "update" || statusValue.operation === "uninstall") &&
    ((statusValue.operation === "update" && exactKeys(statusValue, ["state", "operation", "targetVersion"])) ||
      (statusValue.operation !== "update" && exactKeys(statusValue, ["state", "operation"])))
  ) {
    if (statusValue.operation === "update") checkedVersion(statusValue.targetVersion);
    checkedStatus = {
      state: "partial",
      operation: statusValue.operation,
      ...(statusValue.targetVersion === undefined ? {} : { targetVersion: statusValue.targetVersion as string }),
    };
  } else {
    fail(`${WORKFLOW_RECORD} has an invalid status`);
  }
  return {
    text,
    record: {
      recordVersion: 1,
      workflow,
      version: value.version as string,
      source: {
        kind: sourceValue.kind,
        repository: sourceValue.repository,
        commit: sourceValue.commit,
      } as WorkflowSourceRecord,
      digest: digest as WorkflowManifest["digest"],
      resources,
      status: checkedStatus,
    },
  };
}

function packageRecord(pkg: LoadedWorkflowPackage, status: WorkflowStatus = { state: "complete" }): WorkflowRecord {
  const resources = pkg.entries.map(expected).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  if (resources.some((resource) => resource.path.toLowerCase() === WORKFLOW_RECORD.toLowerCase())) {
    fail(`workflow package cannot manage its ownership record ${WORKFLOW_RECORD}`);
  }
  return {
    recordVersion: 1,
    workflow: pkg.manifest.workflow,
    version: pkg.manifest.version,
    source: { kind: pkg.sourceKind, ...pkg.manifest.source },
    digest: pkg.manifest.digest,
    resources,
    status,
  };
}

function writeRecord(root: string, record: WorkflowRecord, previous: string | null): void {
  const current = stateOf(root, WORKFLOW_RECORD);
  if (previous === null) {
    if (current.kind !== "absent") fail(`${WORKFLOW_RECORD} appeared while the workflow was being installed`);
    writeManaged(
      root,
      { path: WORKFLOW_RECORD, mode: "100644", content: Buffer.from(recordText(record), "utf8") },
      { kind: "absent" },
    );
    return;
  }
  if (current.kind !== "file" || current.content.toString("utf8") !== previous) {
    fail(`${WORKFLOW_RECORD} changed while the workflow operation was running`);
  }
  writeManaged(
    root,
    { path: WORKFLOW_RECORD, mode: "100644", content: Buffer.from(recordText(record), "utf8") },
    { kind: "content", content: Buffer.from(previous, "utf8") },
  );
}

function assertInstallable(root: string, record: WorkflowRecord): void {
  const ownership = stateOf(root, WORKFLOW_RECORD);
  if (ownership.kind !== "absent") {
    fail(`this project already has a workflow ownership record; run \`ub agents update\` or \`ub agents uninstall\``);
  }
  for (const resource of record.resources) {
    const state = stateOf(root, resource.path);
    if (state.kind !== "absent") {
      const reason = state.kind === "refused" ? state.reason : "a file already exists there";
      fail(`refusing to install ${resource.path}: ${reason}; move it aside and run the command again`);
    }
  }
}

function assertUpdatable(root: string, current: WorkflowRecord, next: WorkflowRecord): void {
  if (current.workflow !== next.workflow) {
    fail(`this project adopted ${current.workflow}; uninstall it before installing ${next.workflow}`);
  }
  const owned = new Map(current.resources.map((entry) => [entry.path, entry]));
  for (const resource of current.resources) {
    if (!matches(stateOf(root, resource.path), resource)) {
      fail(`refusing to update locally edited or missing managed file ${resource.path}; restore it or uninstall first`);
    }
  }
  for (const resource of next.resources) {
    if (!owned.has(resource.path) && stateOf(root, resource.path).kind !== "absent") {
      fail(`refusing to update onto foreign path ${resource.path}; move it aside and run the command again`);
    }
  }
}

function partialAfter(
  root: string,
  base: WorkflowRecord | null,
  target: WorkflowRecord,
  operation: "install" | "update",
): WorkflowRecord | null {
  const old = new Map((base?.resources ?? []).map((entry) => [entry.path, entry]));
  const next = new Map(target.resources.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...old.keys(), ...next.keys()])].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  const resources: ManagedResource[] = [];
  for (const path of paths) {
    const state = stateOf(root, path);
    const newResource = next.get(path);
    const oldResource = old.get(path);
    if (newResource !== undefined && matches(state, newResource)) resources.push(newResource);
    else if (oldResource !== undefined && state.kind !== "absent") resources.push(oldResource);
  }
  if (base === null && resources.length === 0) return null;
  const identity = base ?? target;
  return {
    ...identity,
    resources,
    status: {
      state: "partial",
      operation,
      ...(operation === "update" ? { targetVersion: target.version } : {}),
    },
  };
}

export function installWorkflow(root: string, pkg: LoadedWorkflowPackage, hooks: AdoptionHooks = {}): void {
  const record = packageRecord(pkg);
  assertInstallable(root, record);
  let mutations = 0;
  try {
    for (const entry of pkg.entries) {
      hooks.beforeMutation?.("write", entry.path, mutations++);
      if (stateOf(root, entry.path).kind !== "absent") {
        fail(`${entry.path} appeared while the workflow was being installed`);
      }
      writeManaged(root, entry, { kind: "absent" });
    }
    writeRecord(root, record, null);
  } catch (error) {
    const partial = partialAfter(root, null, record, "install");
    if (partial !== null) {
      try {
        writeRecord(root, partial, null);
      } catch (recordError) {
        fail(
          `${error instanceof Error ? error.message : String(error)}; ${WORKFLOW_RECORD} could not record the partial install: ${recordError instanceof Error ? recordError.message : String(recordError)}`,
        );
      }
      fail(
        `${error instanceof Error ? error.message : String(error)}; the partial install is recorded — run \`ub agents update <source>\` to finish or \`ub agents uninstall\` to undo it`,
      );
    }
    throw error;
  }
}

export function updateWorkflow(root: string, pkg: LoadedWorkflowPackage, hooks: AdoptionHooks = {}): void {
  const current = readRecord(root);
  if (current === null) fail("this project has adopted no workflow; run `ub agents install <source>` first");
  const next = packageRecord(pkg);
  assertUpdatable(root, current.record, next);
  const old = new Map(current.record.resources.map((entry) => [entry.path, entry]));
  const nextEntries = new Map(pkg.entries.map((entry) => [entry.path, entry]));
  let mutations = 0;
  let changed = false;
  try {
    for (const entry of pkg.entries) {
      const previous = old.get(entry.path);
      const intended = expected(entry);
      if (
        previous !== undefined &&
        previous.mode === intended.mode &&
        previous.sha256 === intended.sha256 &&
        matches(stateOf(root, entry.path), previous)
      ) {
        continue;
      }
      hooks.beforeMutation?.("write", entry.path, mutations++);
      const state = stateOf(root, entry.path);
      if (previous === undefined ? state.kind !== "absent" : !matches(state, previous)) {
        fail(`${entry.path} changed while the workflow was being updated`);
      }
      writeManaged(
        root,
        entry,
        previous === undefined ? { kind: "absent" } : { kind: "resource", resource: previous },
      );
      changed = true;
    }
    for (const resource of current.record.resources) {
      if (nextEntries.has(resource.path)) continue;
      hooks.beforeMutation?.("remove", resource.path, mutations++);
      removeManaged(root, resource);
      changed = true;
    }
    writeRecord(root, next, current.text);
  } catch (error) {
    if (changed) {
      const partial = partialAfter(root, current.record, next, "update");
      if (partial !== null) {
        try {
          writeRecord(root, partial, current.text);
        } catch (recordError) {
          fail(
            `${error instanceof Error ? error.message : String(error)}; ${WORKFLOW_RECORD} could not record the partial update: ${recordError instanceof Error ? recordError.message : String(recordError)}`,
          );
        }
      }
      fail(
        `${error instanceof Error ? error.message : String(error)}; the partial update is recorded — rerun \`ub agents update <source>\` or uninstall it`,
      );
    }
    throw error;
  }
}

export function uninstallWorkflow(root: string, hooks: AdoptionHooks = {}): { remaining: string[] } {
  const current = readRecord(root);
  if (current === null) fail("this project has adopted no workflow");
  const remaining: ManagedResource[] = [];
  let mutations = 0;
  for (const resource of current.record.resources) {
    const state = stateOf(root, resource.path);
    if (state.kind === "absent") continue;
    if (!matches(state, resource)) {
      remaining.push(resource);
      continue;
    }
    try {
      hooks.beforeMutation?.("remove", resource.path, mutations++);
      removeManaged(root, resource);
    } catch {
      remaining.push(resource);
    }
  }
  if (remaining.length > 0) {
    writeRecord(
      root,
      { ...current.record, resources: remaining, status: { state: "partial", operation: "uninstall" } },
      current.text,
    );
    return { remaining: remaining.map((entry) => entry.path) };
  }
  const recordState = stateOf(root, WORKFLOW_RECORD);
  if (recordState.kind !== "file" || recordState.content.toString("utf8") !== current.text) {
    fail(`${WORKFLOW_RECORD} changed while the workflow was being uninstalled`);
  }
  unlinkSync(join(root, WORKFLOW_RECORD));
  return { remaining: [] };
}

function rolesOf(record: WorkflowRecord): string[] {
  return record.resources
    .flatMap((resource) => resource.path.match(/^\.agents\/roles\/([a-z0-9-]+)\.md$/)?.[1] ?? [])
    .sort();
}

function driftOf(root: string, record: WorkflowRecord): string[] {
  return record.resources
    .filter((resource) => !matches(stateOf(root, resource.path), resource))
    .map((resource) => resource.path);
}

function parseCommand(
  argv: string[],
  help: string,
  source: "required" | "absent",
): { source?: string; project?: string } | { help: true } {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const parsed = (() => {
    try {
      return parseArgs({ args: argv, options: WORKFLOW_OPTIONS, allowPositionals: true, strict: true });
    } catch (error) {
      throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n\n${help}`);
    }
  })();
  if (source === "required" && parsed.positionals.length !== 1) {
    throw new UsageError(`expected exactly one <workflow@version|package-path>\n\n${help}`);
  }
  if (source === "absent" && parsed.positionals.length !== 0) {
    throw new UsageError(`expected no positional arguments\n\n${help}`);
  }
  const supplied = parsed.positionals[0];
  if (source === "required" && supplied !== undefined) {
    if (supplied === "") {
      throw new UsageError(`the workflow source cannot be empty\n\n${help}`);
    }
    if (!supplied.includes("/") && supplied.includes("@") && !/^[a-z0-9][a-z0-9-]*@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(supplied)) {
      throw new UsageError(`a published source must be workflow@MAJOR.MINOR.PATCH\n\n${help}`);
    }
  }
  return {
    ...(supplied === undefined ? {} : { source: supplied }),
    ...(parsed.values.project === undefined ? {} : { project: parsed.values.project }),
  };
}

function projectRoot(selected: string | undefined): string {
  const resolved = resolveProjectRoot(selected, process.cwd(), process.env);
  if (resolved.error !== undefined) fail(resolved.error);
  return resolved.project.root;
}

export async function workflowCommand(
  command: "install" | "update" | "uninstall" | "list",
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  const help = {
    install: AGENTS_INSTALL_HELP,
    update: AGENTS_UPDATE_HELP,
    uninstall: AGENTS_UNINSTALL_HELP,
    list: AGENTS_LIST_HELP,
  }[command];
  try {
    const parsed = parseCommand(argv, help, command === "install" || command === "update" ? "required" : "absent");
    if ("help" in parsed) {
      io.out(help);
      return 0;
    }
    const root = projectRoot(parsed.project);
    if (command === "list") {
      const current = readRecord(root);
      if (current === null) {
        io.out(`No agent workflow is adopted in ${root}.\n`);
        return 0;
      }
      const drift = driftOf(root, current.record);
      const roles = rolesOf(current.record);
      io.out(`${current.record.workflow} ${current.record.version}\n`);
      io.out(
        `source: ${current.record.source.kind} ${current.record.source.repository}@${current.record.source.commit}\n`,
      );
      io.out(`roles: ${roles.length === 0 ? "none" : roles.join(", ")}\n`);
      const status =
        current.record.status.state === "complete"
          ? "installed"
          : `partial ${current.record.status.operation}${current.record.status.targetVersion === undefined ? "" : ` to ${current.record.status.targetVersion}`}`;
      io.out(`state: ${status}; ${current.record.resources.length} managed resources\n`);
      if (drift.length > 0) io.out(`changed or missing: ${drift.join(", ")}\n`);
      return 0;
    }
    if (command === "uninstall") {
      const result = uninstallWorkflow(root);
      if (result.remaining.length > 0) {
        io.err(
          `ub agents uninstall: kept changed or unremovable resources: ${result.remaining.join(", ")}. ` +
            "Restore or move them, then run `ub agents uninstall` again.\n",
        );
        return 1;
      }
      io.out(`Uninstalled the adopted workflow from ${root}.\n`);
      return 0;
    }
    const pkg = await loadWorkflowPackage(parsed.source as string, process.cwd());
    if (command === "install") installWorkflow(root, pkg);
    else updateWorkflow(root, pkg);
    io.out(
      `${command === "install" ? "Installed" : "Updated"} ${pkg.manifest.workflow}@${pkg.manifest.version} ` +
        `from ${pkg.sourceKind} source in ${root} (${pkg.entries.length} resources).\n`,
    );
    return 0;
  } catch (error) {
    io.err(`ub agents ${command}: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
