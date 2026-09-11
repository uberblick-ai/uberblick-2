/** The project-local lifecycle for validated agent-workflow packages. */

import { spawnSync } from "node:child_process";
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  installWorkflow,
  uninstallWorkflow,
  updateWorkflow,
  WORKFLOW_RECORD,
} from "../src/workflow-adoption.js";
import {
  DIGEST_FRAMING,
  loadWorkflowPackage,
  payloadDigest,
  readArchivedWorkflowPackage,
  readExtractedWorkflowPackage,
  type WorkflowMode,
  type WorkflowPackageEntry,
} from "../src/workflow-package.js";
import { PACKAGE_ROOT, removeTempDirs, runUb, sandbox, type Sandbox } from "./helpers.js";

afterAll(removeTempDirs);

const COMMIT = "1".repeat(40);

function write(path: string, content: string | Buffer, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

function gitProject(
  box: Sandbox,
  launch = `${JSON.stringify({
    version: 2,
    project: { baseRef: { remote: "origin", branch: "main" } },
    entryRoles: {
      shipper: {
        contract: ".agents/roles/shipper.md",
        defaultRuntime: "codex",
        probe: ["true"],
        runtimes: {
          claude: {
            adapter: ".claude/agents/shipper.md",
            sandbox: "runtime",
            permissionMode: "auto",
          },
          codex: { adapter: ".codex/agents/shipper.toml", sandbox: "workspace-write" },
        },
      },
    },
  })}\n`,
): void {
  expect(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: box.cwd }).status).toBe(0);
  write(join(box.cwd, ".agents/launch.json"), launch);
  write(join(box.cwd, ".claude/settings.json"), '{"permissions":{"allow":[]}}\n');
  write(join(box.cwd, ".codex/config.toml"), 'approval_policy = "never"\n');
  expect(spawnSync("git", ["add", "-A"], { cwd: box.cwd }).status).toBe(0);
  expect(
    spawnSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "project"],
      { cwd: box.cwd },
    ).status,
  ).toBe(0);
}

function packageAt(
  root: string,
  version: string,
  files: Record<string, { content: string; mode?: WorkflowMode }>,
): string {
  const directory = join(root, `uberblick-workflow-${version}`);
  const requires = ".agents/requires.json";
  const resources = [...Object.keys(files), requires].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  const expanded: Record<string, { content: string; mode?: WorkflowMode }> = {
    ...files,
    [requires]: {
      content: `${JSON.stringify(
        {
          version: 1,
          bindings: ["project.repository"],
          resources,
          projectResources: [
            ".agents/launch.json",
            ".claude/settings.json",
            ".codex/config.toml",
          ],
        },
        null,
        2,
      )}\n`,
    },
  };
  const entries: WorkflowPackageEntry[] = Object.entries(expanded)
    .map(([path, file]) => ({
      path,
      mode: file.mode ?? "100644",
      content: Buffer.from(file.content, "utf8"),
    }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  for (const entry of entries) {
    write(join(directory, "payload", entry.path), entry.content, entry.mode === "100755" ? 0o755 : 0o644);
  }
  write(
    join(directory, "manifest.json"),
    `${JSON.stringify(
      {
        manifestVersion: 1,
        workflow: "uberblick-workflow",
        version,
        source: { repository: "fixture/workflow-source", commit: COMMIT },
        digest: { algorithm: "sha256", framing: DIGEST_FRAMING, payload: payloadDigest(entries) },
        payload: entries.map(({ path, mode }) => ({ path, mode })),
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

function interruptWorkflow(
  operation: "install" | "update" | "uninstall",
  root: string,
  packageDirectory: string,
): ReturnType<typeof spawnSync> {
  const script = join(dirname(root), `interrupt-${operation}.ts`);
  const adoptionModule = pathToFileURL(join(PACKAGE_ROOT, "src/workflow-adoption.ts")).href;
  const packageModule = pathToFileURL(join(PACKAGE_ROOT, "src/workflow-package.ts")).href;
  write(
    script,
    `import { installWorkflow, uninstallWorkflow, updateWorkflow } from ${JSON.stringify(adoptionModule)};
import { readExtractedWorkflowPackage } from ${JSON.stringify(packageModule)};
const operation = process.argv[2];
const root = process.argv[3];
const pkg = { ...readExtractedWorkflowPackage(process.argv[4]), sourceKind: "local" };
const hooks = { beforeMutation: (_operation, _path, index) => {
  if (index === 1) process.kill(process.pid, "SIGKILL");
} };
if (operation === "install") installWorkflow(root, pkg, hooks);
else if (operation === "update") updateWorkflow(root, pkg, hooks);
else uninstallWorkflow(root, hooks);
`,
  );
  return spawnSync(process.execPath, ["--import", "tsx", script, operation, root, packageDirectory], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
}

function relocatePayloadDuring(
  operation: "write" | "remove",
  box: Sandbox,
  destination: string,
  replacement: Record<string, string>,
  action: () => void,
): void {
  const originalOpen = fs.openSync;
  const originalUnlink = fs.unlinkSync;
  let relocated = false;
  const relocate = (): void => {
    renameSync(join(box.cwd, "payload"), destination);
    mkdirSync(join(box.cwd, "payload"));
    for (const [path, content] of Object.entries(replacement)) write(join(box.cwd, "payload", path), content);
    relocated = true;
  };
  if (operation === "write") {
    fs.openSync = ((path, ...args) => {
      if (
        !relocated &&
        typeof path === "string" &&
        path.startsWith(".a.txt.") &&
        process.cwd() === join(box.cwd, "payload")
      ) {
        relocate();
      }
      return (originalOpen as (...openArgs: unknown[]) => number)(path, ...args);
    }) as typeof fs.openSync;
  } else {
    fs.unlinkSync = ((path) => {
      if (!relocated && path === "a.txt" && process.cwd() === join(box.cwd, "payload")) relocate();
      return originalUnlink(path);
    }) as typeof fs.unlinkSync;
  }
  syncBuiltinESMExports();
  try {
    action();
  } finally {
    fs.openSync = originalOpen;
    fs.unlinkSync = originalUnlink;
    syncBuiltinESMExports();
  }
  expect(relocated).toBe(true);
}

const V1 = {
  // Installation succeeds, so this executable payload certainly was not run
  // as a package hook.
  ".agents/adapters/run.sh": { content: "#!/bin/sh\nexit 99\n", mode: "100755" as const },
  ".agents/roles/shipper.md": { content: "# Shipper v1\n" },
  ".codex/agents/shipper.toml": { content: 'name = "shipper"\n' },
  "AGENTS.md": { content: "# Adopted workflow\n" },
};

const V2 = {
  ".agents/roles/reviewer.md": { content: "# Reviewer v2\n" },
  ".agents/roles/shipper.md": { content: "# Shipper v2\n" },
  ".codex/agents/shipper.toml": { content: 'name = "shipper"\n' },
  "AGENTS.md": { content: "# Adopted workflow\n" },
};

describe("ub agents workflow lifecycle", () => {
  it.each([
    [0o664, 0o775],
    [0o654, 0o744],
    [0o645, 0o700],
  ])("preserves Git-equivalent checkout modes %o/%o through the lifecycle", (regular, executable) => {
    const box = sandbox();
    gitProject(box);
    const packages = join(dirname(box.cwd), "packages");
    const first = packageAt(packages, "1.0.0", V1);
    const second = packageAt(packages, "2.0.0", V2);
    expect(runUb(["agents", "install", first], box).status).toBe(0);
    const paths = [join(box.cwd, "AGENTS.md"), join(box.cwd, ".agents/adapters/run.sh")] as const;
    chmodSync(paths[0], regular);
    chmodSync(paths[1], executable);
    const record = readFileSync(join(box.cwd, WORKFLOW_RECORD), "utf8");

    const listed = runUb(["agents", "list"], box);
    expect(listed.status, listed.output).toBe(0);
    expect(listed.stdout).not.toContain("changed or missing:");
    expect(readFileSync(join(box.cwd, WORKFLOW_RECORD), "utf8")).toBe(record);
    expect(paths.map((path) => statSync(path).mode & 0o777)).toEqual([regular, executable]);

    const unchanged = runUb(["agents", "update", first], box);
    expect(unchanged.status, unchanged.output).toBe(0);
    expect(paths.map((path) => statSync(path).mode & 0o777)).toEqual([regular, executable]);
    expect(readFileSync(join(box.cwd, WORKFLOW_RECORD), "utf8")).toBe(record);

    const updated = runUb(["agents", "update", second], box);
    expect(updated.status, updated.output).toBe(0);
    expect(existsSync(paths[1])).toBe(false);
    expect(statSync(paths[0]).mode & 0o777).toBe(regular);
    const removed = runUb(["agents", "uninstall"], box);
    expect(removed.status, removed.output).toBe(0);
    expect(existsSync(paths[0])).toBe(false);
    expect(existsSync(join(box.cwd, WORKFLOW_RECORD))).toBe(false);
  });

  it.each([
    [".agents/adapters/run.sh", 0o655],
    ["AGENTS.md", 0o744],
  ] as const)("preserves a changed owner-execute bit on %s", (path, mode) => {
    const box = sandbox();
    gitProject(box);
    const first = packageAt(join(dirname(box.cwd), "packages"), "1.0.0", V1);
    expect(runUb(["agents", "install", first], box).status).toBe(0);
    const changed = join(box.cwd, path);
    chmodSync(changed, mode);
    const content = readFileSync(changed);
    const record = readFileSync(join(box.cwd, WORKFLOW_RECORD), "utf8");

    expect(runUb(["agents", "list"], box).stdout).toContain(`changed or missing: ${path}`);
    const update = runUb(["agents", "update", first], box);
    expect(update.status).not.toBe(0);
    expect(update.stderr).toContain(`locally edited or missing managed file ${path}`);
    expect(readFileSync(join(box.cwd, WORKFLOW_RECORD), "utf8")).toBe(record);
    const uninstall = runUb(["agents", "uninstall"], box);
    expect(uninstall.status).not.toBe(0);
    expect(uninstall.stderr).toContain(`kept changed or unremovable resources: ${path}`);
    expect(readFileSync(changed)).toEqual(content);
    expect(statSync(changed).mode & 0o777).toBe(mode);
  });

  it("installs, lists, updates and uninstalls one project-owned workflow", () => {
    const box = sandbox();
    gitProject(box);
    const packages = join(dirname(box.cwd), "packages");
    const first = packageAt(packages, "1.0.0", V1);
    const second = packageAt(packages, "2.0.0", V2);

    const installed = runUb(["agents", "install", first], box);
    expect(installed.status, installed.output).toBe(0);
    expect(installed.stdout).toContain("Installed uberblick-workflow@1.0.0 from local source");
    expect(readFileSync(join(box.cwd, ".agents/roles/shipper.md"), "utf8")).toBe("# Shipper v1\n");
    expect(statSync(join(box.cwd, ".agents/roles/shipper.md")).mode & 0o777).toBe(0o644);
    expect(statSync(join(box.cwd, ".agents/adapters/run.sh")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(box.cwd, ".agents/launch.json"), "utf8")).toContain('"version":2');
    expect(readFileSync(join(box.cwd, ".claude/settings.json"), "utf8")).toContain("permissions");
    expect(readFileSync(join(box.cwd, ".codex/config.toml"), "utf8")).toContain("approval_policy");

    const listed = runUb(["agents", "list"], box);
    expect(listed.status, listed.output).toBe(0);
    expect(listed.stdout).toContain("uberblick-workflow 1.0.0");
    expect(listed.stdout).toContain(`source: local fixture/workflow-source@${COMMIT}`);
    expect(listed.stdout).toContain("roles: shipper");
    expect(listed.stdout).toContain("state: installed; 5 managed resources");

    const updated = runUb(["agents", "update", second], box);
    expect(updated.status, updated.output).toBe(0);
    expect(readFileSync(join(box.cwd, ".agents/roles/shipper.md"), "utf8")).toBe("# Shipper v2\n");
    expect(readFileSync(join(box.cwd, ".agents/roles/reviewer.md"), "utf8")).toBe("# Reviewer v2\n");
    expect(existsSync(join(box.cwd, ".agents/adapters/run.sh"))).toBe(false);
    expect(runUb(["agents", "list"], box).stdout).toContain("roles: shipper");

    const uninstalled = runUb(["agents", "uninstall"], box);
    expect(uninstalled.status, uninstalled.output).toBe(0);
    for (const path of ["AGENTS.md", ".agents/roles/shipper.md", ".agents/roles/reviewer.md", WORKFLOW_RECORD]) {
      expect(existsSync(join(box.cwd, path)), path).toBe(false);
    }
    expect(existsSync(join(box.cwd, ".agents/launch.json"))).toBe(true);
    expect(runUb(["agents", "list"], box).stdout).toContain("No agent workflow is adopted");
    expect(spawnSync("git", ["log", "--format=%s"], { cwd: box.cwd, encoding: "utf8" }).stdout.trim()).toBe(
      "project",
    );
  });

  it("validates the whole package and every collision before writing", () => {
    const damaged = sandbox();
    gitProject(damaged);
    const damagedPackage = packageAt(join(dirname(damaged.cwd), "packages"), "1.0.0", V1);
    write(join(damagedPackage, "payload/AGENTS.md"), "tampered\n");
    const refusedDamage = runUb(["agents", "install", damagedPackage], damaged);
    expect(refusedDamage.status).toBe(1);
    expect(refusedDamage.stderr).toContain("payload digest");
    expect(existsSync(join(damaged.cwd, ".agents/roles/shipper.md"))).toBe(false);
    expect(existsSync(join(damaged.cwd, WORKFLOW_RECORD))).toBe(false);

    const collision = sandbox();
    gitProject(collision);
    const validPackage = packageAt(join(dirname(collision.cwd), "packages"), "1.0.0", V1);
    write(join(collision.cwd, "AGENTS.md"), "mine\n");
    const refusedCollision = runUb(["agents", "install", validPackage], collision);
    expect(refusedCollision.status).toBe(1);
    expect(refusedCollision.stderr).toContain("refusing to install AGENTS.md");
    expect(readFileSync(join(collision.cwd, "AGENTS.md"), "utf8")).toBe("mine\n");
    expect(existsSync(join(collision.cwd, ".agents/roles/shipper.md"))).toBe(false);
    expect(existsSync(join(collision.cwd, WORKFLOW_RECORD))).toBe(false);

    const policy = sandbox();
    gitProject(policy);
    const policyPackage = packageAt(join(dirname(policy.cwd), "packages"), "1.0.0", {
      ...V1,
      ".agents/launch.json": { content: '{"workflowSupplied":true}\n' },
    });
    const refusedPolicy = runUb(["agents", "install", policyPackage], policy);
    expect(refusedPolicy.status).toBe(1);
    expect(refusedPolicy.stderr).toContain("refusing to install .agents/launch.json: a file already exists there");
    expect(readFileSync(join(policy.cwd, ".agents/launch.json"), "utf8")).toContain('"version":2');

    const hook = sandbox();
    gitProject(hook);
    const hookPackage = packageAt(join(dirname(hook.cwd), "packages"), "1.0.0", {
      ".git/hooks/pre-commit": { content: "#!/bin/sh\nexit 99\n", mode: "100755" },
    });
    const refusedHook = runUb(["agents", "install", hookPackage], hook);
    expect(refusedHook.status).toBe(1);
    expect(refusedHook.stderr).toContain("may not enter Git administrative data");
    expect(existsSync(join(hook.cwd, ".git/hooks/pre-commit"))).toBe(false);
    expect(existsSync(join(hook.cwd, WORKFLOW_RECORD))).toBe(false);
  });

  it("refuses a symlink ancestor and a malformed escaping ownership path", () => {
    const linked = sandbox();
    gitProject(linked);
    const outside = join(dirname(linked.cwd), "outside");
    mkdirSync(outside);
    rmSync(join(linked.cwd, ".agents"), { recursive: true });
    symlinkSync(outside, join(linked.cwd, ".agents"));
    const pkg = packageAt(join(dirname(linked.cwd), "packages"), "1.0.0", V1);
    const refusedLink = runUb(["agents", "install", pkg], linked);
    expect(refusedLink.status).toBe(1);
    expect(refusedLink.stderr).toContain("is not an ordinary directory");
    expect(existsSync(join(outside, "roles/shipper.md"))).toBe(false);

    const malformed = sandbox();
    gitProject(malformed);
    const protectedFile = join(dirname(malformed.cwd), "do-not-remove");
    write(protectedFile, "safe\n");
    write(
      join(malformed.cwd, WORKFLOW_RECORD),
      `${JSON.stringify({
        recordVersion: 1,
        workflow: "uberblick-workflow",
        version: "1.0.0",
        source: { kind: "local", repository: "fixture/source", commit: COMMIT },
        digest: { algorithm: "sha256", framing: DIGEST_FRAMING, payload: "0".repeat(64) },
        resources: [{ path: "../do-not-remove", mode: "100644", sha256: "0".repeat(64) }],
        status: { state: "complete" },
      })}\n`,
    );
    const refusedRecord = runUb(["agents", "uninstall"], malformed);
    expect(refusedRecord.status).toBe(1);
    expect(refusedRecord.stderr).toContain("not canonical and repository-relative");
    expect(readFileSync(protectedFile, "utf8")).toBe("safe\n");
  });

  it("anchors writes and removals before an inspected ancestor is replaced", () => {
    const writing = sandbox();
    gitProject(writing);
    const writingPackage = packageAt(join(dirname(writing.cwd), "packages"), "1.0.0", {
      "payload/a.txt": { content: "a\n" },
      "payload/b.txt": { content: "b\n" },
    });
    const loaded = { ...readExtractedWorkflowPackage(writingPackage), sourceKind: "local" as const };
    const outsideWrite = join(dirname(writing.cwd), "outside-write");
    mkdirSync(outsideWrite);
    const originalOpen = fs.openSync;
    let writeSwapped = false;
    fs.openSync = ((path, ...args) => {
      if (
        !writeSwapped &&
        typeof path === "string" &&
        path.startsWith(".a.txt.") &&
        process.cwd() === join(writing.cwd, "payload")
      ) {
        renameSync(join(writing.cwd, "payload"), join(writing.cwd, "original-payload"));
        symlinkSync(outsideWrite, join(writing.cwd, "payload"));
        writeSwapped = true;
      }
      return (originalOpen as (...openArgs: unknown[]) => number)(path, ...args);
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    try {
      expect(() => installWorkflow(writing.cwd, loaded)).toThrow(
        /ancestor .*payload is not an ordinary directory.*partial install is recorded/,
      );
    } finally {
      fs.openSync = originalOpen;
      syncBuiltinESMExports();
    }
    expect(writeSwapped).toBe(true);
    expect(existsSync(join(outsideWrite, "a.txt"))).toBe(false);
    expect(readFileSync(join(writing.cwd, "original-payload/a.txt"), "utf8")).toBe("a\n");

    const removing = sandbox();
    gitProject(removing);
    const removingPackage = packageAt(join(dirname(removing.cwd), "packages"), "1.0.0", {
      "payload/a.txt": { content: "a\n" },
      "payload/b.txt": { content: "b\n" },
    });
    installWorkflow(removing.cwd, {
      ...readExtractedWorkflowPackage(removingPackage),
      sourceKind: "local" as const,
    });
    const outsideRemove = join(dirname(removing.cwd), "outside-remove");
    mkdirSync(outsideRemove);
    write(join(outsideRemove, "a.txt"), "outside\n");
    const originalUnlink = fs.unlinkSync;
    let removeSwapped = false;
    fs.unlinkSync = ((path) => {
      if (
        !removeSwapped &&
        path === "a.txt" &&
        process.cwd() === join(removing.cwd, "payload")
      ) {
        renameSync(join(removing.cwd, "payload"), join(removing.cwd, "original-payload"));
        symlinkSync(outsideRemove, join(removing.cwd, "payload"));
        removeSwapped = true;
      }
      return originalUnlink(path);
    }) as typeof fs.unlinkSync;
    syncBuiltinESMExports();
    try {
      expect(uninstallWorkflow(removing.cwd).remaining).toContain("payload/b.txt");
    } finally {
      fs.unlinkSync = originalUnlink;
      syncBuiltinESMExports();
    }
    expect(removeSwapped).toBe(true);
    expect(readFileSync(join(outsideRemove, "a.txt"), "utf8")).toBe("outside\n");
    expect(existsSync(join(removing.cwd, "original-payload/a.txt"))).toBe(false);
  });

  it("keeps every lifecycle partial when a mutation directory is relocated", () => {
    const box = sandbox();
    gitProject(box);
    const packages = join(dirname(box.cwd), "packages");
    const installPackage = packageAt(packages, "1.0.0", {
      "payload/a.txt": { content: "a\n" },
      "payload/b.txt": { content: "b\n" },
    });
    const installTarget = {
      ...readExtractedWorkflowPackage(installPackage),
      sourceKind: "local" as const,
    };
    const relocatedInstall = join(dirname(box.cwd), "relocated-install");
    relocatePayloadDuring("write", box, relocatedInstall, { "a.txt": "a\n" }, () => {
      expect(() => installWorkflow(box.cwd, installTarget)).toThrow(
        /mutation directory .* is no longer reachable.*partial install is recorded/,
      );
    });
    expect(readFileSync(join(relocatedInstall, "a.txt"), "utf8")).toBe("a\n");
    expect(JSON.parse(readFileSync(join(box.cwd, WORKFLOW_RECORD), "utf8")).status).toEqual({
      state: "partial",
      operation: "install",
    });
    updateWorkflow(box.cwd, installTarget);

    const updatePackage = packageAt(packages, "2.0.0", {
      "payload/a.txt": { content: "new a\n" },
      "payload/b.txt": { content: "new b\n" },
    });
    const updateTarget = {
      ...readExtractedWorkflowPackage(updatePackage),
      sourceKind: "local" as const,
    };
    const relocatedUpdate = join(dirname(box.cwd), "relocated-update");
    relocatePayloadDuring("write", box, relocatedUpdate, { "a.txt": "new a\n", "b.txt": "b\n" }, () => {
      expect(() => updateWorkflow(box.cwd, updateTarget)).toThrow(
        /mutation directory .* is no longer reachable.*partial update is recorded/,
      );
    });
    expect(JSON.parse(readFileSync(join(box.cwd, WORKFLOW_RECORD), "utf8")).status).toMatchObject({
      state: "partial",
      operation: "update",
      targetVersion: "2.0.0",
    });
    updateWorkflow(box.cwd, updateTarget);

    const relocatedUninstall = join(dirname(box.cwd), "relocated-uninstall");
    relocatePayloadDuring("remove", box, relocatedUninstall, {}, () => {
      expect(() => uninstallWorkflow(box.cwd)).toThrow(
        /mutation directory .* is no longer reachable.*partial uninstall is recorded/,
      );
    });
    expect(JSON.parse(readFileSync(join(box.cwd, WORKFLOW_RECORD), "utf8")).status).toEqual({
      state: "partial",
      operation: "uninstall",
    });
    expect(readFileSync(join(relocatedUninstall, "b.txt"), "utf8")).toBe("new b\n");
    expect(uninstallWorkflow(box.cwd)).toEqual({ remaining: [] });
  });

  it("refuses an edited update and retains an honest partial uninstall record", () => {
    const box = sandbox();
    gitProject(box);
    const packages = join(dirname(box.cwd), "packages");
    const first = packageAt(packages, "1.0.0", V1);
    const second = packageAt(packages, "2.0.0", V2);
    expect(runUb(["agents", "install", first], box).status).toBe(0);
    write(join(box.cwd, ".agents/roles/shipper.md"), "locally edited\n");

    const update = runUb(["agents", "update", second], box);
    expect(update.status).toBe(1);
    expect(update.stderr).toContain("locally edited or missing managed file .agents/roles/shipper.md");
    expect(existsSync(join(box.cwd, ".agents/roles/reviewer.md"))).toBe(false);
    expect(readFileSync(join(box.cwd, "AGENTS.md"), "utf8")).toBe("# Adopted workflow\n");

    const uninstall = runUb(["agents", "uninstall"], box);
    expect(uninstall.status).toBe(1);
    expect(uninstall.stderr).toContain("kept changed or unremovable resources: .agents/roles/shipper.md");
    expect(readFileSync(join(box.cwd, ".agents/roles/shipper.md"), "utf8")).toBe("locally edited\n");
    expect(existsSync(join(box.cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(box.cwd, ".agents/adapters/run.sh"))).toBe(false);
    const partial = runUb(["agents", "list"], box);
    expect(partial.stdout).toContain("state: partial uninstall; 1 managed resources");
    expect(partial.stdout).toContain("changed or missing: .agents/roles/shipper.md");

    rmSync(join(box.cwd, ".agents/roles/shipper.md"));
    expect(runUb(["agents", "uninstall"], box).status).toBe(0);
    expect(existsSync(join(box.cwd, WORKFLOW_RECORD))).toBe(false);
  });

  it("records and recovers install and update failures between file mutations", () => {
    const box = sandbox();
    gitProject(box);
    const packages = join(dirname(box.cwd), "packages");
    const firstDir = packageAt(packages, "1.0.0", V1);
    const secondDir = packageAt(packages, "2.0.0", V2);
    const first = { ...readExtractedWorkflowPackage(firstDir), sourceKind: "local" as const };
    const second = { ...readExtractedWorkflowPackage(secondDir), sourceKind: "local" as const };

    expect(() =>
      installWorkflow(box.cwd, first, {
        beforeMutation: (_operation, _path, index) => {
          if (index === 1) throw new Error("fixture stop");
        },
      }),
    ).toThrow(/partial install is recorded/);
    expect(JSON.parse(readFileSync(join(box.cwd, WORKFLOW_RECORD), "utf8")).status).toEqual({
      state: "partial",
      operation: "install",
    });
    updateWorkflow(box.cwd, first);
    expect(JSON.parse(readFileSync(join(box.cwd, WORKFLOW_RECORD), "utf8")).status).toEqual({
      state: "complete",
    });

    expect(() =>
      updateWorkflow(box.cwd, second, {
        beforeMutation: (_operation, _path, index) => {
          if (index === 1) throw new Error("fixture stop");
        },
      }),
    ).toThrow(/partial update is recorded/);
    expect(JSON.parse(readFileSync(join(box.cwd, WORKFLOW_RECORD), "utf8")).status).toMatchObject({
      state: "partial",
      operation: "update",
      targetVersion: "2.0.0",
    });
    updateWorkflow(box.cwd, second);
    expect(readFileSync(join(box.cwd, ".agents/roles/shipper.md"), "utf8")).toBe("# Shipper v2\n");
    expect(JSON.parse(readFileSync(join(box.cwd, WORKFLOW_RECORD), "utf8")).version).toBe("2.0.0");

    const removing = sandbox();
    gitProject(removing);
    const removalPackages = join(dirname(removing.cwd), "packages");
    const withObsolete = packageAt(removalPackages, "1.0.0", {
      ...V1,
      ".agents/obsolete-a.md": { content: "old a\n" },
      ".agents/obsolete-b.md": { content: "old b\n" },
    });
    const withoutObsolete = packageAt(removalPackages, "2.0.0", V2);
    const installed = { ...readExtractedWorkflowPackage(withObsolete), sourceKind: "local" as const };
    const target = { ...readExtractedWorkflowPackage(withoutObsolete), sourceKind: "local" as const };
    installWorkflow(removing.cwd, installed);
    let removals = 0;
    expect(() =>
      updateWorkflow(removing.cwd, target, {
        beforeMutation: (operation) => {
          if (operation === "remove" && removals++ === 2) throw new Error("fixture removal stop");
        },
      }),
    ).toThrow(/partial update is recorded/);
    expect(existsSync(join(removing.cwd, ".agents/obsolete-a.md"))).toBe(false);
    expect(existsSync(join(removing.cwd, ".agents/obsolete-b.md"))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(removing.cwd, WORKFLOW_RECORD), "utf8")).resources.map(
        (resource: { path: string }) => resource.path,
      ),
    ).not.toContain(".agents/obsolete-a.md");
    updateWorkflow(removing.cwd, target);
    expect(existsSync(join(removing.cwd, ".agents/obsolete-b.md"))).toBe(false);
    expect(JSON.parse(readFileSync(join(removing.cwd, WORKFLOW_RECORD), "utf8")).version).toBe("2.0.0");

    const inaccessible = sandbox();
    gitProject(inaccessible);
    const inaccessiblePackages = join(dirname(inaccessible.cwd), "packages");
    const withInaccessible = packageAt(inaccessiblePackages, "1.0.0", {
      ...V1,
      "locked/inner/obsolete.md": { content: "old\n" },
    });
    const withoutInaccessible = packageAt(inaccessiblePackages, "2.0.0", V2);
    installWorkflow(inaccessible.cwd, {
      ...readExtractedWorkflowPackage(withInaccessible),
      sourceKind: "local" as const,
    });
    expect(() =>
      updateWorkflow(
        inaccessible.cwd,
        { ...readExtractedWorkflowPackage(withoutInaccessible), sourceKind: "local" as const },
        {
          beforeMutation: (operation, path) => {
            if (operation === "remove" && path === "locked/inner/obsolete.md") {
              chmodSync(join(inaccessible.cwd, "locked"), 0);
            }
          },
        },
      ),
    ).toThrow(/partial update is recorded/);
    const inaccessibleRecord = JSON.parse(readFileSync(join(inaccessible.cwd, WORKFLOW_RECORD), "utf8"));
    expect(inaccessibleRecord.status).toMatchObject({
      state: "partial",
      operation: "update",
      targetVersion: "2.0.0",
    });
    try {
      const inaccessibleList = runUb(["agents", "list"], inaccessible);
      expect(inaccessibleList.status, inaccessibleList.output).toBe(0);
      expect(inaccessibleList.stdout).toContain("changed or missing: locked/inner/obsolete.md");
    } finally {
      chmodSync(join(inaccessible.cwd, "locked"), 0o755);
    }
  });

  it("records intent before process termination and recovers every lifecycle operation", () => {
    const box = sandbox();
    gitProject(box);
    const packages = join(dirname(box.cwd), "packages");
    const first = packageAt(packages, "1.0.0", V1);
    const second = packageAt(packages, "2.0.0", V2);

    const install = interruptWorkflow("install", box.cwd, first);
    expect(install.signal, String(install.stderr)).toBe("SIGKILL");
    expect(existsSync(join(box.cwd, ".agents/adapters/run.sh"))).toBe(true);
    chmodSync(join(box.cwd, ".agents/adapters/run.sh"), 0o775);
    expect(JSON.parse(readFileSync(join(box.cwd, WORKFLOW_RECORD), "utf8")).status).toEqual({
      state: "partial",
      operation: "install",
    });
    const partialInstall = runUb(["agents", "list"], box);
    expect(partialInstall.stdout).toContain("state: partial install");
    expect(partialInstall.stdout).toContain("next action: rerun `ub agents update <source>`");
    expect(runUb(["agents", "update", first], box).status).toBe(0);

    const update = interruptWorkflow("update", box.cwd, second);
    expect(update.signal, String(update.stderr)).toBe("SIGKILL");
    chmodSync(join(box.cwd, ".agents/requires.json"), 0o664);
    const partialUpdate = runUb(["agents", "list"], box);
    expect(partialUpdate.stdout).toContain("state: partial update to 2.0.0");
    expect(partialUpdate.stdout).toContain("next action: rerun `ub agents update <source>`");
    expect(runUb(["agents", "update", second], box).status).toBe(0);

    const uninstall = interruptWorkflow("uninstall", box.cwd, second);
    expect(uninstall.signal, String(uninstall.stderr)).toBe("SIGKILL");
    chmodSync(join(box.cwd, "AGENTS.md"), 0o664);
    const partialUninstall = runUb(["agents", "list"], box);
    expect(partialUninstall.stdout).toContain("state: partial uninstall");
    expect(partialUninstall.stdout).toContain("next action: restore or move any changed resources");
    expect(runUb(["agents", "uninstall"], box).status).toBe(0);
    expect(existsSync(join(box.cwd, WORKFLOW_RECORD))).toBe(false);
  });

  it("adopts the real producer's package without a second declaration schema", () => {
    const box = sandbox();
    gitProject(box);
    const archive = join(PACKAGE_ROOT, "test/fixtures/workflow-source/uberblick-workflow-9.8.7.tar.gz");
    const installed = runUb(["agents", "install", archive], box);
    expect(installed.status, installed.output).toBe(0);
    const listed = runUb(["agents", "list"], box);
    expect(listed.status, listed.output).toBe(0);
    expect(listed.stdout).toContain("roles: shipper");

    unlinkSync(join(box.cwd, ".agents/launch.json"));
    const missingDeclaration = runUb(["agents", "list"], box);
    expect(missingDeclaration.status, missingDeclaration.output).toBe(0);
    expect(missingDeclaration.stdout).toContain(
      "roles: unavailable; .agents/launch.json is missing; add the project's launch declaration before launching",
    );
  });

  it("bounds a published download and the expanded archive", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
      ),
    );
    try {
      const pending = loadWorkflowPackage("uberblick-workflow@1.0.0", process.cwd()).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      const failure = await pending;
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/could not fetch .*aborted/i);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }

    const compressed = gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1));
    expect(() => readArchivedWorkflowPackage(compressed)).toThrow(/archive expands beyond 16777216 bytes/);
  });

  it("resolves a published version to its one archive and keeps projects independent", async () => {
    const first = sandbox();
    const second = sandbox();
    gitProject(first);
    gitProject(second);
    const packages = join(dirname(first.cwd), "packages");
    const firstPackage = packageAt(packages, "1.0.0", V1);
    const secondPackage = packageAt(join(dirname(second.cwd), "packages"), "2.0.0", V2);
    const archive = join(dirname(first.cwd), "uberblick-workflow-1.0.0.tar.gz");
    const tar = spawnSync("tar", ["-czf", archive, "-C", packages, "uberblick-workflow-1.0.0"], {
      encoding: "utf8",
    });
    expect(tar.status, tar.stderr).toBe(0);
    const loaded = await loadWorkflowPackage(
      "uberblick-workflow@1.0.0",
      first.cwd,
      async (url) => {
        expect(url).toBe(
          "https://github.com/uberblick-ai/homebrew-tap/releases/download/workflow-v1.0.0/uberblick-workflow-1.0.0.tar.gz",
        );
        return readFileSync(archive);
      },
    );
    expect(loaded.sourceKind).toBe("published");
    expect(loaded.entries).toHaveLength(5);

    const hostile = packageAt(packages, "3.0.0", V1);
    rmSync(join(hostile, "payload/AGENTS.md"));
    symlinkSync("/tmp/outside", join(hostile, "payload/AGENTS.md"));
    const hostileArchive = join(dirname(first.cwd), "hostile.tar.gz");
    const archived = spawnSync("tar", ["-czf", hostileArchive, "-C", packages, "uberblick-workflow-3.0.0"], {
      encoding: "utf8",
    });
    expect(archived.status, archived.stderr).toBe(0);
    await expect(loadWorkflowPackage(hostileArchive, first.cwd)).rejects.toThrow(
      /is not an ordinary file or directory/,
    );

    // The package path and project are independent inputs: this invocation is
    // made from the second project while explicitly selecting the first.
    expect(runUb(["agents", "install", firstPackage, "--project", first.cwd], second).status).toBe(0);
    expect(runUb(["agents", "install", secondPackage], second).status).toBe(0);
    expect(readFileSync(join(first.cwd, ".agents/roles/shipper.md"), "utf8")).toContain("v1");
    expect(readFileSync(join(second.cwd, ".agents/roles/shipper.md"), "utf8")).toContain("v2");
    expect(runUb(["agents", "list"], first).stdout).toContain("1.0.0");
    expect(runUb(["agents", "list"], second).stdout).toContain("2.0.0");
  });
});
