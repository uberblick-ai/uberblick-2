/**
 * Machine-owned storage for validated agent workflows and project selections.
 *
 * Installation bytes are content addressed beneath the user's data root. A
 * project selection is a small atomic record beneath the user's config root.
 * Selection changes use a write-ahead `pending` value while retaining the old
 * `selected` value, so an interruption can be reported without ever pretending
 * the new workflow became effective.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createDataDirectory, resolveStorage } from "@uberblick/hub/storage";
import {
  DIGEST_FRAMING,
  fileMode,
  readExtractedWorkflowPackage,
  type LoadedWorkflowPackage,
  type WorkflowManifest,
} from "./workflow-package.js";

const RECORD_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export interface StoredWorkflow {
  workflow: string;
  version: string;
  source: {
    kind: "local" | "published";
    repository: string;
    commit: string;
  };
  digest: WorkflowManifest["digest"];
  installation: string;
}

interface PendingSelection {
  operation: "select";
  target: StoredWorkflow;
  stage: string;
}

export interface WorkflowSelectionRecord {
  recordVersion: 1;
  project: string;
  selected: StoredWorkflow | null;
  pending: PendingSelection | null;
}

export interface SelectionInspection {
  path: string;
  record: WorkflowSelectionRecord | null;
  selectedProblem: string | null;
  pendingProblem: string | null;
}

export interface WorkflowStorageHooks {
  /** Test seam for interruption between durable mutations. */
  beforeMutation?: (operation: "write" | "rename" | "remove" | "sync", path: string) => void;
}

function fail(message: string): never {
  throw new Error(message);
}

function exactKeys(value: object, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function projectKey(project: string): string {
  return createHash("sha256").update(project, "utf8").digest("hex");
}

export function workflowSelectionPath(project: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveStorage({ env }).workflowSelectionsDir, `${projectKey(project)}.json`);
}

function installationPath(
  workflow: string,
  version: string,
  repository: string,
  commit: string,
  digest: string,
  env: NodeJS.ProcessEnv,
): string {
  // Payload bytes alone do not identify a package: the verified manifest also
  // owns its source commit. Hash the complete identity so two producers with
  // coincidentally equal payloads cannot replace one another's manifest.
  const identity = createHash("sha256")
    .update(JSON.stringify({ workflow, version, repository, commit, digest }), "utf8")
    .digest("hex");
  return join(resolveStorage({ env }).workflowInstallationsDir, workflow, version, identity);
}

function stagePath(project: string, target: StoredWorkflow, env: NodeJS.ProcessEnv): string {
  return join(
    resolveStorage({ env }).workflowInstallationsDir,
    ".staging",
    `${projectKey(project)}-${target.digest.payload}`,
  );
}

function refFor(pkg: LoadedWorkflowPackage, env: NodeJS.ProcessEnv): StoredWorkflow {
  return {
    workflow: pkg.manifest.workflow,
    version: pkg.manifest.version,
    source: { kind: pkg.sourceKind, ...pkg.manifest.source },
    digest: { ...pkg.manifest.digest },
    installation: installationPath(
      pkg.manifest.workflow,
      pkg.manifest.version,
      pkg.manifest.source.repository,
      pkg.manifest.source.commit,
      pkg.manifest.digest.payload,
      env,
    ),
  };
}

function parseRef(value: unknown, env: NodeJS.ProcessEnv): StoredWorkflow {
  const item = record(value);
  const source = record(item?.source);
  const digest = record(item?.digest);
  if (
    item === null ||
    !exactKeys(item, ["workflow", "version", "source", "digest", "installation"]) ||
    typeof item.workflow !== "string" ||
    !/^[a-z0-9][a-z0-9-]*$/.test(item.workflow) ||
    typeof item.version !== "string" ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(item.version) ||
    source === null ||
    !exactKeys(source, ["kind", "repository", "commit"]) ||
    (source.kind !== "local" && source.kind !== "published") ||
    typeof source.repository !== "string" ||
    source.repository === "" ||
    typeof source.commit !== "string" ||
    !COMMIT.test(source.commit) ||
    digest === null ||
    !exactKeys(digest, ["algorithm", "framing", "payload"]) ||
    digest.algorithm !== "sha256" ||
    digest.framing !== DIGEST_FRAMING ||
    typeof digest.payload !== "string" ||
    !SHA256.test(digest.payload) ||
    typeof item.installation !== "string"
  ) {
    fail("workflow selection contains a malformed installation reference");
  }
  const expected = installationPath(
    item.workflow,
    item.version,
    source.repository,
    source.commit,
    digest.payload,
    env,
  );
  if (item.installation !== expected) {
    fail(`workflow selection names installation ${item.installation}, but its manifest identity resolves to ${expected}`);
  }
  return {
    workflow: item.workflow,
    version: item.version,
    source: {
      kind: source.kind,
      repository: source.repository,
      commit: source.commit,
    },
    digest: {
      algorithm: "sha256",
      framing: DIGEST_FRAMING,
      payload: digest.payload,
    },
    installation: item.installation,
  };
}

function readSelection(project: string, env: NodeJS.ProcessEnv): WorkflowSelectionRecord | null {
  const path = workflowSelectionPath(project, env);
  let text: string;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) fail(`${path} is not an ordinary selection record`);
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`${path} is not valid JSON; move it aside and run \`ub agents install <source>\` again`);
  }
  const top = record(parsed);
  if (
    top === null ||
    !exactKeys(top, ["recordVersion", "project", "selected", "pending"]) ||
    top.recordVersion !== RECORD_VERSION ||
    top.project !== project
  ) {
    fail(`${path} is not the version ${RECORD_VERSION} selection record for ${project}`);
  }
  const selected = top.selected === null ? null : parseRef(top.selected, env);
  let pending: PendingSelection | null = null;
  if (top.pending !== null) {
    const rawPending = record(top.pending);
    if (
      rawPending === null ||
      !exactKeys(rawPending, ["operation", "target", "stage"]) ||
      rawPending.operation !== "select" ||
      typeof rawPending.stage !== "string"
    ) {
      fail(`${path} contains a malformed pending selection`);
    }
    const target = parseRef(rawPending.target, env);
    const expectedStage = stagePath(project, target, env);
    if (rawPending.stage !== expectedStage) {
      fail(`${path} names pending storage ${rawPending.stage}, but ${expectedStage} is required`);
    }
    pending = { operation: "select", target, stage: rawPending.stage };
  }
  if (selected === null && pending === null) fail(`${path} records neither a selected nor pending workflow`);
  return { recordVersion: 1, project, selected, pending };
}

function syncDirectory(path: string): void {
  const handle = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function durableFile(path: string, content: string | Buffer, mode: number): void {
  writeFileSync(path, content, { mode, flag: "wx" });
  chmodSync(path, mode);
  const handle = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function syncTreeDirectories(root: string): void {
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (item.isDirectory()) syncTreeDirectories(join(root, item.name));
  }
  syncDirectory(root);
}

function atomicRecordWrite(
  path: string,
  value: WorkflowSelectionRecord,
  hooks: WorkflowStorageHooks,
): void {
  const parent = dirname(path);
  createDataDirectory(parent);
  hooks.beforeMutation?.("write", path);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let handle: number | null = null;
  try {
    handle = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    let written = 0;
    while (written < content.length) {
      written += writeSync(handle, content, written, content.length - written);
    }
    fsyncSync(handle);
    closeSync(handle);
    handle = null;
    renameSync(temporary, path);
    hooks.beforeMutation?.("sync", parent);
    syncDirectory(parent);
  } catch (error) {
    if (handle !== null) closeSync(handle);
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary either never existed or was already renamed.
    }
    throw error;
  }
}

function sameRef(left: StoredWorkflow, right: StoredWorkflow): boolean {
  return (
    left.workflow === right.workflow &&
    left.version === right.version &&
    left.source.kind === right.source.kind &&
    left.source.repository === right.source.repository &&
    left.source.commit === right.source.commit &&
    left.digest.algorithm === right.digest.algorithm &&
    left.digest.framing === right.digest.framing &&
    left.digest.payload === right.digest.payload &&
    left.installation === right.installation
  );
}

function installationProblem(target: StoredWorkflow): string | null {
  try {
    const loaded = readExtractedWorkflowPackage(target.installation);
    if (
      loaded.manifest.workflow !== target.workflow ||
      loaded.manifest.version !== target.version ||
      loaded.manifest.source.repository !== target.source.repository ||
      loaded.manifest.source.commit !== target.source.commit ||
      loaded.manifest.digest.algorithm !== target.digest.algorithm ||
      loaded.manifest.digest.framing !== target.digest.framing ||
      loaded.manifest.digest.payload !== target.digest.payload
    ) {
      return "the stored manifest does not match the project selection";
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function inspectWorkflowSelection(
  project: string,
  env: NodeJS.ProcessEnv = process.env,
): SelectionInspection {
  const path = workflowSelectionPath(project, env);
  const record = readSelection(project, env);
  return {
    path,
    record,
    selectedProblem: record?.selected === null || record?.selected === undefined
      ? null
      : installationProblem(record.selected),
    pendingProblem: record?.pending === null || record?.pending === undefined
      ? null
      : installationProblem(record.pending.target),
  };
}

/** Resolve and re-verify the effective selection. Null means use the legacy project tree. */
export function resolveSelectedWorkflow(
  project: string,
  env: NodeJS.ProcessEnv = process.env,
): { root: string; selection: StoredWorkflow } | null {
  const inspected = inspectWorkflowSelection(project, env);
  const selected = inspected.record?.selected;
  if (selected === undefined || selected === null) {
    return null;
  }
  if (inspected.selectedProblem !== null) {
    fail(
      `stored workflow installation ${selected.installation} is missing or changed ` +
        `(${inspected.selectedProblem}); run \`ub agents install <source>\` to repair it or ` +
        "`ub agents uninstall` to remove this project's selection",
    );
  }
  return { root: join(selected.installation, "payload"), selection: selected };
}

function writeStage(
  stage: string,
  pkg: LoadedWorkflowPackage,
  hooks: WorkflowStorageHooks,
): void {
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "payload"), { recursive: true, mode: 0o700 });
  const manifest = join(stage, "manifest.json");
  hooks.beforeMutation?.("write", manifest);
  durableFile(manifest, `${JSON.stringify(pkg.manifest, null, 2)}\n`, 0o600);
  for (const entry of pkg.entries) {
    const path = join(stage, "payload", entry.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    hooks.beforeMutation?.("write", path);
    durableFile(path, entry.content, fileMode(entry.mode));
  }
  readExtractedWorkflowPackage(stage);
  syncTreeDirectories(stage);
}

function publishStage(
  stage: string,
  target: StoredWorkflow,
  hooks: WorkflowStorageHooks,
): void {
  const parent = dirname(target.installation);
  createDataDirectory(parent);
  const existingProblem = installationProblem(target);
  if (existingProblem === null) {
    rmSync(stage, { recursive: true, force: true });
    return;
  }
  try {
    lstatSync(target.installation);
    const quarantined = `${target.installation}.damaged-${randomBytes(6).toString("hex")}`;
    hooks.beforeMutation?.("rename", target.installation);
    renameSync(target.installation, quarantined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  hooks.beforeMutation?.("rename", stage);
  try {
    renameSync(stage, target.installation);
  } catch (error) {
    // Another project may have published the same verified digest first.
    if (installationProblem(target) !== null) throw error;
    rmSync(stage, { recursive: true, force: true });
  }
  syncDirectory(parent);
}

export function selectWorkflow(
  project: string,
  pkg: LoadedWorkflowPackage,
  env: NodeJS.ProcessEnv = process.env,
  hooks: WorkflowStorageHooks = {},
): { changed: boolean; selection: StoredWorkflow } {
  const path = workflowSelectionPath(project, env);
  const current = readSelection(project, env);
  const target = refFor(pkg, env);
  if (current?.pending !== null && current?.pending !== undefined && !sameRef(current.pending.target, target)) {
    fail(
      `selection of ${current.pending.target.workflow}@${current.pending.target.version} is already pending in ${path}; ` +
        "finish it with its original source or run `ub agents uninstall`",
    );
  }
  if (current?.pending === null && current.selected !== null && sameRef(current.selected, target)) {
    if (installationProblem(target) === null) return { changed: false, selection: target };
  }

  const pending: WorkflowSelectionRecord = {
    recordVersion: 1,
    project,
    selected: current?.selected ?? null,
    pending: { operation: "select", target, stage: stagePath(project, target, env) },
  };
  try {
    if (current?.pending === null || current === null) atomicRecordWrite(path, pending, hooks);
  } catch (error) {
    // A rename can succeed even if the following directory sync reports a
    // failure. Re-read rather than guessing whether the pending operation is
    // now durable enough to expose and recover.
    let recorded = false;
    try {
      const after = readSelection(project, env);
      recorded = after?.pending !== null &&
        after?.pending !== undefined &&
        sameRef(after.pending.target, target);
    } catch {
      // The original write failure remains the useful error. A later list will
      // diagnose any independently unreadable record by its exact path.
    }
    const previous = pending.selected === null
      ? "the project-tree fallback remains effective"
      : `${pending.selected.workflow}@${pending.selected.version} remains effective`;
    fail(
      `${error instanceof Error ? error.message : String(error)}; ${previous}; ` +
        (recorded
          ? `the partial selection is recorded in ${path} — rerun \`ub agents install <source>\` with the same package, or run \`ub agents uninstall\` to undo it`
          : "no selection record was changed — fix the storage error and rerun `ub agents install <source>`"),
    );
  }
  try {
    writeStage(pending.pending?.stage as string, pkg, hooks);
    publishStage(pending.pending?.stage as string, target, hooks);
    atomicRecordWrite(
      path,
      { recordVersion: 1, project, selected: target, pending: null },
      hooks,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    let after: WorkflowSelectionRecord | null;
    try {
      after = readSelection(project, env);
    } catch (readError) {
      fail(
        `${detail}; the selection state in ${path} could not be reread ` +
          `(${readError instanceof Error ? readError.message : String(readError)}); ` +
          "run `ub agents list` before retrying",
      );
    }
    if (after?.selected !== null && after?.selected !== undefined &&
      sameRef(after.selected, target) && after.pending === null) {
      fail(
        `${detail}; ${target.workflow}@${target.version} is now the effective selection in ${path}, ` +
          "but its durability could not be confirmed; run `ub agents list` before retrying",
      );
    }
    const previous = after?.selected === null || after?.selected === undefined
      ? "the project-tree fallback remains effective"
      : `${after.selected.workflow}@${after.selected.version} remains effective`;
    const partial = after?.pending !== null && after?.pending !== undefined
      ? `the partial selection is recorded in ${path} — rerun \`ub agents install <source>\` ` +
        "with the same package, or run `ub agents uninstall` to undo it"
      : `no pending selection is visible in ${path}; run \`ub agents list\` before retrying`;
    fail(
      `${detail}; ${previous}; ${partial}`,
    );
  }
  return { changed: current?.selected === null || current?.selected === undefined || !sameRef(current.selected, target), selection: target };
}

export function unselectWorkflow(
  project: string,
  env: NodeJS.ProcessEnv = process.env,
  hooks: WorkflowStorageHooks = {},
): void {
  const path = workflowSelectionPath(project, env);
  const current = readSelection(project, env);
  if (current === null) fail(`no external workflow is selected for ${project}`);

  const pendingStage = current.pending?.stage;
  if (pendingStage !== undefined) {
    try {
      let exists = true;
      try {
        lstatSync(pendingStage);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        exists = false;
      }
      if (exists) {
        hooks.beforeMutation?.("remove", pendingStage);
        rmSync(pendingStage, { recursive: true, force: true });
        hooks.beforeMutation?.("sync", dirname(pendingStage));
        syncDirectory(dirname(pendingStage));
      }
    } catch (error) {
      fail(
        `${error instanceof Error ? error.message : String(error)}; pending storage ${pendingStage} ` +
          `could not be fully removed, so the recoverable selection record in ${path} was kept; ` +
          "fix the storage error and rerun `ub agents uninstall`",
      );
    }
  }

  try {
    hooks.beforeMutation?.("remove", path);
    unlinkSync(path);
    hooks.beforeMutation?.("sync", dirname(path));
    syncDirectory(dirname(path));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    let after: WorkflowSelectionRecord | null;
    try {
      after = readSelection(project, env);
    } catch (readError) {
      fail(
        `${detail}; the selection state in ${path} could not be reread ` +
          `(${readError instanceof Error ? readError.message : String(readError)}); ` +
          "run `ub agents list` before retrying",
      );
    }
    if (after === null) {
      fail(
        `${detail}; the selection record is no longer visible, but its removal durability could not ` +
          "be confirmed; run `ub agents list` and rerun `ub agents uninstall` if it returns",
      );
    }
    const effective = after.selected === null
      ? "the project-tree fallback remains effective"
      : `${after.selected.workflow}@${after.selected.version} remains effective`;
    fail(
      `${detail}; ${effective}; the recoverable selection record remains in ${path}; ` +
        "fix the storage error and rerun `ub agents uninstall`",
    );
  }
}
