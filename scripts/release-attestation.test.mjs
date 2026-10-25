import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("release verification constrains the signed workflow, tag and source commit and fails closed", () => {
  const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(),
    `release-attestation-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  try {
    const gh = join(scratch, "gh");
    const log = join(scratch, "gh.json");
    writeFileSync(gh, `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.ATTEST_TEST_EXIT));
`);
    chmodSync(gh, 0o755);
    for (const [workflow, tag, subject] of [
      ["release-hub.yml", "hub-v1.2.3", `oci://ghcr.io/uberblick-ai/hub@sha256:${"b".repeat(64)}`],
      ["release-homebrew.yml", "v1.2.3", join(scratch, "uberblick-1.2.3.tar.gz")],
    ]) {
      for (const exitCode of [0, 1]) {
        const result = spawnSync(process.execPath, ["scripts/release-attestation.mjs", workflow, tag, "a".repeat(40), subject],
          { env: { ...process.env, PATH: scratch, ATTEST_TEST_EXIT: String(exitCode) }, encoding: "utf8", timeout: 10_000 });
        assert.equal(result.status, exitCode, result.stderr);
        if (exitCode) assert.match(result.stderr, /No verified release provenance.*use a new version/);
        assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), ["attestation", "verify", subject,
          "--repo", "uberblick-ai/uberblick-2", "--signer-workflow", `uberblick-ai/uberblick-2/.github/workflows/${workflow}`,
          "--source-ref", `refs/tags/${tag}`, "--source-digest", "a".repeat(40)]);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("only publishing jobs can attest and only this run's newly built subjects reach the actions", {
  skip: existsSync(".github/workflows") ? undefined : "workflows absent from review context",
}, () => {
  const privileged = [];
  for (const file of readdirSync(".github/workflows").filter((file) => /\.ya?ml$/.test(file))) {
    const body = readFileSync(join(".github/workflows", file), "utf8");
    assert.doesNotMatch(body.split(/^jobs:/m)[0], /id-token: write|attestations: write/);
    const jobs = [...body.matchAll(/^ {2}([\w-]+):\n([\s\S]*?)(?=^ {2}[\w-]+:|$(?![\s\S]))/gm)];
    for (const [, job, text] of jobs) {
      if (/id-token: write|attestations: write/.test(text)) {
        privileged.push(`${file}/${job}`);
        assert.match(text, /contents: read/);
        assert.match(text, /id-token: write/);
        assert.match(text, /attestations: write/);
      }
    }
  }
  assert.deepEqual(privileged.sort(), ["release-homebrew.yml/publish", "release-hub.yml/publish"]);
  for (const [file, count] of [["release-homebrew.yml", 1], ["release-hub.yml", 2]]) {
    const body = readFileSync(join(".github/workflows", file), "utf8");
    const condition = "if: steps.publish.outputs.outcome == 'published'" +
      (file === "release-homebrew.yml" ? " && steps.publish.outputs.archive != ''" : "");
    const workflowSteps = body.split(/^\s*- (?=[\w-]+:)/m);
    const steps = workflowSteps.filter((step) => /uses: actions\/attest-build-provenance@/.test(step));
    assert.equal(steps.length, count);
    for (const step of steps) {
      assert.equal(step.split("\n").find((line) => line.trim().startsWith("if:"))?.trim(), condition);
      assert.match(step, /uses: actions\/attest-build-provenance@[0-9a-f]{40} # v/);
      assert.doesNotMatch(step, /continue-on-error:|push-to-registry: true/);
    }
    const verify = workflowSteps.find((step) => /^name: Verify/.test(step));
    assert.ok(verify);
    assert.equal(verify.split("\n").find((line) => line.trim().startsWith("if:"))?.trim(), condition);
    assert.match(verify, /\bnode scripts\/release-attestation\.mjs\b/);
    assert.doesNotMatch(body, /continue-on-error:/);
  }
});
