#!/usr/bin/env node

/**
 * Disposable evidence fixture for issue #909.
 *
 * It creates two local git projects and two older candidate worktrees, installs
 * each project's MCP registration through the supplied checkout-free `ub`, and
 * starts the two project-selected parents concurrently from outside both.
 * The parents each start the other runtime as a child. Nothing here contacts
 * GitHub or calls a mutating Uberblick tool.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    ub: { type: "string" },
    root: { type: "string" },
    "self-test": { type: "boolean" },
    workspace: { type: "string" },
  },
  strict: true,
});

if (values["self-test"] === true) {
  runValidationSelfTest();
  process.exit(0);
}

if (values.ub === undefined || values.workspace === undefined) {
  throw new Error(
    "usage: 909-project-local-launch-fixture.mjs --ub <installed-ub> --workspace <uuid> [--root <dir>] | --self-test",
  );
}

const ub = resolve(values.ub);
const root = values.root === undefined
  ? mkdtempSync(join(tmpdir(), "ub-spike-909-"))
  : resolve(values.root);
const workspace = values.workspace;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspace)) {
  throw new Error(`not a workspace uuid: ${workspace}`);
}
if (!existsSync(ub)) throw new Error(`installed ub is absent: ${ub}`);
mkdirSync(root, { recursive: true });

const runtimeEnv = {
  ...process.env,
  PATH: `${dirname(ub)}:${process.env.PATH ?? ""}`,
};

function write(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { encoding: "utf8", ...(mode === undefined ? {} : { mode }) });
}

function run(command, args, cwd, env = runtimeEnv) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed in ${cwd}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function hashFile(path) {
  return existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex")
    : "absent";
}

function treeDigest(path) {
  const hash = createHash("sha256");
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const item = join(dir, name);
      const stat = lstatSync(item);
      hash.update(relative(path, item));
      hash.update(String(stat.mode));
      if (stat.isDirectory()) visit(item);
      else hash.update(stat.isSymbolicLink() ? readlinkSync(item) : readFileSync(item));
    }
  };
  visit(path);
  return hash.digest("hex");
}

function finalLine(output) {
  return output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}

function parseChildReading(line, source) {
  const match = /^CHILD marker=(\S+) workspace=(\S+) candidate=(\S+)$/.exec(line);
  if (match === null) throw new Error(`${source} has no completed CHILD result`);
  return { marker: match[1], workspace: match[2], candidate: match[3] };
}

function validateReadings(spec, result, expectedWorkspace, childOutput) {
  const parentLine = finalLine(result.output);
  const parentMatch = /^PARENT marker=(\S+) workspace=(\S+) child="([^"\r\n]+)"$/.exec(parentLine);
  if (parentMatch === null) {
    throw new Error(`${spec.name} has no completed final PARENT result; see ${result.log}`);
  }

  const embeddedChildLine = parentMatch[3];
  const childLine = finalLine(childOutput);
  const parent = {
    marker: parentMatch[1],
    workspace: parentMatch[2],
    child: parseChildReading(embeddedChildLine, `${spec.name} parent result`),
  };
  const child = parseChildReading(childLine, `${spec.name} child runner result`);
  const expectedCandidate = `${spec.name.toLowerCase()}-candidate-content`;
  const expected = { marker: spec.marker, workspace: expectedWorkspace, candidate: expectedCandidate };
  for (const [source, reading] of [["parent", parent], ["embedded child", parent.child], ["child runner", child]]) {
    for (const field of ["marker", "workspace"]) {
      if (reading[field] !== expected[field]) {
        throw new Error(`${spec.name} ${source} reported wrong ${field}; see ${result.log}`);
      }
    }
  }
  for (const [source, reading] of [["embedded child", parent.child], ["child runner", child]]) {
    if (reading.candidate !== expected.candidate) {
      throw new Error(`${spec.name} ${source} reported wrong candidate; see ${result.log}`);
    }
  }
  if (embeddedChildLine !== childLine) {
    throw new Error(`${spec.name} parent claim does not match the child runner result; see ${result.log}`);
  }
  return { parent, child };
}

function runValidationSelfTest() {
  const spec = { name: "A", marker: "PROJECT_A_CONTROL" };
  const workspace = "11111111-1111-4111-8111-111111111111";
  const child = `CHILD marker=${spec.marker} workspace=${workspace} candidate=a-candidate-content`;
  const valid = `PARENT marker=${spec.marker} workspace=${workspace} child="${child}"`;
  const validatedReadings = validateReadings(
    spec,
    { output: valid, log: "synthetic.log" },
    workspace,
    child,
  );

  const counterexamples = {
    wrong_child_result: {
      output: `PARENT marker=${spec.marker} workspace=${workspace} child="CHILD marker=${spec.marker} workspace=22222222-2222-4222-8222-222222222222 candidate=WRONG"`,
      childOutput: child,
    },
    instruction_echo_only: {
      output: `Tool output: PARENT marker=${spec.marker} workspace=<workspace-uuid> child="CHILD marker=${spec.marker}"\nworkspace=${workspace}\nFinal: child did not run.`,
      childOutput: "",
    },
  };
  const rejected = [];
  for (const [name, example] of Object.entries(counterexamples)) {
    try {
      validateReadings(spec, { output: example.output, log: "synthetic.log" }, workspace, example.childOutput);
    } catch {
      rejected.push(name);
    }
  }
  if (rejected.length !== Object.keys(counterexamples).length) {
    const accepted = Object.keys(counterexamples).filter((name) => !rejected.includes(name));
    throw new Error(`validator accepted a counterexample: ${accepted.join(", ")}`);
  }
  process.stdout.write(`${JSON.stringify({ verdict: "pass", validatedReadings, rejected }, null, 2)}\n`);
}

function launcherData(childRuntime) {
  return `${JSON.stringify({
    version: 2,
    project: {
      baseRef: { remote: "origin", branch: "main" },
    },
    entryRoles: {
      "probe-parent": {
        contract: ".agents/roles/probe-parent.md",
        defaultRuntime: "claude",
        runtimes: {
          claude: {
            adapter: ".claude/agents/probe-parent.md",
            permissionMode: "auto",
            allowedTools: childRuntime === "codex"
              ? ["Bash(node scripts/run-codex-probe.mjs:*)"]
              : [],
          },
          codex: {
            adapter: ".codex/agents/probe-parent.toml",
            sandbox: "danger-full-access",
          },
        },
      },
    },
  }, null, 2)}\n`;
}

function role(marker, childRuntime) {
  const runner = childRuntime === "codex"
    ? "node scripts/run-codex-probe.mjs"
    : "node scripts/run-claude-probe.mjs";
  return `# Probe parent\n\n` +
    `Project marker: ${marker}\n\n` +
    `This is a read-only evidence run. Call the project-provided Uberblick ` +
    `\`sync_status\` tool once and retain its \`workspace\` value. Then run exactly ` +
    `\`${runner}\` once and wait for it to finish. Do not edit files, call ` +
    `GitHub, call any mutating MCP tool, or investigate/recover from a failed ` +
    `tool or child; report that failure immediately. End with exactly one line in this shape:\n\n` +
    `PARENT marker=${marker} workspace=<workspace-uuid> child="<the child's final line>"\n`;
}

function reviewerRole(marker) {
  return `# Probe reviewer\n\n` +
    `Project marker: ${marker}\n\n` +
    `This is a read-only evidence run. Call the project-provided Uberblick ` +
    `\`sync_status\` tool once and retain its \`workspace\` value. Read ` +
    `\`$PROBE_CANDIDATE/app.txt\` from the candidate directory made available ` +
    `to you. Do not edit files, call GitHub, or call any mutating MCP tool. ` +
    `If either read is unavailable, report the failure immediately without ` +
    `investigation. End with exactly one line in this shape:\n\n` +
    `CHILD marker=${marker} workspace=<workspace-uuid> candidate=<app.txt contents>\n`;
}

const codexRunner = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const candidate = process.env.PROBE_CANDIDATE;
if (candidate === undefined) throw new Error("PROBE_CANDIDATE is missing");
const scratch = mkdtempSync(join(tmpdir(), "spike-909-codex-child-"));
const last = join(scratch, "last.txt");
try {
  const child = spawnSync("codex", [
    "exec", "-C", process.cwd(), "--add-dir", candidate,
    "-s", "danger-full-access",
    "-c", "projects." + JSON.stringify(process.cwd()) + ".trust_level='trusted'",
    "--ephemeral", "-o", last,
    "Read .agents/roles/probe-reviewer.md completely and follow it exactly. " +
      "The candidate path is in PROBE_CANDIDATE.",
  ], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  if (child.status !== 0) {
    process.stderr.write(child.stderr ?? "");
    process.exitCode = child.status ?? 1;
  } else {
    const line = readFileSync(last, "utf8").trim();
    const resultDir = join(process.cwd(), ".runtime");
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(join(resultDir, "probe-child-result.txt"), line + "\\n", "utf8");
    process.stdout.write(line + "\\n");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
`;

const claudeRunner = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const candidate = process.env.PROBE_CANDIDATE;
if (candidate === undefined) throw new Error("PROBE_CANDIDATE is missing");
const child = spawnSync("claude", [
  "-p", "Follow the probe-reviewer role exactly. The candidate path is in PROBE_CANDIDATE.",
  "--agent", "probe-reviewer", "--permission-mode", "auto",
  "--setting-sources", "project", "--no-session-persistence", "--add-dir", candidate,
], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
if (child.status !== 0) {
  process.stderr.write(child.stderr ?? "");
  process.exitCode = child.status ?? 1;
} else {
  const line = child.stdout.trim().split(/\\r?\\n/).filter(Boolean).at(-1) ?? "";
  const resultDir = join(process.cwd(), ".runtime");
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(join(resultDir, "probe-child-result.txt"), line + "\\n", "utf8");
  process.stdout.write(line + "\\n");
}
`;

function project(name, marker, childRuntime, legacyCandidate) {
  const control = join(root, `project-${name.toLowerCase()}`);
  const candidate = join(root, `candidate-${name.toLowerCase()}`);
  rmSync(control, { recursive: true, force: true });
  rmSync(candidate, { recursive: true, force: true });
  mkdirSync(control, { recursive: true });
  run("git", ["init", "-b", "main"], control);
  write(join(control, "app.txt"), `${name.toLowerCase()}-candidate-content\n`);
  if (legacyCandidate) {
    write(join(control, ".agents/roles/probe-reviewer.md"), reviewerRole(`${marker}_CANDIDATE_WRONG`));
    write(join(control, ".claude/agents/probe-reviewer.md"), `---\nname: probe-reviewer\ndescription: stale candidate adapter\n---\n\nProject marker: ${marker}_CANDIDATE_WRONG\n`);
    write(join(control, ".codex/agents/probe-reviewer.toml"), `name = "probe-reviewer"\ndescription = "${marker}_CANDIDATE_WRONG"\ndeveloper_instructions = """\nProject marker: ${marker}_CANDIDATE_WRONG\n"""\n`);
  }
  run("git", ["add", "."], control);
  run("git", ["-c", "user.name=Spike 909", "-c", "user.email=spike909@example.invalid", "commit", "-m", "candidate"], control);
  const candidateHead = run("git", ["rev-parse", "HEAD"], control).stdout.trim();

  write(join(control, ".agents/launch.json"), launcherData(childRuntime));
  write(join(control, ".agents/roles/probe-parent.md"), role(marker, childRuntime));
  write(join(control, ".agents/roles/probe-reviewer.md"), reviewerRole(marker));
  write(join(control, ".claude/agents/probe-parent.md"), `---\nname: probe-parent\ndescription: ${marker} parent\n---\n\nRead .agents/roles/probe-parent.md completely and follow it exactly.\n`);
  write(join(control, ".claude/agents/probe-reviewer.md"), `---\nname: probe-reviewer\ndescription: ${marker} reviewer\n---\n\nRead .agents/roles/probe-reviewer.md completely and follow it exactly.\n`);
  write(join(control, ".claude/settings.json"), `${JSON.stringify({
    enabledMcpjsonServers: ["uberblick"],
    permissions: {
      allow: childRuntime === "codex" ? ["Bash(node scripts/run-codex-probe.mjs:*)"] : [],
    },
  }, null, 2)}\n`);
  write(join(control, ".codex/agents/probe-parent.toml"), `name = "probe-parent"\ndescription = "${marker} parent"\ndeveloper_instructions = """\nRead .agents/roles/probe-parent.md completely and follow it exactly.\n"""\n`);
  write(join(control, ".codex/agents/probe-reviewer.toml"), `name = "probe-reviewer"\ndescription = "${marker} reviewer"\ndeveloper_instructions = """\nRead .agents/roles/probe-reviewer.md completely and follow it exactly.\n"""\n`);
  write(join(control, ".codex/rules/workflow.rules"), `prefix_rule(\n    pattern = ["node", "scripts/${childRuntime === "claude" ? "run-claude-probe.mjs" : "run-codex-probe.mjs"}"],\n    decision = "allow",\n    justification = "The #909 parent starts its one bounded cross-runtime child.",\n)\n`);
  write(join(control, ".gitignore"), ".runtime/\n");
  write(join(control, "scripts/run-codex-probe.mjs"), codexRunner, 0o755);
  write(join(control, "scripts/run-claude-probe.mjs"), claudeRunner, 0o755);

  const beforeRegistration = {
    claude: existsSync(join(control, ".mcp.json")),
    codex: existsSync(join(control, ".codex/config.toml")),
  };
  const claudeInstall = run(ub, ["mcp", "install", "claude", "--project", "--workspace", workspace], control);
  const codexInstall = run(ub, ["mcp", "install", "codex", "--project", "--workspace", workspace], control);
  run("git", ["add", "."], control);
  run("git", ["-c", "user.name=Spike 909", "-c", "user.email=spike909@example.invalid", "commit", "-m", "install project workflow"], control);
  const controlHead = run("git", ["rev-parse", "HEAD"], control).stdout.trim();
  run("git", ["worktree", "add", "--detach", candidate, candidateHead], control);
  return {
    name,
    marker,
    control,
    candidate,
    candidateHead,
    controlHead,
    beforeRegistration,
    installReports: [claudeInstall.stdout.trim(), codexInstall.stdout.trim()],
  };
}

function launch(spec, model) {
  const log = join(root, `${spec.name.toLowerCase()}-${model}.log`);
  const status = `${log}.status`;
  const handle = openSync(log, "w");
  const child = spawn(
    ub,
    [
      "agents", "launch", "probe-parent",
      "--project", spec.control,
      "--candidate", spec.candidate,
      "--model", model,
    ],
    { cwd: root, env: runtimeEnv, stdio: ["ignore", handle, handle], detached: true },
  );
  closeSync(handle);
  return new Promise((settle) => {
    let ended = false;
    const finish = (result) => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      write(status, `${result.code ?? "signal"} ${result.signal ?? ""}\n`);
      settle({ ...result, log, output: readFileSync(log, "utf8") });
    };
    child.once("close", (code, signal) => finish({ code, signal }));
    const deadline = setTimeout(() => {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }, 1_000).unref();
    }, 20 * 60_000);
  });
}

const installedRoot = dirname(dirname(ub));
const installDigestBefore = treeDigest(installedRoot);
const userConfigPaths = [join(homedir(), ".claude.json"), join(homedir(), ".codex/config.toml")];
const userConfigBefore = Object.fromEntries(userConfigPaths.map((path) => [path, hashFile(path)]));

const a = project("A", "PROJECT_A_CONTROL", "codex", false);
const b = project("B", "PROJECT_B_CONTROL", "claude", true);
const startedAt = new Date().toISOString();
const [aResult, bResult] = await Promise.all([launch(a, "claude"), launch(b, "codex")]);
const endedAt = new Date().toISOString();

const validatedReadings = new Map();
for (const [spec, result] of [[a, aResult], [b, bResult]]) {
  if (result.code !== 0) throw new Error(`${spec.name} launch failed; see ${result.log}`);
  const childResult = join(spec.control, ".runtime/probe-child-result.txt");
  const childOutput = existsSync(childResult) ? readFileSync(childResult, "utf8") : "";
  validatedReadings.set(spec.name, validateReadings(spec, result, workspace, childOutput));
  const candidateStatus = run("git", ["status", "--porcelain"], spec.candidate).stdout;
  if (candidateStatus !== "") throw new Error(`${spec.name} candidate was modified: ${candidateStatus}`);
}

const installDigestAfter = treeDigest(installedRoot);
const userConfigAfter = Object.fromEntries(userConfigPaths.map((path) => [path, hashFile(path)]));
if (installDigestBefore !== installDigestAfter) throw new Error("the installed payload changed during the probe");
const changedUserRuntimeConfig = userConfigPaths.filter(
  (path) => userConfigBefore[path] !== userConfigAfter[path],
);

process.stdout.write(`${JSON.stringify({
  verdict: changedUserRuntimeConfig.length === 0 ? "pass" : "bounded-failure",
  fixture: basename(import.meta.filename),
  root,
  installedUb: ub,
  installedDigest: installDigestAfter,
  runtimeVersions: {
    ub: run(ub, ["--version"], root).stdout.trim(),
    codex: run("codex", ["--version"], root).stdout.trim(),
    claude: run("claude", ["--version"], root).stdout.trim(),
  },
  concurrentWindow: { startedAt, endedAt },
  projects: [a, b].map((spec) => ({
    name: spec.name,
    marker: spec.marker,
    control: spec.control,
    candidate: spec.candidate,
    controlHead: spec.controlHead,
    candidateHead: spec.candidateHead,
    mcpConfigAbsentBeforeInstall: {
      claude: !spec.beforeRegistration.claude,
      codex: !spec.beforeRegistration.codex,
    },
    validatedReadings: validatedReadings.get(spec.name),
    candidateClean: true,
    log: join(root, `${spec.name.toLowerCase()}-${spec.name === "A" ? "claude" : "codex"}.log`),
  })),
  installedTreeUnchanged: true,
  userRuntimeConfigUnchanged: changedUserRuntimeConfig.length === 0,
  changedUserRuntimeConfig,
}, null, 2)}\n`);
if (changedUserRuntimeConfig.length > 0) process.exitCode = 1;
