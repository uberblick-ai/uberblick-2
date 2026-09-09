#!/usr/bin/env node

/**
 * Repeatable-launch evidence for issue #947.
 *
 * One acceptance criterion of that issue cannot be met by a passing test suite:
 * that launching *one unchanged project* repeatedly reaches that project's
 * pinned workspace every time, and that each run's outcome is attributed to
 * that run by the session's own evidence rather than by a success-shaped
 * substring matched in a combined log. #914 is why the substring route does not
 * count: the first #909 fixture searched merged logs and would have accepted a
 * child that never completed.
 *
 * So this fixture builds one disposable control project, registers that
 * project's own MCP entry pinned to a workspace, and drives several consecutive
 * `ub agents launch` runs against it. Each session writes one structured result
 * of its own, named by the run id the launcher minted for it; the parent reads
 * those files and never the transcript. A run whose child never completed, and
 * a run whose result names another project or another workspace, are failures.
 *
 * Two modes:
 *
 *   --self-test
 *       Offline. Runs the validator against synthetic readings and proves it
 *       rejects every result class a rerun must not accept. Starts no agent,
 *       touches no network, and is wired into `pnpm test` so it cannot rot.
 *
 *   --ub <installed-ub> --workspace <uuid> [--runs N] [--model claude|codex]
 *   [--root <dir>] [--out <file>] [--timeout-ms N]
 *       The live run. Needs an installed, checkout-free `ub`, an authenticated
 *       runtime, and a workspace this machine can open. Writes its reduction to
 *       --out; that reduction, not this script's stdout, is the retained
 *       evidence.
 *
 * Three reductions are retained beside this file, from an installed payload
 * driving three consecutive runs per file:
 *
 *   947-repeat-launch-evidence.json
 *       repeatable: true for Claude. The project's pinned workspace differs
 *       from the workspace this host resolves with no project selected, and
 *       every result also carries the independently expected database path
 *       that is absent from the control project's tracked files.
 *   947-repeat-launch-codex-evidence.json
 *       The same retained distinction for Codex: repeatable: true, with three
 *       completed runs reaching the project's pinned workspace and database.
 *   947-repeat-launch-uncommitted-entry.json
 *       repeatable: false, and why this fixture registers the MCP entry before
 *       it commits. A session runs in a fresh worktree of origin/main, so an
 *       entry left uncommitted never reaches it: run 1 happened to read the
 *       pinned workspace out of the control checkout, runs 2 and 3 fell back to
 *       the machine's own workspace, and the validator rejected both. It is the
 *       live counterpart of the self-test's synthetic counterexamples.
 *
 * Nothing here contacts GitHub or calls a mutating Uberblick tool.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const WORKSPACE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID = /^(claude|codex)-prober-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const PROJECT = "repeat-launch-control";

/**
 * One run's verdict, from that run's own retained result.
 *
 * `result` is what the session wrote for itself, or null when it wrote nothing
 * — which is a failed run and never a run to be inferred from a log. `seen`
 * carries the run ids already accepted, because the same file counted twice
 * would let one session's evidence stand in for a session that never ran.
 */
export function validateRun({ result, file, expected, seen }) {
  const problems = [];
  if (result === null || result === undefined) {
    problems.push("the session wrote no result: its child never completed");
    return { ok: false, problems };
  }
  const run = typeof result.run === "string" ? result.run : "";
  if (!RUN_ID.test(run)) {
    problems.push(`result names no launcher run id: ${JSON.stringify(result.run ?? null)}`);
  }
  if (file !== undefined && basename(file, ".json") !== run) {
    problems.push(`result is filed under ${basename(file, ".json")} but names run ${run}`);
  }
  if (seen?.has(run)) {
    problems.push(`run id ${run} was already counted: this is not a fresh run's evidence`);
  }
  if (result.project !== expected.project) {
    problems.push(
      `result names project ${JSON.stringify(result.project ?? null)}, not ${JSON.stringify(expected.project)}`,
    );
  }
  if (result.workspace !== expected.workspace) {
    problems.push(
      `result names workspace ${JSON.stringify(result.workspace ?? null)}, not the project's pinned ${JSON.stringify(expected.workspace)}`,
    );
  }
  if (result.database !== expected.database) {
    problems.push(
      `result names database ${JSON.stringify(result.database ?? null)}, not the independently expected ${JSON.stringify(expected.database)}`,
    );
  }
  return { ok: problems.length === 0, problems, run };
}

/** Refuse evidence whose project pin cannot be distinguished from host fallback. */
export function assertDistinctWorkspaces(workspace, workspaceResolvedWithoutProject) {
  if (workspaceResolvedWithoutProject === workspace) {
    throw new Error(
      `--workspace ${JSON.stringify(workspace)} collides with the workspace resolved with no project selected ${JSON.stringify(workspaceResolvedWithoutProject)}`,
    );
  }
}

function selfTest() {
  const expected = {
    project: PROJECT,
    workspace: "11111111-1111-4111-8111-111111111111",
    database: "/outside-the-control-worktree/11111111-1111-4111-8111-111111111111.sqlite",
  };
  const run = "claude-prober-20260908T101500Z-a1b2c3";
  const good = {
    run,
    project: expected.project,
    workspace: expected.workspace,
    database: expected.database,
  };
  const file = `${run}.json`;

  const accepted = validateRun({ result: good, file, expected, seen: new Set() });
  if (!accepted.ok) {
    throw new Error(`validator rejected a valid reading: ${accepted.problems.join("; ")}`);
  }

  // The two classes a rerun must never accept, plus the two ways a rerun could
  // be credited with evidence that is not its own.
  const counterexamples = {
    child_never_completed: { result: null, file, seen: new Set() },
    another_workspace: {
      result: { ...good, workspace: "22222222-2222-4222-8222-222222222222" },
      file,
      seen: new Set(),
    },
    another_project: { result: { ...good, project: "some-other-project" }, file, seen: new Set() },
    missing_database: {
      result: { run, project: expected.project, workspace: expected.workspace },
      file,
      seen: new Set(),
    },
    another_database: {
      result: { ...good, database: "/somewhere-else/workspace.sqlite" },
      file,
      seen: new Set(),
    },
    reused_result: { result: good, file, seen: new Set([run]) },
    misfiled_result: { result: good, file: "claude-prober-20260908T101500Z-ffffff.json", seen: new Set() },
    no_run_id: { result: { ...good, run: "the launcher said it worked" }, file, seen: new Set() },
  };

  const accepted_wrongly = [];
  const rejected = {};
  for (const [name, example] of Object.entries(counterexamples)) {
    const verdict = validateRun({ ...example, expected });
    if (verdict.ok) accepted_wrongly.push(name);
    else rejected[name] = verdict.problems;
  }
  if (accepted_wrongly.length > 0) {
    throw new Error(`validator accepted a counterexample: ${accepted_wrongly.join(", ")}`);
  }

  let collision = null;
  try {
    assertDistinctWorkspaces(expected.workspace, expected.workspace);
  } catch (error) {
    collision = error instanceof Error ? error.message : String(error);
  }
  if (collision === null || !collision.includes(expected.workspace)) {
    throw new Error("workspace collision guard accepted a colliding host and project pair");
  }
  rejected.workspace_collision = [collision];
  process.stdout.write(`${JSON.stringify({ verdict: "pass", accepted: good, rejected }, null, 2)}\n`);
}

function run(command, args, cwd, env = process.env) {
  const ran = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (ran.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed in ${cwd}\nstdout:\n${ran.stdout}\nstderr:\n${ran.stderr}`,
    );
  }
  return ran;
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/** The contract the launched role follows: one read, one retained result. */
function contract() {
  return `# Prober

A read-only evidence run for a repeatable launch. Do exactly this, and nothing
else — no GitHub call, no mutating Uberblick tool, no file outside the two
named below, and no investigation of a failure.

1. Call the uberblick MCP tool \`sync_status\` exactly once, through the
   \`uberblick\` MCP server this project registers and through no other route,
   and keep the \`workspace\` and \`database\` values it returns. If no such server is available
   to you, do not start one and do not substitute another route: write no
   result file, say which server was missing, and end with the line below.
2. Read the file \`marker\` in this worktree and keep its contents, trimmed.
3. Write one file named \`<your run id>.json\` into the directory the
   environment variable \`PROBER_RESULTS\` names, holding exactly this JSON
   object and no other key:

   {"run": "<your run id>", "project": "<the marker>", "workspace": "<the workspace>", "database": "<the database>"}

4. End with exactly this line and nothing after it:

   No eligible prober work: evidence run complete.

If either read fails, write no result file and say what failed, then end with
that same line.
`;
}

function launchData() {
  return `${JSON.stringify(
    {
      version: 1,
      entryRoles: {
        prober: {
          contract: ".agents/roles/prober.md",
          defaultRuntime: "claude",
          probe: ["sh", "probe.sh"],
          runtimes: {
            claude: { adapter: ".claude/agents/prober.md", sandbox: "runtime", permissionMode: "auto" },
            codex: { adapter: ".codex/agents/prober.toml", sandbox: "workspace-write" },
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

function makeControl(root, ub, workspace, env) {
  const control = join(root, "control");
  const origin = join(root, "control.git");
  mkdirSync(control, { recursive: true });
  run("git", ["init", "--bare", origin], root);
  run("git", ["init", "-b", "main"], control);

  write(join(control, "marker"), `${PROJECT}\n`);
  write(join(control, ".agents/roles/prober.md"), contract());
  write(join(control, ".agents/launch.json"), launchData());
  write(
    join(control, ".claude/agents/prober.md"),
    `---\nname: prober\ndescription: One read-only evidence run for a repeatable launch.\n---\n\nFollow \`.agents/roles/prober.md\` exactly.\n`,
  );
  write(
    join(control, ".codex/agents/prober.toml"),
    `name = "prober"\ndescription = "One read-only evidence run for a repeatable launch."\ndeveloper_instructions = "Follow .agents/roles/prober.md exactly."\n`,
  );
  write(join(control, "probe.sh"), "#!/bin/sh\nexit 0\n");
  run("chmod", ["+x", "probe.sh"], control);

  // The project's own workspace binding, and the only one: a project MCP entry
  // pinned with --workspace. Both clients, so either --model can be driven.
  // Registered *before* the commit on purpose: a session runs in a fresh
  // worktree of origin/main, so an entry that is not committed never reaches
  // it — which the first attempt at this evidence demonstrated by wandering to
  // the machine's own workspace instead.
  for (const client of ["claude", "codex"]) {
    run(ub, ["mcp", "install", client, "--project", "--workspace", workspace], control, env);
  }

  run("git", ["add", "-A"], control);
  run("git", ["-c", "user.name=Evidence", "-c", "user.email=evidence@example.invalid", "commit", "-m", "adopt"], control);
  run("git", ["remote", "add", "origin", origin], control);
  run("git", ["push", "-u", "origin", "main"], control);
  return control;
}

/**
 * One launch, stopped the moment the loop reports the role's own idle reason.
 *
 * The loop is a standing one, so the fixture is what ends it — the same way a
 * person does, with one interrupt — rather than waiting out a 30-minute idle.
 */
function launchOnce(ub, control, model, env, timeoutMs) {
  return new Promise((resolveRun, rejectRun) => {
    const args = ["agents", "launch", "prober", "--project", control];
    if (model !== undefined) args.push("--model", model);
    const child = spawn(ub, args, { cwd: tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let interrupted = false;
    const timer = setTimeout(() => {
      stderr += `\nfixture: no idle report within ${timeoutMs}ms\n`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (!interrupted && stdout.includes("will idle for")) {
        interrupted = true;
        child.kill("SIGINT");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectRun);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolveRun({ status, signal, stdout, stderr, interrupted });
    });
  });
}

function localWorkspaceContext(ub, workspace, env) {
  const listed = run(ub, ["workspace", "list", "--json"], tmpdir(), env);
  let entries;
  try {
    entries = JSON.parse(listed.stdout);
  } catch (error) {
    throw new Error(
      `${ub} workspace list --json returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(entries)) {
    throw new Error(`${ub} workspace list --json returned no workspace array`);
  }
  const active = entries.filter((entry) => entry?.active === true);
  if (active.length > 1) {
    throw new Error(`${ub} workspace list --json returned ${active.length} active workspaces`);
  }
  const workspaceResolvedWithoutProject = active.length === 0 ? null : active[0]?.uuid;
  if (
    workspaceResolvedWithoutProject !== null &&
    (typeof workspaceResolvedWithoutProject !== "string" ||
      !WORKSPACE_UUID.test(workspaceResolvedWithoutProject))
  ) {
    throw new Error(
      `${ub} workspace list --json returned an invalid active workspace: ${JSON.stringify(workspaceResolvedWithoutProject)}`,
    );
  }
  assertDistinctWorkspaces(workspace, workspaceResolvedWithoutProject);

  const matching = entries.filter((entry) => entry?.uuid === workspace);
  if (matching.length !== 1 || typeof matching[0]?.databasePath !== "string") {
    throw new Error(
      `${ub} workspace list --json did not return one local database for --workspace ${JSON.stringify(workspace)}`,
    );
  }
  return {
    workspaceResolvedWithoutProject,
    database: matching[0].databasePath,
  };
}

function assertExpectedDatabaseAbsent(control, database) {
  const searched = spawnSync(
    "git",
    ["grep", "--quiet", "--fixed-strings", "-e", database, "HEAD"],
    { cwd: control, encoding: "utf8" },
  );
  if (searched.status === 0) {
    throw new Error(`expected database appears in the control project's tracked files: ${database}`);
  }
  if (searched.status !== 1) {
    throw new Error(
      `git grep could not check the expected database in ${control}\nstdout:\n${searched.stdout}\nstderr:\n${searched.stderr}`,
    );
  }
}

function liveRun(values) {
  const ub = resolve(values.ub);
  if (!existsSync(ub)) throw new Error(`installed ub is absent: ${ub}`);
  const workspace = values.workspace;
  if (!WORKSPACE_UUID.test(workspace)) throw new Error(`not a workspace uuid: ${workspace}`);
  const env = {
    ...process.env,
    // Nothing ambient may stand in for the project's own pinned binding.
    WORKSPACE_ID: undefined,
    HUB_URL: undefined,
    UBERBLICK_DB: undefined,
  };
  delete env.WORKSPACE_ID;
  delete env.HUB_URL;
  delete env.UBERBLICK_DB;

  // Resolve the fallback and the independently expected database before the
  // control project, its MCP entry, or any agent child exists.
  const local = localWorkspaceContext(ub, workspace, env);
  const runs = Number(values.runs ?? 3);
  if (!Number.isInteger(runs) || runs < 2) throw new Error("--runs must be an integer of at least 2");
  const timeoutMs = Number(values["timeout-ms"] ?? 900_000);
  const root = values.root === undefined ? mkdtempSync(join(tmpdir(), "ub-947-")) : resolve(values.root);
  mkdirSync(root, { recursive: true });

  const results = join(root, "results");
  mkdirSync(results, { recursive: true });
  env.PATH = `${dirname(ub)}:${process.env.PATH ?? ""}`;
  env.PROBER_RESULTS = results;

  const control = makeControl(root, ub, workspace, env);
  assertExpectedDatabaseAbsent(control, local.database);
  const expected = { project: PROJECT, workspace, database: local.database };
  const seen = new Set();
  const reduction = {
    issue: 947,
    fixture: basename(new URL(import.meta.url).pathname),
    recorded: new Date().toISOString(),
    ub,
    model: values.model ?? "the project's declared default",
    control,
    workspacePinnedByProjectEntry: workspace,
    workspaceResolvedWithoutProject: local.workspaceResolvedWithoutProject,
    databaseExpectedFromLocalWorkspace: local.database,
    databaseAbsentFromControlProject: true,
    runs: [],
  };

  return (async () => {
    for (let index = 1; index <= runs; index += 1) {
      const before = new Set(readdirSync(results));
      const launched = await launchOnce(ub, control, values.model, env, timeoutMs);
      const fresh = readdirSync(results).filter((name) => !before.has(name));
      const file = fresh.length === 1 ? join(results, fresh[0]) : undefined;
      let result = null;
      try {
        result = file === undefined ? null : JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        result = { parseFailure: error instanceof Error ? error.message : String(error) };
      }
      const verdict = validateRun({ result, file, expected, seen });
      if (verdict.ok) seen.add(verdict.run);
      reduction.runs.push({
        index,
        exit: launched.status,
        signal: launched.signal,
        // The launcher's own startup line: which project it says it ran.
        startupLine: launched.stdout.split(/\r?\n/).find((line) => line.startsWith("ub agents launch:")) ?? null,
        idleLine: launched.stdout.split(/\r?\n/).find((line) => line.startsWith("work:")) ?? null,
        freshResultFiles: fresh,
        result,
        ok: verdict.ok,
        problems: verdict.problems,
      });
    }
    reduction.repeatable = reduction.runs.every((entry) => entry.ok) && seen.size === runs;
    const out = values.out === undefined ? join(root, "947-repeat-launch-evidence.json") : resolve(values.out);
    write(out, `${JSON.stringify(reduction, null, 2)}\n`);
    process.stdout.write(`${out}\n`);
    if (!reduction.repeatable) {
      process.stdout.write(`${JSON.stringify(reduction.runs.filter((entry) => !entry.ok), null, 2)}\n`);
      process.exitCode = 1;
    }
    if (values.root === undefined && reduction.repeatable) rmSync(root, { recursive: true, force: true });
  })();
}

const { values } = parseArgs({
  options: {
    ub: { type: "string" },
    workspace: { type: "string" },
    runs: { type: "string" },
    model: { type: "string" },
    root: { type: "string" },
    out: { type: "string" },
    "timeout-ms": { type: "string" },
    "self-test": { type: "boolean" },
  },
  strict: true,
});

if (values["self-test"] === true) {
  selfTest();
} else if (values.ub === undefined || values.workspace === undefined) {
  throw new Error(
    "usage: 947-repeat-launch-fixture.mjs --ub <installed-ub> --workspace <uuid> [--runs N] [--model claude|codex] [--root <dir>] [--out <file>] | --self-test",
  );
} else {
  await liveRun(values);
}
