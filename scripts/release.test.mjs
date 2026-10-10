import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUIRED_CHECKS, release } from "./release.mjs";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const TAG = "v0.5.0";
const HUB_TAG = "hub-v0.5.0";
const PREVIOUS_TAG = "v0.4.0";
const CLIENT_WORKFLOW = "release-homebrew.yml";
const HUB_WORKFLOW = "release-hub.yml";
const CLIENT_JOB = "Publish payload and tap formula";
const CLIENT_STEP = "Publish the immutable release and generated formula";
const HUB_STEP = "Build, scan and publish the immutable hub version";

function check(name, conclusion = "success", id = 2, overrides = {}) {
  return { name, status: "completed", conclusion, id, app: { slug: "github-actions" }, ...overrides };
}

function green(id = 2) {
  return REQUIRED_CHECKS.map((name) => check(name, "success", id));
}

function run(tag = TAG, overrides = {}) {
  return {
    databaseId: tag === TAG ? 1 : 2,
    headSha: SHA,
    headBranch: tag,
    event: "push",
    status: "completed",
    conclusion: "success",
    url: `https://github.test/actions/runs/${tag === TAG ? 1 : 2}`,
    ...overrides,
  };
}

function job(tag = TAG, overrides = {}) {
  return {
    name: tag === TAG ? CLIENT_JOB : "publish",
    conclusion: "success",
    steps: [{ name: tag === TAG ? CLIENT_STEP : HUB_STEP, conclusion: "success" }],
    ...overrides,
  };
}

function services(overrides = {}) {
  const calls = [];
  const output = [];
  let time = 0;
  return {
    calls,
    output,
    timeoutMs: 100,
    fetchMain: async () => { calls.push(["fetchMain"]); return SHA; },
    head: async () => SHA,
    remoteTags: async () => [{ name: PREVIOUS_TAG, sha: OTHER_SHA }],
    previousTag: async () => PREVIOUS_TAG,
    checkRuns: async (sha) => { calls.push(["checkRuns", sha]); return green(); },
    withCandidate: async (sha, callback) => {
      calls.push(["candidate", sha]);
      try {
        return await callback({
          dryRun: async (task, tag) => { calls.push(["dryRun", task, tag, sha]); },
        });
      } finally {
        calls.push(["cleanup", sha]);
      }
    },
    mergedPrs: async (tag, sha) => {
      calls.push(["notes", tag, sha]);
      return [
        { number: 1470, title: "Show the release identity" },
        { number: 1462, title: "Fix missing reconnect state" },
        { number: 1459, title: "Breaking change: remove legacy deployment flags" },
      ];
    },
    pushTags: async (sha, tags) => { calls.push(["push", sha, tags]); },
    runs: async (tag, workflow, sha) => {
      calls.push(["runs", tag, workflow, sha]);
      return [run(tag)];
    },
    jobs: async (candidateRun) => {
      calls.push(["jobs", candidateRun.databaseId]);
      return [job(candidateRun.headBranch)];
    },
    now: () => time,
    wait: async () => { time += 25; },
    log: (line) => { output.push(line); },
    ...overrides,
  };
}

function pushed(fake) {
  return fake.calls.filter(([name]) => name === "push");
}

function assertBeforeCandidate(fake) {
  assert.equal(pushed(fake).length, 0);
  assert.equal(fake.calls.filter(([name]) => name === "candidate").length, 0);
}

test("an invalid release version refuses before any candidate or publication", async () => {
  for (const tag of ["0.5.0", "hub-v0.5.0", "v00.5.0", "v0.5", "v0.5.0-rc.1"]) {
    const fake = services();
    await assert.rejects(release(tag, fake), /vMAJOR\.MINOR\.PATCH/);
    assertBeforeCandidate(fake);
  }
});

test("either existing origin tag refuses and names that tag", async () => {
  for (const tag of [TAG, HUB_TAG]) {
    const fake = services({ remoteTags: async () => [{ name: tag, sha: OTHER_SHA }] });
    await assert.rejects(release(TAG, fake), (error) => error.message.includes(tag));
    assertBeforeCandidate(fake);
  }
});

test("a checkout not at freshly fetched main refuses before the dry runs", async () => {
  const fake = services({ head: async () => OTHER_SHA });
  await assert.rejects(release(TAG, fake), /origin\/main/);
  assertBeforeCandidate(fake);
});

test("a missing, failed or unfinished required check refuses and advisory e2e never substitutes", async () => {
  const [tests, macos] = REQUIRED_CHECKS;
  for (const runs of [[], [check(tests)], [check(tests), check(macos, "failure")],
    [check(tests), check(macos, null, 2, { status: "in_progress" })],
    [check(tests), check("browser e2e"), check("macOS browser e2e")],
    [...green(), check(macos, "failure", 3)]]) {
    const fake = services({ checkRuns: async () => runs });
    await assert.rejects(release(TAG, fake), /CI at .* is not green/);
    assertBeforeCandidate(fake);
  }
});

test("a check with a required name from another app never counts", async () => {
  const fake = services({ checkRuns: async () => green().map((run) => ({ ...run, app: { slug: "someone-else" } })) });
  await assert.rejects(release(TAG, fake), /missing/);
  assertBeforeCandidate(fake);
});

test("a newest successful re-run wins over an earlier failure regardless of API order", async () => {
  const runs = [check(REQUIRED_CHECKS[0], "failure", 1), ...green()];
  for (const entries of [runs, [...runs].reverse()]) {
    const fake = services({ checkRuns: async () => entries });
    await release(TAG, fake);
    assert.equal(pushed(fake).length, 1);
  }
});

test("both dry runs use the isolated candidate SHA before both refs are sent in one push", async () => {
  const fake = services();
  await release(TAG, fake);
  assert.deepEqual(fake.calls.filter(([name]) => name === "dryRun"), [
    ["dryRun", "publish-homebrew-release", TAG, SHA],
    ["dryRun", "publish-hub-release", HUB_TAG, SHA],
  ]);
  assert.deepEqual(pushed(fake), [["push", SHA, [TAG, HUB_TAG]]]);
  const pushIndex = fake.calls.findIndex(([name]) => name === "push");
  assert.ok(fake.calls.findIndex(([name]) => name === "cleanup") < pushIndex);
  assert.equal(fake.calls.filter(([name]) => name === "fetchMain").length, 2);
  assert.equal(fake.calls.filter(([name]) => name === "checkRuns").length, 2);
});

test("either dry-run failure cleans the isolated candidate and creates no tags", async () => {
  for (const failedTask of ["publish-homebrew-release", "publish-hub-release"]) {
    let cleaned = false;
    const fake = services({
      withCandidate: async (sha, callback) => {
        assert.equal(sha, SHA);
        try {
          return await callback({ dryRun: async (task) => {
            if (task === failedTask) throw new Error(`${task} failed`);
          } });
        } finally { cleaned = true; }
      },
    });
    await assert.rejects(release(TAG, fake), (error) => error.message.includes(failedTask));
    assert.ok(cleaned);
    assert.deepEqual(pushed(fake), []);
  }
});

test("main, tag or CI changes during the dry runs refuse before the atomic push", async () => {
  for (const changed of ["main", "tags", "ci"]) {
    let fetches = 0;
    let tagReads = 0;
    let checkReads = 0;
    const fake = services({
      fetchMain: async () => ++fetches === 2 && changed === "main" ? OTHER_SHA : SHA,
      remoteTags: async () => ++tagReads === 2 && changed === "tags"
        ? [{ name: HUB_TAG, sha: OTHER_SHA }] : [],
      checkRuns: async () => ++checkReads === 2 && changed === "ci"
        ? [...green(), check(REQUIRED_CHECKS[1], "failure", 3)] : green(),
    });
    await assert.rejects(release(TAG, fake), /origin\/main|hub-v0\.5\.0|CI at/);
    assert.ok(fake.calls.some(([name]) => name === "dryRun"));
    assert.deepEqual(pushed(fake), []);
  }
});

test("release-note lookup failure creates no tags", async () => {
  const fake = services({ mergedPrs: async () => { throw new Error("PR lookup unavailable"); } });
  await assert.rejects(release(TAG, fake), /PR lookup unavailable/);
  assert.deepEqual(pushed(fake), []);
});

test("failed atomic push never starts watching publication", async () => {
  const fake = services({ pushTags: async () => { throw new Error("atomic push rejected"); } });
  await assert.rejects(release(TAG, fake), /atomic push rejected/);
  assert.equal(fake.calls.filter(([name]) => name === "runs").length, 0);
});

test("success requires both exact tag-push runs and their executed publishing jobs", async () => {
  const fake = services();
  await release(TAG, fake);
  assert.deepEqual(fake.calls.filter(([name]) => name === "runs"), [
    ["runs", TAG, CLIENT_WORKFLOW, SHA],
    ["runs", HUB_TAG, HUB_WORKFLOW, SHA],
  ]);
  assert.deepEqual(fake.calls.filter(([name]) => name === "jobs"), [["jobs", 1], ["jobs", 2]]);
});

test("a failed or skipped hub run names its run and the successfully published client", async () => {
  for (const conclusion of ["failure", "cancelled", "skipped"]) {
    const fake = services({ runs: async (tag) => [run(tag, { conclusion: tag === HUB_TAG ? conclusion : "success" })] });
    await assert.rejects(release(TAG, fake), (error) => {
      assert.match([...fake.output, error.message].join("\n"), /Publish hub release/);
      assert.match(error.message, /https:\/\/github\.test\/actions\/runs\/2/);
      assert.match(error.message, /Homebrew.*published|client.*published/i);
      return true;
    });
  }
});

test("a failed client run reports a successfully published hub as the other half", async () => {
  const fake = services({ runs: async (tag) => [run(tag, { conclusion: tag === TAG ? "failure" : "success" })] });
  await assert.rejects(release(TAG, fake), (error) => {
    assert.match([...fake.output, error.message].join("\n"), /Publish Homebrew release/);
    assert.match(error.message, /https:\/\/github\.test\/actions\/runs\/1/);
    assert.match(error.message, /hub images: published/);
    return true;
  });
});

test("failure waits for the other half's terminal result so publication reporting is complete", async () => {
  let clientPolls = 0;
  const fake = services({ runs: async (tag) => {
    if (tag === HUB_TAG) return [run(tag, { conclusion: "failure" })];
    return [run(tag, ++clientPolls === 1 ? { status: "in_progress", conclusion: null } : {})];
  } });
  await assert.rejects(release(TAG, fake), /Homebrew.*published|client.*published/i);
  assert.equal(clientPolls, 2);
});

test("workflow success cannot hide a missing, skipped or failed publishing job", async () => {
  for (const hubJobs of [[], [job(HUB_TAG, { conclusion: "skipped" })],
    [job(HUB_TAG, { conclusion: "failure" })], [job(HUB_TAG, { name: "other job" })]]) {
    const fake = services({ jobs: async (candidateRun) => candidateRun.headBranch === HUB_TAG ? hubJobs : [job()] });
    await assert.rejects(release(TAG, fake), /publish|job/i);
  }
});

test("a successful publishing job still requires the named publishing step to have run", async () => {
  for (const tag of [TAG, HUB_TAG]) {
    for (const steps of [[], [{ name: tag === TAG ? CLIENT_STEP : HUB_STEP, conclusion: "skipped" }],
      [{ name: "Unrelated check", conclusion: "success" }]]) {
      const fake = services({ jobs: async (candidateRun) => [job(candidateRun.headBranch,
        candidateRun.headBranch === tag ? { steps } : {})] });
      await assert.rejects(release(TAG, fake), /publish|step/i);
    }
  }
});

test("unrelated SHA, branch and event runs cannot stand in for a tag's publication", async () => {
  for (const mismatch of [{ headSha: OTHER_SHA }, { headBranch: "main" }, { event: "workflow_dispatch" }]) {
    let clientPolls = 0;
    const fake = services({ runs: async (tag) => {
      if (tag === TAG && ++clientPolls === 1) return [run(tag, mismatch)];
      return [run(tag)];
    } });
    await release(TAG, fake);
    assert.equal(clientPolls, 2);
  }
});

test("missing workflow run times out and reports which half did publish", async () => {
  const fake = services({ runs: async (tag) => tag === TAG ? [run(tag)] : [] });
  await assert.rejects(release(TAG, fake), (error) => {
    assert.match([...fake.output, error.message].join("\n"), /Publish hub release/);
    assert.match(error.message, /timed out|timeout/i);
    assert.match(error.message, /Homebrew.*published|client.*published/i);
    return true;
  });
});

test("first hub release reports the manual visibility step, later hub releases omit it", async () => {
  const first = services();
  await release(TAG, first);
  assert.match(first.output.join("\n"), /hub.*hub-web.*public|public.*hub.*hub-web/i);
  const later = services({ remoteTags: async () => [
    { name: PREVIOUS_TAG, sha: OTHER_SHA }, { name: "hub-v0.4.0", sha: OTHER_SHA },
  ] });
  await release(TAG, later);
  assert.doesNotMatch(later.output.join("\n"), /make.*public|visibility.*public/i);
});

test("printed release-note draft contains each merged PR once under heuristic sections", async () => {
  const fake = services();
  await release(TAG, fake);
  assert.deepEqual(fake.calls.filter(([name]) => name === "notes"), [["notes", PREVIOUS_TAG, SHA]]);
  const output = fake.output.join("\n");
  assert.match(output, /Features[\s\S]*(?:Show the release identity.*#1470|#1470.*Show the release identity)/);
  assert.match(output, /Fixes[\s\S]*(?:Fix missing reconnect state.*#1462|#1462.*Fix missing reconnect state)/);
  assert.match(output, /Breaking changes[\s\S]*(?:Breaking change: remove legacy deployment flags.*#1459|#1459.*Breaking change: remove legacy deployment flags)/);
  for (const number of [1470, 1462, 1459]) assert.equal(output.split(`#${number}`).length - 1, 1);
});

test("a repository's first client release requests notes without an invented previous tag", async () => {
  const fake = services({ previousTag: async () => null, remoteTags: async () => [] });
  await release(TAG, fake);
  assert.deepEqual(fake.calls.filter(([name]) => name === "notes"), [["notes", null, SHA]]);
});
