/** The project-local lifecycle for validated agent-workflow packages. */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  installWorkflow,
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
import { removeTempDirs, REPO_ROOT, runUb, sandbox, type Sandbox } from "./helpers.js";

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
    expect(JSON.parse(readFileSync(join(box.cwd, WORKFLOW_RECORD), "utf8")).status).toEqual({
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
    expect(inaccessibleRecord.status).toEqual({
      state: "partial",
      operation: "update",
      targetVersion: "2.0.0",
    });
    const inaccessibleList = runUb(["agents", "list"], inaccessible);
    expect(inaccessibleList.status, inaccessibleList.output).toBe(0);
    expect(inaccessibleList.stdout).toContain("changed or missing: locked/inner/obsolete.md");
    chmodSync(join(inaccessible.cwd, "locked"), 0o755);
  });

  it("adopts the real producer's package without a second declaration schema", () => {
    const producer = sandbox();
    const producerLaunch = `${JSON.stringify({
      version: 2,
      project: {
        repository: "fixture/workflow-source",
        baseRef: { remote: "origin", branch: "main" },
      },
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
    })}\n`;
    gitProject(producer, producerLaunch);
    write(join(producer.cwd, ".agents/roles/shipper.md"), "# Shipper\n");
    write(join(producer.cwd, ".codex/agents/shipper.toml"), 'name = "shipper"\n');
    write(
      join(producer.cwd, ".agents/requires.json"),
      `${JSON.stringify(
        {
          version: 1,
          bindings: ["project.repository"],
          resources: [
            ".agents/requires.json",
            ".agents/roles/shipper.md",
            ".codex/agents/shipper.toml",
          ],
          projectResources: [".agents/launch.json"],
        },
        null,
        2,
      )}\n`,
    );
    expect(spawnSync("git", ["add", "-A"], { cwd: producer.cwd }).status).toBe(0);
    expect(
      spawnSync(
        "git",
        ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "workflow"],
        { cwd: producer.cwd },
      ).status,
    ).toBe(0);

    const box = sandbox();
    gitProject(box);
    const output = join(dirname(box.cwd), "built-workflow");
    const producerModule = pathToFileURL(join(REPO_ROOT, "scripts/build-workflow-package.mjs")).href;
    const built = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { buildWorkflowPackage } from ${JSON.stringify(producerModule)}; buildWorkflowPackage({ root: process.argv[1], version: "9.8.7", outputDir: process.argv[2], env: {} });`,
        producer.cwd,
        output,
      ],
      { cwd: producer.cwd, encoding: "utf8" },
    );
    expect(built.status, built.stderr).toBe(0);

    const installed = runUb(
      ["agents", "install", join(output, "uberblick-workflow-9.8.7.tar.gz")],
      box,
    );
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
