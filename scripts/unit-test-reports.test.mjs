import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = ["cli", "hub", "mcp-server", "schema", "web"];
const vitest = join(root, "packages/schema/node_modules/vitest/vitest.mjs");
const fixture = `
import { describe, expect, test } from ${JSON.stringify(join(root, "packages/schema/node_modules/vitest/dist/index.js"))};
describe("outer <&>", () => {
  describe("nested 'suite'", () => {
    test('passes "<&>"', () => {
      console.log("console text excluded from artifacts");
      expect(2 + 2).toBe(4);
    });
    test("conditional failure", () => {
      if (process.env.REPORT_FIXTURE_FAIL === "true") throw new Error("deliberate <&> failure");
    });
    test.skip("skipped case", () => {});
  });
});
`;

function withScratch(run) {
  const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(),
    `unit-test-reports-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  try {
    run(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runFixture(scratch, name, githubActions, fail = false) {
  const config = join(scratch, "vitest.config.mjs");
  const configUrl = pathToFileURL(join(root, "packages", name, "vitest.config.ts")).href;
  // Keep the package's actual reporter configuration, without its test-specific
  // global setups, web plugins or suite inventory.
  writeFileSync(config, `
import actual from ${JSON.stringify(configUrl)};
export default {
  test: {
    reporters: actual.test.reporters,
    outputFile: actual.test.outputFile,
    silent: actual.test.silent,
    include: ["reporter.test.mjs"],
    environment: "node",
    pool: "threads",
    maxWorkers: 1,
    execArgv: ["--no-experimental-webstorage"],
  },
};
`);
  writeFileSync(join(scratch, "reporter.test.mjs"), fixture);
  const env = {
    ...process.env,
    CI: "true",
    RUNNER_TEMP: scratch,
    REPORT_FIXTURE_FAIL: String(fail),
    NO_COLOR: "1",
  };
  delete env.GITHUB_ACTIONS;
  delete env.VITEST_MAX_WORKERS;
  if (githubActions) env.GITHUB_ACTIONS = "true";
  const result = spawnSync(process.execPath, [vitest, "run", "--config", config], {
    cwd: scratch, env, encoding: "utf8", timeout: 30_000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, fail ? 1 : 0, output);
  assert.match(output, /·/, "the dot reporter remains visible");
  return join(scratch, "vitest-results", `${name}.xml`);
}

function readReport(path) {
  // Use a standard XML parser so escaping and nested failures are validated as
  // consumers see them, rather than duplicating JUnit parsing in this test.
  const result = spawnSync("python3", ["-c", `
import json, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
print(json.dumps([
    {"file": suite.attrib["name"], "name": case.attrib["name"],
     "time": float(case.attrib["time"]),
     "skipped": case.find("skipped") is not None,
     "failure": "".join(case.find("failure").itertext()) if case.find("failure") is not None else None}
    for suite in root.findall("testsuite") for case in suite.findall("testcase")
]))
`, path], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("each package's GitHub reporter retains names, files, durations and failure results", () => {
  for (const name of packages) {
    withScratch((scratch) => {
      const fail = name === "schema";
      const path = runFixture(scratch, name, true, fail);
      assert.ok(existsSync(path), `${name} emits its own report`);
      const cases = readReport(path);
      assert.deepEqual(cases.map((entry) => entry.name), [
        'outer <&> > nested \'suite\' > passes "<&>"',
        "outer <&> > nested 'suite' > conditional failure",
        "outer <&> > nested 'suite' > skipped case",
      ]);
      for (const entry of cases) {
        assert.equal(entry.file, "reporter.test.mjs");
        assert.ok(Number.isFinite(entry.time) && entry.time >= 0);
      }
      assert.equal(cases[0].failure, null);
      assert.equal(cases[0].skipped, false);
      assert.equal(cases[2].skipped, true);
      if (fail) assert.match(cases[1].failure, /deliberate <&> failure/);
      else assert.equal(cases[1].failure, null);
      assert.doesNotMatch(readFileSync(path, "utf8"), /system-out|system-err|console text excluded/);
    });
  }
});

test("CI=true outside GitHub Actions creates no report", () => {
  for (const name of packages) {
    withScratch((scratch) => {
      runFixture(scratch, name, false);
      assert.equal(existsSync(join(scratch, "vitest-results")), false, `${name} leaves no report directory`);
    });
  }
});

const workflowPath = join(root, ".github/workflows/ci.yml");
test("report uploads isolate each Linux job and attempt without changing test conclusions", {
  skip: existsSync(workflowPath) ? undefined : ".github/workflows is absent from the isolated review context",
}, () => {
  const workflow = readFileSync(workflowPath, "utf8");
  for (const [job, testId, artifact] of [
    ["unit-tests", "test-packages", `vitest-Linux-\${{ matrix.id }}-\${{ github.run_id }}-attempt-\${{ github.run_attempt }}`],
    ["macos", "test-macos", `vitest-\${{ runner.os }}-\${{ github.run_id }}-attempt-\${{ github.run_attempt }}`],
  ]) {
    const body = workflow.match(new RegExp(`^ {2}${job}:\\n((?: {4}.*\\n|\\n)*)`, "m"))?.[0];
    assert.ok(body, `${job} runs test suites`);
    assert.doesNotMatch(body, /^ {4}continue-on-error:/m);
    const steps = body.split(/^ {6}- /m).slice(1);
    const uploads = steps.filter((step) => step.includes("uses: actions/upload-artifact@"));
    assert.equal(uploads.length, 1, `${job} uploads its own per-test reports`);
    const [upload] = uploads;
    const step = steps.find((entry) => entry.includes(`id: ${testId}\n`));
    assert.ok(step, `${testId} has an observable outcome`);
    assert.ok(steps.indexOf(step) < steps.indexOf(upload), "upload follows the package test step");
    assert.doesNotMatch(step, /continue-on-error:/, "package failures still fail their check");
    assert.equal(upload.match(/^ {8}if: (.+)$/m)?.[1],
      `\${{ always() && (steps.${testId}.outcome == 'success' || steps.${testId}.outcome == 'failure') }}`,
      "uploads remain eligible after a failed test step");
    assert.match(upload, /^ {8}continue-on-error: true$/m);
    assert.match(upload, /^ {8}timeout-minutes: 1$/m);
    assert.match(upload, /^ {8}uses: actions\/upload-artifact@[a-f0-9]{40}(?: #.*)?$/m);
    assert.equal(upload.match(/^ {10}name: (.+)$/m)?.[1], artifact);
    assert.match(upload, /^ {10}path: \$\{\{ runner.temp \}\}\/vitest-results\/$/m);
    assert.doesNotMatch(upload, /^ {10}overwrite: true$/m);
  }
});
