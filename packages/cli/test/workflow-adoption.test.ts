/** Machine-stored workflow installation and per-project selection. */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveProjectDirectory } from "../src/project.js";
import {
  inspectWorkflowSelection,
  resolveSelectedWorkflow,
  selectWorkflow,
  unselectWorkflow,
  workflowSelectionPath,
} from "../src/workflow-storage.js";
import {
  DIGEST_FRAMING,
  payloadDigest,
  readExtractedWorkflowPackage,
  type WorkflowMode,
  type WorkflowPackageEntry,
} from "../src/workflow-package.js";
import { removeTempDirs, runUb, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

const COMMIT = "1".repeat(40);

function write(path: string, content: string | Buffer, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

function launchData(): string {
  return `${JSON.stringify({
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
  }, null, 2)}\n`;
}

function projectAt(path: string, git = true): string {
  mkdirSync(path, { recursive: true });
  write(join(path, ".agents/launch.json"), launchData());
  write(join(path, ".agents/roles/shipper.md"), "# Project-tree shipper\n");
  write(join(path, ".claude/agents/shipper.md"), "Project-tree Claude adapter\n");
  write(join(path, ".codex/agents/shipper.toml"), "name = \"shipper\"\n");
  write(join(path, "kept.txt"), "project-owned\n");
  if (git) {
    expect(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: path }).status).toBe(0);
    expect(spawnSync("git", ["add", "-A"], { cwd: path }).status).toBe(0);
    expect(
      spawnSync(
        "git",
        ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "project"],
        { cwd: path },
      ).status,
    ).toBe(0);
  }
  return realpathSync(path);
}

function packageAt(
  root: string,
  version: string,
  marker: string,
): string {
  const directory = join(root, `uberblick-workflow-${version}`);
  const files: Record<string, { content: string; mode?: WorkflowMode }> = {
    ".agents/roles/shipper.md": { content: `# Shipper ${marker}\n` },
    ".claude/agents/shipper.md": {
      content: `---\nname: shipper\ndescription: Ships ${marker}\n---\n\nFollow ${marker}.\n`,
    },
    ".codex/agents/shipper.toml": {
      content: `name = "shipper"\ndeveloper_instructions = """Follow ${marker}."""\n`,
    },
    "scripts/probe.mjs": { content: `process.stdout.write(${JSON.stringify(marker)});\n`, mode: "100755" },
  };
  const entries: WorkflowPackageEntry[] = Object.entries(files)
    .map(([path, file]) => ({
      path,
      mode: file.mode ?? "100644",
      content: Buffer.from(file.content),
    }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  for (const entry of entries) {
    write(join(directory, "payload", entry.path), entry.content, entry.mode === "100755" ? 0o755 : 0o644);
  }
  write(
    join(directory, "manifest.json"),
    `${JSON.stringify({
      manifestVersion: 1,
      workflow: "uberblick-workflow",
      version,
      source: { repository: "fixture/workflow-source", commit: COMMIT },
      digest: { algorithm: "sha256", framing: DIGEST_FRAMING, payload: payloadDigest(entries) },
      payload: entries.map(({ path, mode }) => ({ path, mode })),
    }, null, 2)}\n`,
  );
  return directory;
}

function projectTree(root: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (directory: string, relative = ""): void => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (relative === "" && item.name === ".git") continue;
      const child = relative === "" ? item.name : `${relative}/${item.name}`;
      const path = join(directory, item.name);
      if (item.isDirectory()) walk(path, child);
      else found[child] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return found;
}

describe("ub agents workflow selection", () => {
  it("stores outside projects and keeps two project-folder selections independent", () => {
    const box = sandbox();
    const root = dirname(box.cwd);
    const alpha = projectAt(join(root, "alpha"), false);
    const beta = projectAt(join(root, "beta"));
    const packages = join(root, "packages");
    const first = packageAt(packages, "1.0.0", "alpha-v1");
    const second = packageAt(packages, "2.0.0", "beta-v2");
    const alphaBefore = projectTree(alpha);
    const betaBefore = projectTree(beta);

    const selectedAlpha = runUb(["agents", "install", first, "--project", alpha], box);
    const selectedBeta = runUb(["agents", "install", second, "--project", beta], box);
    expect(selectedAlpha.status, selectedAlpha.output).toBe(0);
    expect(selectedBeta.status, selectedBeta.output).toBe(0);
    expect(projectTree(alpha)).toEqual(alphaBefore);
    expect(projectTree(beta)).toEqual(betaBefore);

    expect(runUb(["agents", "list", "--project", alpha], box).stdout).toMatch(
      /project: .*alpha[\s\S]*workflow: uberblick-workflow[\s\S]*version: 1\.0\.0[\s\S]*source: local[\s\S]*roles: shipper/,
    );
    expect(runUb(["agents", "list", "--project", beta], box).stdout).toContain("version: 2.0.0");

    expect(runUb(["agents", "install", second, "--project", alpha], box).status).toBe(0);
    expect(runUb(["agents", "list", "--project", alpha], box).stdout).toContain("version: 2.0.0");
    expect(runUb(["agents", "list", "--project", beta], box).stdout).toContain("version: 2.0.0");

    const betaInstallation = inspectWorkflowSelection(beta, box.env).record?.selected?.installation;
    const removed = runUb(["agents", "uninstall", "--project", alpha], box);
    expect(removed.status, removed.output).toBe(0);
    expect(runUb(["agents", "list", "--project", alpha], box).stdout).toContain("selection: none");
    expect(runUb(["agents", "list", "--project", beta], box).stdout).toContain("state: verified");
    expect(statSync(betaInstallation as string).isDirectory()).toBe(true);
    expect(projectTree(alpha)).toEqual(alphaBefore);
    expect(projectTree(beta)).toEqual(betaBefore);
  });

  it("keeps the prior selection through acquisition failure and makes identical install idempotent", () => {
    const box = sandbox();
    const project = projectAt(box.cwd);
    const pkg = packageAt(join(dirname(project), "packages"), "1.0.0", "stable");
    expect(runUb(["agents", "install", pkg], box).status).toBe(0);
    const recordPath = workflowSelectionPath(project, box.env);
    const before = readFileSync(recordPath, "utf8");

    const failed = runUb(["agents", "install", join(dirname(project), "missing-package")], box);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("no selection was changed");
    expect(failed.stderr).toContain("rerun `ub agents install <source>`");
    expect(readFileSync(recordPath, "utf8")).toBe(before);
    expect(runUb(["agents", "list"], box).stdout).toContain("version: 1.0.0");

    const again = runUb(["agents", "install", pkg], box);
    expect(again.status, again.output).toBe(0);
    expect(again.stdout).toContain("Already selected");
    expect(readFileSync(recordPath, "utf8")).toBe(before);
  });

  it("records a post-validation failure while the previous selection remains effective and recovers", () => {
    const box = sandbox();
    const project = projectAt(box.cwd);
    const packages = join(dirname(project), "packages");
    const firstPath = packageAt(packages, "1.0.0", "old");
    const secondPath = packageAt(packages, "2.0.0", "new");
    const first = { ...readExtractedWorkflowPackage(firstPath), sourceKind: "local" as const };
    const second = { ...readExtractedWorkflowPackage(secondPath), sourceKind: "local" as const };
    selectWorkflow(project, first, box.env);

    expect(() =>
      selectWorkflow(project, second, box.env, {
        beforeMutation(operation, path) {
          if (operation === "write" && path.endsWith("shipper.md")) throw new Error("fixture storage failure");
        },
      }),
    ).toThrow(/old.*remains effective|1\.0\.0 remains effective/);

    const partial = inspectWorkflowSelection(project, box.env);
    expect(partial.record?.selected?.version).toBe("1.0.0");
    expect(partial.record?.pending?.target.version).toBe("2.0.0");
    const listed = runUb(["agents", "list"], box);
    expect(listed.stdout).toContain("version: 1.0.0");
    expect(listed.stdout).toContain("pending: select uberblick-workflow@2.0.0");
    expect(listed.stdout).toContain("next action: rerun `ub agents install <source>`");

    expect(runUb(["agents", "install", secondPath], box).status).toBe(0);
    const recovered = inspectWorkflowSelection(project, box.env);
    expect(recovered.record?.selected?.version).toBe("2.0.0");
    expect(recovered.record?.pending).toBeNull();
  });

  it("keeps the project-tree fallback effective while a first selection is pending", () => {
    const box = sandbox();
    const project = projectAt(box.cwd);
    const packagePath = packageAt(join(dirname(project), "packages"), "1.0.0", "first");
    const pkg = { ...readExtractedWorkflowPackage(packagePath), sourceKind: "local" as const };

    expect(() =>
      selectWorkflow(project, pkg, box.env, {
        beforeMutation(operation, path) {
          if (operation === "write" && path.endsWith("shipper.md")) {
            throw new Error("fixture first-install failure");
          }
        },
      }),
    ).toThrow(/project-tree fallback remains effective/);

    expect(resolveSelectedWorkflow(project, box.env)).toBeNull();
    const partial = inspectWorkflowSelection(project, box.env);
    expect(partial.record?.selected).toBeNull();
    expect(partial.record?.pending?.target.version).toBe("1.0.0");
    const listed = runUb(["agents", "list"], box);
    expect(listed.stdout).toContain(
      "selection: none; launch uses the temporary workflow files in the project tree while selection is pending",
    );
    expect(listed.stdout).toContain("roles: shipper");
    expect(listed.stdout).not.toContain("repair .agents/launch.json");
  });

  it("reports the state reached when a selection or removal directory sync fails", () => {
    const box = sandbox();
    const project = projectAt(box.cwd);
    const packagePath = packageAt(join(dirname(project), "packages"), "2.0.0", "durability");
    const pkg = { ...readExtractedWorkflowPackage(packagePath), sourceKind: "local" as const };
    const recordPath = workflowSelectionPath(project, box.env);

    expect(() =>
      selectWorkflow(project, pkg, box.env, {
        beforeMutation(operation, path) {
          if (operation !== "sync" || path !== dirname(recordPath)) return;
          const visible = JSON.parse(readFileSync(recordPath, "utf8"));
          if (visible.selected?.version === "2.0.0" && visible.pending === null) {
            throw new Error("fixture final selection sync failure");
          }
        },
      }),
    ).toThrow(/2\.0\.0 is now the effective selection.*durability could not be confirmed/);
    expect(inspectWorkflowSelection(project, box.env).record).toMatchObject({
      selected: { version: "2.0.0" },
      pending: null,
    });

    expect(() =>
      unselectWorkflow(project, box.env, {
        beforeMutation(operation, path) {
          if (operation === "sync" && path === dirname(recordPath)) {
            throw new Error("fixture removal sync failure");
          }
        },
      }),
    ).toThrow(/selection record is no longer visible.*removal durability could not be confirmed/);
    expect(inspectWorkflowSelection(project, box.env).record).toBeNull();
  });

  it("removes a pending stage on uninstall and keeps its record if cleanup fails", () => {
    const box = sandbox();
    const project = projectAt(box.cwd);
    const packagePath = packageAt(join(dirname(project), "packages"), "1.0.0", "pending-cleanup");
    const pkg = { ...readExtractedWorkflowPackage(packagePath), sourceKind: "local" as const };

    expect(() =>
      selectWorkflow(project, pkg, box.env, {
        beforeMutation(operation, path) {
          if (operation === "write" && path.endsWith("shipper.md")) {
            throw new Error("fixture interrupted storage");
          }
        },
      }),
    ).toThrow(/partial selection is recorded/);
    const pendingStage = inspectWorkflowSelection(project, box.env).record?.pending?.stage as string;
    expect(statSync(pendingStage).isDirectory()).toBe(true);

    expect(() =>
      unselectWorkflow(project, box.env, {
        beforeMutation(operation, path) {
          if (operation === "remove" && path === pendingStage) {
            throw new Error("fixture pending cleanup failure");
          }
        },
      }),
    ).toThrow(/selection record.*was kept/);
    expect(inspectWorkflowSelection(project, box.env).record?.pending?.stage).toBe(pendingStage);
    expect(statSync(pendingStage).isDirectory()).toBe(true);

    unselectWorkflow(project, box.env);
    expect(inspectWorkflowSelection(project, box.env).record).toBeNull();
    expect(() => statSync(pendingStage)).toThrow();
  });

  it("reports changed stored bytes and launch refuses them before a runtime child", () => {
    const box = sandbox();
    const project = projectAt(box.cwd);
    const pkg = packageAt(join(dirname(project), "packages"), "1.0.0", "verified");
    expect(runUb(["agents", "install", pkg], box).status).toBe(0);
    const selected = inspectWorkflowSelection(project, box.env).record?.selected;
    const contract = join(selected?.installation as string, "payload/.agents/roles/shipper.md");
    writeFileSync(contract, "changed after verification\n");

    const listed = runUb(["agents", "list"], box);
    expect(listed.status, listed.output).toBe(0);
    expect(listed.stdout).toContain(`installation: ${selected?.installation}`);
    expect(listed.stdout).toContain("state: unusable");
    expect(listed.stdout).toContain("next action: run `ub agents install <source>`");

    const bin = join(dirname(project), "bin");
    write(join(bin, "codex"), "#!/bin/sh\nprintf touched > \"$RUNTIME_EVIDENCE\"\n", 0o755);
    const evidence = join(dirname(project), "runtime-evidence");
    const launched = runUb(
      ["agents", "launch", "shipper"],
      box,
      { PATH: `${bin}:${box.env.PATH ?? ""}`, RUNTIME_EVIDENCE: evidence },
    );
    expect(launched.status).toBe(1);
    expect(launched.stderr).toContain(selected?.installation as string);
    expect(launched.stderr).toContain("missing or changed");
    expect(() => statSync(evidence)).toThrow();
  });

  it("retires update into install and resolves ordinary folders without requiring Git", () => {
    const box = sandbox();
    const ordinary = projectAt(join(dirname(box.cwd), "ordinary"), false);
    expect(resolveProjectDirectory(ordinary, box.cwd, box.env).project?.root).toBe(ordinary);
    const updated = runUb(["agents", "update", "uberblick-workflow@2.0.0", "--project", ordinary], box);
    expect(updated.status).toBe(2);
    expect(updated.stderr).toContain("retired");
    expect(updated.stderr).toContain("ub agents install <source>");
  });
});
