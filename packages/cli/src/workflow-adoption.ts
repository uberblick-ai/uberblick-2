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
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { type Io, processIo } from "./io.js";
import { readLaunchData } from "./launch.js";
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
const CONCURRENT_RELOCATION_LIMIT =
  "Path checks stop symlink redirection, but do not sandbox another same-user process that deliberately relocates an already-open directory during the operation.";

export const AGENTS_INSTALL_HELP = `usage: ub agents install <workflow@version|package-path> [--project <dir>]

Adopt one validated workflow in the selected Git project. A local source is an
extracted package directory or a .tar.gz package; a published source is an exact
workflow@MAJOR.MINOR.PATCH name. The command starts no agent and commits nothing.
Published packages are downloaded without authentication from the GitHub release
for that exact version in uberblick-ai/homebrew-tap.
${CONCURRENT_RELOCATION_LIMIT}

options:
  --project <dir>        select the Git project; defaults to the current project
  -h, --help             show this help
`;

export const AGENTS_UPDATE_HELP = `usage: ub agents update <workflow@version|package-path> [--project <dir>]

Replace the selected project's adopted workflow with one validated version.
Locally edited managed files are refused rather than overwritten.
Published packages are downloaded without authentication from the GitHub release
for that exact version in uberblick-ai/homebrew-tap.
${CONCURRENT_RELOCATION_LIMIT}

options:
  --project <dir>        select the Git project; defaults to the current project
  -h, --help             show this help
`;

export const AGENTS_UNINSTALL_HELP = `usage: ub agents uninstall [--project <dir>]

Remove unchanged resources owned by the selected project's adopted workflow.
Edited resources are left in place and reported with a recovery action.
${CONCURRENT_RELOCATION_LIMIT}

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
      operation: "install" | "uninstall";
      targetVersion?: undefined;
      previousResources?: undefined;
    }
  | {
      state: "partial";
      operation: "update";
      targetVersion: string;
      previousResources: ManagedResource[];
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

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Check each existing ancestor without following a symlink. Missing ancestors
 * are either reported as an absent target or created one segment at a time.
 */
interface StableParent {
  path: string;
  missing: boolean;
  dev?: number;
  ino?: number;
}

function safeParent(root: string, relative: string, create: boolean): StableParent {
  const segments = checkedPayloadPath(relative).split("/");
  let current = root;
  let parentStat: ReturnType<typeof lstatSync>;
  try {
    parentStat = lstatSync(current);
  } catch (error) {
    fail(`cannot inspect ${current}${errno(error)}`);
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    fail(`refusing ${relative}: ancestor ${current} is not an ordinary directory`);
  }
  for (const segment of segments.slice(0, -1)) {
    const child = join(current, segment);
    const parent: StableParent = {
      path: current,
      missing: false,
      dev: parentStat.dev,
      ino: parentStat.ino,
    };
    const stat = inStableDirectory(parent, relative, () => {
      try {
        return lstatSync(segment);
      } catch (error) {
        if (!missing(error)) fail(`cannot inspect ${child}${errno(error)}`);
        if (!create) return null;
        try {
          mkdirSync(segment, { mode: 0o755 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
            fail(`cannot create ${child}${errno(mkdirError)}`);
          }
        }
        return lstatSync(segment);
      }
    });
    if (stat === null) return { path: dirname(join(root, relative)), missing: true };
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(`refusing ${relative}: ancestor ${child} is not an ordinary directory`);
    }
    current = child;
    parentStat = stat;
  }
  return { path: dirname(join(root, relative)), missing: false, dev: parentStat.dev, ino: parentStat.ino };
}

/**
 * Hold the inspected parent as the process working directory for one
 * synchronous mutation. Replacing its pathname afterwards cannot redirect a
 * relative open, link, rename or unlink through a new ancestor.
 */
function inStableDirectory<T>(parent: StableParent, relative: string, action: () => T): T {
  if (parent.missing || parent.dev === undefined || parent.ino === undefined) {
    fail(`cannot enter the missing parent of ${relative}`);
  }
  const previous = process.cwd();
  try {
    process.chdir(parent.path);
    const held = lstatSync(".");
    if (!held.isDirectory() || held.dev !== parent.dev || held.ino !== parent.ino) {
      fail(`refusing ${relative}: its parent changed before the filesystem operation`);
    }
    return action();
  } finally {
    process.chdir(previous);
  }
}

function inStableParent<T>(parent: StableParent, relative: string, action: (name: string) => T): T {
  return inStableDirectory(parent, relative, () => action(basename(relative)));
}

function stateAt(name: string): PathState {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(name);
  } catch (error) {
    if (missing(error)) return { kind: "absent" };
    return { kind: "refused", reason: `it could not be inspected${errno(error)}` };
  }
  if (before.isSymbolicLink()) return { kind: "refused", reason: "it is a symbolic link" };
  if (!before.isFile()) return { kind: "refused", reason: "it is not a regular file" };
  let fd: number;
  try {
    fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW);
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

function stateOf(root: string, relative: string): PathState {
  let parent: StableParent;
  try {
    parent = safeParent(root, relative, false);
  } catch (error) {
    return { kind: "refused", reason: error instanceof Error ? error.message : String(error) };
  }
  if (parent.missing) return { kind: "absent" };
  try {
    return inStableParent(parent, relative, stateAt);
  } catch (error) {
    return { kind: "refused", reason: error instanceof Error ? error.message : String(error) };
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
function writeManaged(root: string, entry: WorkflowPackageEntry, expectation: ReplaceExpectation): StableParent {
  const parent = safeParent(root, entry.path, true);
  inStableParent(parent, entry.path, (target) => {
    const temporary = `.${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
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
        const current = stateAt(target);
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
        if (!missing(error)) {
          process.stderr.write(`ub: warning: could not remove ${join(parent.path, temporary)}${errno(error)}\n`);
        }
      }
    }
  });
  return parent;
}

function removeManaged(root: string, resource: ManagedResource): StableParent {
  const parent = safeParent(root, resource.path, false);
  if (parent.missing) fail(`refusing to remove changed managed file ${resource.path}`);
  inStableParent(parent, resource.path, (target) => {
    const state = stateAt(target);
    if (!matches(state, resource)) fail(`refusing to remove changed managed file ${resource.path}`);
    unlinkSync(target);
  });
  return parent;
}

function assertCompletionState(
  root: string,
  resources: ManagedResource[],
  absentPaths: string[],
  mutatedParents: StableParent[],
): void {
  for (const resource of resources) {
    const state = stateOf(root, resource.path);
    if (!matches(state, resource)) {
      fail(`refusing to complete the workflow operation: ${resource.path} is not intact at its project path`);
    }
  }
  for (const path of absentPaths) {
    if (stateOf(root, path).kind !== "absent") {
      fail(`refusing to complete the workflow operation: removed resource ${path} is present at its project path`);
    }
  }
  const checked = new Set<string>();
  for (const parent of mutatedParents) {
    const identity = `${parent.path}\0${parent.dev}\0${parent.ino}`;
    if (checked.has(identity)) continue;
    checked.add(identity);
    try {
      const current = lstatSync(parent.path);
      if (
        parent.missing ||
        parent.dev === undefined ||
        parent.ino === undefined ||
        !current.isDirectory() ||
        current.dev !== parent.dev ||
        current.ino !== parent.ino
      ) {
        fail(`mutation directory ${parent.path} is no longer reachable at its inspected project path`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("mutation directory ")) throw error;
      fail(`mutation directory ${parent.path} is no longer reachable at its inspected project path${errno(error)}`);
    }
  }
}

function recordText(record: WorkflowRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function checkedResources(rawResources: unknown): ManagedResource[] {
  if (!Array.isArray(rawResources)) fail(`${WORKFLOW_RECORD} is not a valid version 1 ownership record`);
  const resources: ManagedResource[] = [];
  const aliases = new Set<string>();
  let previous: string | null = null;
  for (const raw of rawResources) {
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
  return resources;
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
    value.recordVersion !== 1
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
  const resources = checkedResources(value.resources);
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
    ((statusValue.operation === "update" &&
      exactKeys(statusValue, ["state", "operation", "targetVersion", "previousResources"])) ||
      (statusValue.operation !== "update" && exactKeys(statusValue, ["state", "operation"])))
  ) {
    if (statusValue.operation === "update") {
      checkedVersion(statusValue.targetVersion);
      checkedStatus = {
        state: "partial",
        operation: "update",
        targetVersion: statusValue.targetVersion as string,
        previousResources: checkedResources(statusValue.previousResources),
      };
    } else {
      checkedStatus = { state: "partial", operation: statusValue.operation };
    }
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

function writeRecord(root: string, record: WorkflowRecord, previous: string | null): StableParent {
  const current = stateOf(root, WORKFLOW_RECORD);
  if (previous === null) {
    if (current.kind !== "absent") fail(`${WORKFLOW_RECORD} appeared while the workflow was being installed`);
    return writeManaged(
      root,
      { path: WORKFLOW_RECORD, mode: "100644", content: Buffer.from(recordText(record), "utf8") },
      { kind: "absent" },
    );
  }
  if (current.kind !== "file" || current.content.toString("utf8") !== previous) {
    fail(`${WORKFLOW_RECORD} changed while the workflow operation was running`);
  }
  return writeManaged(
    root,
    { path: WORKFLOW_RECORD, mode: "100644", content: Buffer.from(recordText(record), "utf8") },
    { kind: "content", content: Buffer.from(previous, "utf8") },
  );
}

function assertInstallable(root: string, record: WorkflowRecord): void {
  const ownership = stateOf(root, WORKFLOW_RECORD);
  if (ownership.kind !== "absent") {
    if (ownership.kind === "refused") {
      fail(`refusing to install: ${WORKFLOW_RECORD} ${ownership.reason}`);
    }
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

function sameResource(left: ManagedResource, right: ManagedResource): boolean {
  return left.path === right.path && left.mode === right.mode && left.sha256 === right.sha256;
}

function sameTarget(current: WorkflowRecord, next: WorkflowRecord): boolean {
  return (
    current.workflow === next.workflow &&
    current.version === next.version &&
    current.source.kind === next.source.kind &&
    current.source.repository === next.source.repository &&
    current.source.commit === next.source.commit &&
    current.digest.algorithm === next.digest.algorithm &&
    current.digest.framing === next.digest.framing &&
    current.digest.payload === next.digest.payload &&
    current.resources.length === next.resources.length &&
    current.resources.every((resource, index) => sameResource(resource, next.resources[index] as ManagedResource))
  );
}

function assertRecoverableUpdate(
  root: string,
  previousResources: ManagedResource[],
  next: WorkflowRecord,
  allowMissingTarget: boolean,
): void {
  const previous = new Map(previousResources.map((resource) => [resource.path, resource]));
  const target = new Map(next.resources.map((resource) => [resource.path, resource]));
  const paths = [...new Set([...previous.keys(), ...target.keys()])];
  for (const path of paths) {
    const state = stateOf(root, path);
    const oldResource = previous.get(path);
    const nextResource = target.get(path);
    if (nextResource !== undefined && matches(state, nextResource)) continue;
    if (oldResource !== undefined && matches(state, oldResource)) continue;
    if (
      state.kind === "absent" &&
      (allowMissingTarget || oldResource === undefined || nextResource === undefined)
    ) {
      continue;
    }
    fail(`refusing to recover the partial update because ${path} changed; restore it or uninstall first`);
  }
}

export function installWorkflow(root: string, pkg: LoadedWorkflowPackage, hooks: AdoptionHooks = {}): void {
  const record = packageRecord(pkg);
  assertInstallable(root, record);
  const pending: WorkflowRecord = { ...record, status: { state: "partial", operation: "install" } };
  const pendingText = recordText(pending);
  const mutatedParents = [writeRecord(root, pending, null)];
  let mutations = 0;
  try {
    for (const entry of pkg.entries) {
      hooks.beforeMutation?.("write", entry.path, mutations++);
      const state = stateOf(root, entry.path);
      if (state.kind === "refused") {
        fail(
          state.reason.startsWith("refusing ")
            ? state.reason
            : `refusing to install ${entry.path}: ${state.reason}`,
        );
      }
      if (state.kind !== "absent") {
        fail(`${entry.path} appeared while the workflow was being installed`);
      }
      mutatedParents.push(writeManaged(root, entry, { kind: "absent" }));
    }
    assertCompletionState(root, record.resources, [], mutatedParents);
    writeRecord(root, record, pendingText);
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}; the partial install is recorded — run \`ub agents update <source>\` to finish or \`ub agents uninstall\` to undo it`,
    );
  }
}

export function updateWorkflow(root: string, pkg: LoadedWorkflowPackage, hooks: AdoptionHooks = {}): void {
  const current = readRecord(root);
  if (current === null) fail("this project has adopted no workflow; run `ub agents install <source>` first");
  const next = packageRecord(pkg);
  let previousResources: ManagedResource[];
  if (current.record.status.state === "complete") {
    assertUpdatable(root, current.record, next);
    previousResources = current.record.resources;
  } else if (current.record.status.operation === "install") {
    if (!sameTarget(current.record, next)) {
      fail("finish the recorded partial install with its original source, or run `ub agents uninstall`");
    }
    previousResources = [];
    assertRecoverableUpdate(root, previousResources, next, true);
  } else if (current.record.status.operation === "update") {
    if (!sameTarget(current.record, next)) {
      fail(
        `finish the recorded partial update to ${current.record.status.targetVersion} with its original source, or run \`ub agents uninstall\``,
      );
    }
    previousResources = current.record.status.previousResources;
    assertRecoverableUpdate(root, previousResources, next, false);
  } else {
    fail("this workflow is partially uninstalled; run `ub agents uninstall` again before updating it");
  }
  const pending: WorkflowRecord = {
    ...next,
    status: {
      state: "partial",
      operation: "update",
      targetVersion: next.version,
      previousResources,
    },
  };
  const pendingText = recordText(pending);
  const mutatedParents: StableParent[] = [];
  if (current.text !== pendingText) mutatedParents.push(writeRecord(root, pending, current.text));
  const old = new Map(previousResources.map((entry) => [entry.path, entry]));
  const nextEntries = new Map(pkg.entries.map((entry) => [entry.path, entry]));
  let mutations = 0;
  try {
    for (const entry of pkg.entries) {
      const previous = old.get(entry.path);
      const intended = expected(entry);
      const state = stateOf(root, entry.path);
      if (matches(state, intended)) continue;
      if (previous === undefined ? state.kind !== "absent" : !matches(state, previous)) {
        fail(`${entry.path} changed while the workflow was being updated`);
      }
      hooks.beforeMutation?.("write", entry.path, mutations++);
      mutatedParents.push(
        writeManaged(
          root,
          entry,
          previous === undefined ? { kind: "absent" } : { kind: "resource", resource: previous },
        ),
      );
    }
    for (const resource of previousResources) {
      if (nextEntries.has(resource.path)) continue;
      const state = stateOf(root, resource.path);
      if (state.kind === "absent") continue;
      if (!matches(state, resource)) fail(`${resource.path} changed while the workflow was being updated`);
      hooks.beforeMutation?.("remove", resource.path, mutations++);
      mutatedParents.push(removeManaged(root, resource));
    }
    assertCompletionState(
      root,
      next.resources,
      previousResources.filter((resource) => !nextEntries.has(resource.path)).map((resource) => resource.path),
      mutatedParents,
    );
    writeRecord(root, next, pendingText);
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}; the partial update is recorded — rerun \`ub agents update <source>\` or uninstall it`,
    );
  }
}

function resourcesForUninstall(root: string, record: WorkflowRecord): ManagedResource[] {
  const target = new Map(record.resources.map((resource) => [resource.path, resource]));
  const previous =
    record.status.state === "partial" && record.status.operation === "update"
      ? new Map(record.status.previousResources.map((resource) => [resource.path, resource]))
      : new Map<string, ManagedResource>();
  const paths = [...new Set([...target.keys(), ...previous.keys()])].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  const resources: ManagedResource[] = [];
  for (const path of paths) {
    const state = stateOf(root, path);
    if (state.kind === "absent") continue;
    const targetResource = target.get(path);
    const previousResource = previous.get(path);
    if (targetResource !== undefined && matches(state, targetResource)) resources.push(targetResource);
    else if (previousResource !== undefined && matches(state, previousResource)) resources.push(previousResource);
    else resources.push(targetResource ?? (previousResource as ManagedResource));
  }
  return resources;
}

function removeRecord(root: string, expectedText: string): void {
  const parent = safeParent(root, WORKFLOW_RECORD, false);
  if (parent.missing) fail(`${WORKFLOW_RECORD} changed while the workflow was being uninstalled`);
  inStableParent(parent, WORKFLOW_RECORD, (target) => {
    const state = stateAt(target);
    if (state.kind !== "file" || state.content.toString("utf8") !== expectedText) {
      fail(`${WORKFLOW_RECORD} changed while the workflow was being uninstalled`);
    }
    unlinkSync(target);
  });
}

export function uninstallWorkflow(root: string, hooks: AdoptionHooks = {}): { remaining: string[] } {
  const current = readRecord(root);
  if (current === null) fail("this project has adopted no workflow");
  const pending: WorkflowRecord = {
    ...current.record,
    resources: resourcesForUninstall(root, current.record),
    status: { state: "partial", operation: "uninstall" },
  };
  const pendingText = recordText(pending);
  const mutatedParents = [writeRecord(root, pending, current.text)];
  const remaining: ManagedResource[] = [];
  let mutations = 0;
  for (const resource of pending.resources) {
    const state = stateOf(root, resource.path);
    if (state.kind === "absent") continue;
    if (!matches(state, resource)) {
      remaining.push(resource);
      continue;
    }
    try {
      hooks.beforeMutation?.("remove", resource.path, mutations++);
      mutatedParents.push(removeManaged(root, resource));
    } catch {
      remaining.push(resource);
    }
  }
  if (remaining.length > 0) {
    const remainingRecord: WorkflowRecord = { ...pending, resources: remaining };
    writeRecord(
      root,
      remainingRecord,
      pendingText,
    );
    return { remaining: remaining.map((entry) => entry.path) };
  }
  try {
    assertCompletionState(
      root,
      [],
      pending.resources.map((resource) => resource.path),
      mutatedParents,
    );
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}; the partial uninstall is recorded — restore or move any changed resources, then run \`ub agents uninstall\` again`,
    );
  }
  removeRecord(root, pendingText);
  return { remaining: [] };
}

function rolesOf(root: string): string[] | "missing" | null {
  try {
    return Object.keys(readLaunchData(root).entryRoles).sort();
  } catch {
    try {
      lstatSync(join(root, ".agents/launch.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    }
    return null;
  }
}

function driftOf(root: string, record: WorkflowRecord): string[] {
  const drift = record.resources
    .filter((resource) => !matches(stateOf(root, resource.path), resource))
    .map((resource) => resource.path);
  if (record.status.state === "partial" && record.status.operation === "update") {
    const targetPaths = new Set(record.resources.map((resource) => resource.path));
    for (const resource of record.status.previousResources) {
      if (!targetPaths.has(resource.path) && stateOf(root, resource.path).kind !== "absent") {
        drift.push(resource.path);
      }
    }
  }
  return [...new Set(drift)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function previousVersionResources(root: string, record: WorkflowRecord): string[] {
  if (record.status.state !== "partial" || record.status.operation !== "update") return [];
  const target = new Map(record.resources.map((resource) => [resource.path, resource]));
  return record.status.previousResources
    .filter((resource) => {
      const targetResource = target.get(resource.path);
      return (
        matches(stateOf(root, resource.path), resource) &&
        (targetResource === undefined || !sameResource(resource, targetResource))
      );
    })
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
      const previousResources = previousVersionResources(root, current.record);
      const roles = rolesOf(root);
      const roleSummary =
        roles === "missing"
          ? "unavailable; .agents/launch.json is missing; add the project's launch declaration before launching"
          : roles === null
            ? "unavailable; repair .agents/launch.json or its declared role files before launching"
            : roles.join(", ");
      io.out(`${current.record.workflow} ${current.record.version}\n`);
      io.out(
        `source: ${current.record.source.kind} ${current.record.source.repository}@${current.record.source.commit}\n`,
      );
      io.out(
        `roles: ${roleSummary}\n`,
      );
      const status =
        current.record.status.state === "complete"
          ? "installed"
          : `partial ${current.record.status.operation}${current.record.status.targetVersion === undefined ? "" : ` to ${current.record.status.targetVersion}`}`;
      io.out(`state: ${status}; ${current.record.resources.length} managed resources\n`);
      if (drift.length > 0) io.out(`changed or missing: ${drift.join(", ")}\n`);
      if (previousResources.length > 0) {
        io.out(`still at the previous version: ${previousResources.join(", ")}\n`);
      }
      if (current.record.status.state === "partial") {
        const nextAction =
          current.record.status.operation === "uninstall"
            ? "restore or move any changed resources, then run `ub agents uninstall` again"
            : "rerun `ub agents update <source>` with the recorded source to finish, or run `ub agents uninstall` to undo it";
        io.out(`next action: ${nextAction}\n`);
      }
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
