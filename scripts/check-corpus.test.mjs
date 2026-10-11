import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supervisor = join(root, "scripts/check-corpus.py");
const helper = join(root, "scripts/check-corpus.mjs");
const server = join(root, "scripts/fixtures/corpus-health-server.mjs");
const pythonResult = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
	encoding: "utf8",
});
assert.equal(pythonResult.status, 0, pythonResult.stderr);
const python = pythonResult.stdout.trim();
const pins = [
	{ uuid: "30b5ed33-e4d1-4c61-841c-3ce1ec289d5f", title: "Synthetic start", status: "archived" },
	{ uuid: "741ccbee-b44e-4d5f-8493-71fae36b6530", title: "Synthetic guide", status: "unknown" },
];

function fixture(t, options = {}) {
	const base = realpathSync(mkdtempSync(join(
		tmpdir(),
		`corpus-health-${process.env.UB_AGENTS_RUN ?? "local"}-`,
	)));
	const bin = join(base, "bin");
	mkdirSync(bin);
	const config = {
		cliPackage: join(root, "packages/cli/package.json"),
		events: join(base, "events.jsonl"),
		pins,
		mode: "healthy",
		probeTimeout: 5000,
		...options,
	};
	if (config.descendant) config.descendant = join(base, "descendant.pid");
	const configPath = join(base, "fixture.json");
	writeFileSync(configPath, JSON.stringify(config));
	const code = `import { checkCorpus } from ${JSON.stringify(pathToFileURL(helper).href)};
const failure = await checkCorpus(${config.probeTimeout});
if (failure) { process.stderr.write(failure + "\\n"); process.exitCode = 1; }`;
	writeFileSync(join(bin, "mise"), `#!${python}
import json, os, signal, sys, time
config = json.load(open(os.environ["CORPUS_TEST_CONFIG"]))
args = sys.argv[1:]
with open(config["events"], "a") as events:
 events.write(json.dumps({"mise": args}) + "\\n")
if config["mode"] == "mise-hang":
 signal.signal(signal.SIGTERM, signal.SIG_IGN)
 while True: time.sleep(1)
if args[:3] == ["exec", "--", "node"]:
 os.execv(${JSON.stringify(process.execPath)}, [${JSON.stringify(process.execPath)}, "--input-type=module", "-e", ${JSON.stringify(code)}])
if args == ["exec", "--", "ub", "mcp", "serve"]:
 if config["mode"] == "route-start-failed":
  sys.stderr.write("synthetic route startup failed\\n")
  sys.exit(27)
 os.execv(${JSON.stringify(process.execPath)}, [${JSON.stringify(process.execPath)}, ${JSON.stringify(server)}, os.environ["CORPUS_TEST_CONFIG"]])
sys.stderr.write("unexpected synthetic mise argv\\n")
sys.exit(28)
`, { mode: 0o755 });
	const env = {
		HOME: base,
		PATH: `${bin}:/usr/bin:/bin:${dirname(process.execPath)}`,
		TMPDIR: base,
		CORPUS_TEST_CONFIG: configPath,
		CORPUS_TEST_MARKER: "synthetic-inherited-marker",
	};
	t.after(() => {
		if (config.descendant && existsSync(config.descendant)) {
			try { process.kill(Number(readFileSync(config.descendant, "utf8")), "SIGKILL"); }
			catch (error) { if (error.code !== "ESRCH") throw error; }
		}
		rmSync(base, { recursive: true, force: true });
	});
	return { base, config, env };
}

function invoke(f, timeoutSeconds = 5, env = f.env) {
	const result = spawnSync(python, [
		"-c",
		`import runpy, sys; sys.exit(runpy.run_path(sys.argv[1])["main"](${timeoutSeconds}))`,
		supervisor,
	], { cwd: f.base, env, encoding: "utf8", timeout: 10_000 });
	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.signal, null, result.stderr);
	return result;
}

function events(f) {
	return readFileSync(f.config.events, "utf8").trim().split("\n").map(JSON.parse);
}

function lastReason(result) {
	assert.equal(result.status, 1, result.stderr);
	const lines = result.stderr.trim().split("\n");
	assert.equal(lines.length, 1, result.stderr);
	assert.match(lines[0], /^corpus health check: /);
	return lines[0];
}

async function assertDescendantStopped(f) {
	assert.ok(existsSync(f.config.descendant), "synthetic descendant started");
	const pid = Number(readFileSync(f.config.descendant, "utf8"));
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try { process.kill(pid, 0); }
		catch (error) {
			assert.equal(error.code, "ESRCH");
			return;
		}
		await delay(10);
	}
	assert.fail("corpus route left its synthetic descendant alive");
}

test("four corpus-reading roles share the same health check and integrator stays exempt", () => {
	const config = readFileSync(join(root, "ub-agents.yaml"), "utf8");
	for (const role of ["issue-preparer", "issue-reviewer", "implementer", "pr-reviewer", "integrator"]) {
		const body = config.match(new RegExp(`^  ${role}:\\n((?: {4}.*\\n|\\n)*)`, "m"))?.[1];
		assert.ok(body, role);
		if (role === "integrator") assert.doesNotMatch(body, /health-check:/);
		else if (role === "issue-preparer") {
			assert.match(body, /health-check: &corpus-health \[python3, scripts\/check-corpus\.py\]/);
		} else assert.match(body, /health-check: \*corpus-health/);
	}
});

for (const hub of ["connected", "hub-down", "auth-failed"]) {
	test(`reads every sidebar pin through the configured route when hub is ${hub}`, (t) => {
		const f = fixture(t, { hub });
		const result = invoke(f);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		const observed = events(f);
		assert.deepEqual(observed.filter((event) => event.mise).map((event) => event.mise), [
			["exec", "--", "node", helper],
			["exec", "--", "ub", "mcp", "serve"],
		]);
		assert.deepEqual(observed.filter((event) => event.tool), [
			{ tool: "get_sidebar", arguments: {} },
			...pins.map((pin) => ({ tool: "get_doc", arguments: { uuid: pin.uuid } })),
		]);
		assert.ok(observed.some((event) => event.cwd === f.base && event.marker === "synthetic-inherited-marker"));
	});
}

test("a missing mise gives a startup reason without opening a corpus route", (t) => {
	const f = fixture(t);
	assert.match(lastReason(invoke(f, 5, { ...f.env, PATH: join(f.base, "missing") })), /cannot start mise:/);
	assert.equal(existsSync(f.config.events), false);
});

test("a route startup failure retains its own diagnostic", (t) => {
	const f = fixture(t, { mode: "route-start-failed" });
	assert.match(lastReason(invoke(f)), /starting or initializing.*synthetic route startup failed/);
});

test("a refused initialize fails even when shutdown writes a later diagnostic", (t) => {
	const f = fixture(t, { mode: "initialize-refused" });
	const reason = lastReason(invoke(f));
	assert.match(reason, /starting or initializing.*synthetic initialization refused/);
	assert.doesNotMatch(reason, /late shutdown/);
});

test("an empty sidebar fails without reading documents", (t) => {
	const f = fixture(t, { mode: "no-pins" });
	assert.match(lastReason(invoke(f)), /sidebar pins no document/);
	assert.deepEqual(events(f).filter((event) => event.tool).map((event) => event.tool), ["get_sidebar"]);
});

test("an isError pin refusal names its title and UUID after shutdown finishes", (t) => {
	const f = fixture(t, { mode: "document-refused" });
	const reason = lastReason(invoke(f));
	assert.ok(reason.includes(pins[1].title), reason);
	assert.ok(reason.includes(pins[1].uuid), reason);
	assert.match(reason, /doc_not_hydrated/);
	assert.doesNotMatch(reason, /late shutdown/);
});

test("a successful tool reply for another document fails the pinned read", (t) => {
	const f = fixture(t, { mode: "wrong-document" });
	const reason = lastReason(invoke(f));
	assert.ok(reason.includes(pins[1].uuid), reason);
	assert.match(reason, /invalid document result/);
});

for (const mode of ["initialize-hang", "document-hang"]) {
	test(`${mode} reaches the probe's own deadline`, (t) => {
		const f = fixture(t, { mode, probeTimeout: 1500 });
		const reason = lastReason(invoke(f));
		assert.match(reason, /timed out after 1\.5s/);
		if (mode === "document-hang") assert.ok(reason.includes(pins[1].uuid), reason);
	});
}

test("the supervisor deadlines mise before the JavaScript probe can start", (t) => {
	const f = fixture(t, { mode: "mise-hang" });
	const start = performance.now();
	assert.match(lastReason(invoke(f, 0.15)), /route or probe shutdown timed out after 0\.15s/);
	assert.ok(performance.now() - start < 5000, "supervisor exited before launcher timeout");
});

test("successful cleanup kills a descendant that ignores EOF and SIGTERM", async (t) => {
	const f = fixture(t, { descendant: true });
	const result = invoke(f);
	assert.equal(result.status, 0, result.stderr);
	await assertDescendantStopped(f);
});

test("deadline cleanup kills descendants while retaining the supervisor's reason", async (t) => {
	const f = fixture(t, { mode: "initialize-hang", descendant: true, probeTimeout: 10_000 });
	assert.match(lastReason(invoke(f, 1.5)), /route or probe shutdown timed out after 1\.5s/);
	await assertDescendantStopped(f);
});
