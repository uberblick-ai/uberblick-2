import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { assertImage, imageRefs, publishHubRelease, versionForTag } from "./publish-hub-release.mjs";

const SHA = "a".repeat(40);
const TAG = "hub-v1.2.3";
function input(overrides = {}) {
  return { tag: TAG, dryRun: false, headSha: SHA, protocolVersion: 1,
    repository: "uberblick-ai/uberblick-2", eventName: "push", actorType: "User",
    refType: "tag", refName: TAG, tagSha: SHA, workflowSha: SHA, ...overrides };
}
function image(revision = SHA) {
  return { Os: "linux", Architecture: "amd64", Config: { Labels: {
    "org.opencontainers.image.version": "1.2.3", "org.opencontainers.image.revision": revision,
    "io.uberblick.sync-protocol-version": "1",
  } } };
}
function services(overrides = {}) {
  const calls = [];
  return { calls,
    assertRemoteTag: async () => { calls.push("tag"); },
    getImage: async (ref) => { calls.push(`read ${ref}`); return null; },
    buildImages: async () => { calls.push("build"); },
    inspectLocalImage: async () => { calls.push("inspect"); return image(); },
    scanImage: async () => { calls.push("scan"); },
    pushImage: async (ref) => { calls.push(`push ${ref}`); },
    log: () => {}, ...overrides,
  };
}

test("hub/client version numbers and tag triggers are disjoint", () => {
  assert.equal(versionForTag(TAG), "1.2.3");
  for (const tag of ["v1.2.3", "hub-v01.2.3", "hub-v1.2.3-rc", "hub-v1.2", "hub-v1x2x3"]) {
    assert.throws(() => versionForTag(tag), /exactly hub-v/);
  }
});

test("only a person's matching tag push admits publication", async () => {
  for (const override of [{actorType: "Bot"}, {eventName: "workflow_dispatch"}, {refType: "branch"},
    {refName: "v1.2.3"}, {workflowSha: "b".repeat(40)}, {tagSha: "b".repeat(40)}, {repository: "other/repo"}]) {
    const fake = services();
    await assert.rejects(publishHubRelease(input(override), fake), /person's matching/);
    assert.deepEqual(fake.calls, []);
  }
});

test("both images build, pass platform/metadata and layer scans before either push", async () => {
  const fake = services();
  const refs = imageRefs("1.2.3");
  assert.equal((await publishHubRelease(input(), fake)).outcome, "published");
  assert.deepEqual(fake.calls, ["tag", ...refs.map((ref) => `read ${ref}`), "build",
    "inspect", "scan", "inspect", "scan", "tag", ...refs.map((ref) => `read ${ref}`),
    ...refs.map((ref) => `push ${ref}`)]);
});

test("an unchanged published version is a no-op without rebuilding or pushing", async () => {
  const fake = services({ getImage: async () => image() });
  assert.equal((await publishHubRelease(input(), fake)).outcome, "no-op");
  assert.deepEqual(fake.calls, ["tag"]);
});

test("moved tags and partial publications refuse before building or publishing", async () => {
  for (const [existing, message] of [[image("b".repeat(40)), /disagrees/], [image(), /partial/]]) {
    let n = 0;
    const fake = services({ getImage: async () => n++ === 0 ? existing : null });
    await assert.rejects(publishHubRelease(input(), fake), message);
    assert.deepEqual(fake.calls, ["tag"]);
  }
});

test("registry lookup errors never become permission to publish", async () => {
  const fake = services({ getImage: async () => { throw new Error("registry unavailable"); } });
  await assert.rejects(publishHubRelease(input(), fake), /registry unavailable/);
  assert.deepEqual(fake.calls, ["tag"]);
});

test("a moved remote tag at the push boundary publishes nothing", async () => {
  let checks = 0;
  const fake = services({ assertRemoteTag: async () => {
    if (++checks === 2) throw new Error("remote tag moved");
  } });
  await assert.rejects(publishHubRelease(input(), fake), /tag moved/);
  assert.ok(fake.calls.includes("build"));
  assert.ok(!fake.calls.some((call) => call.startsWith("push")));
});

test("a failed second image scan publishes neither image", async () => {
  let scans = 0;
  const fake = services({ scanImage: async () => {
    if (++scans === 2) throw new Error("forbidden file");
  } });
  await assert.rejects(publishHubRelease(input(), fake), /forbidden file/);
  assert.ok(!fake.calls.some((call) => call.startsWith("push")));
});

test("metadata and platform mismatches cannot be published", () => {
  for (const bad of [{ ...image(), Architecture: "arm64" }, { ...image(), Os: "windows" },
    { ...image(), Config: { Labels: {} } }]) assert.throws(() => assertImage(bad, input()), /disagrees/);
});

test("a dry run builds and scans without any registry read, credential or push", async () => {
  const fake = services();
  assert.equal((await publishHubRelease(input({dryRun: true, repository: undefined}), fake)).outcome, "dry-run");
  assert.deepEqual(fake.calls, ["build", "inspect", "scan", "inspect", "scan"]);
});

test("workflow has only the human hub tag push trigger and the scoped workflow token", {
  skip: existsSync(".github/workflows/release-hub.yml") ? undefined : "workflow files absent from review context",
}, () => {
  const body = readFileSync(".github/workflows/release-hub.yml", "utf8");
  assert.match(body, /^on:\n {2}push:\n {4}tags:\n {6}- "hub-v/m);
  assert.doesNotMatch(body, /schedule:|workflow_dispatch:|branches:|pull_request:/);
  assert.match(body, /github.event.sender.type == 'User'/);
  assert.match(body, /packages: write/);
  assert.match(body, /secrets.GITHUB_TOKEN/);
  assert.doesNotMatch(body, /HOMEBREW_TAP_TOKEN|:latest/);
  const homebrew = readFileSync(".github/workflows/release-homebrew.yml", "utf8");
  assert.doesNotMatch(homebrew, /hub-v/);
});
