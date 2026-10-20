import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { publishHubReleaseAssets } from "./publish-hub-release-assets.mjs";

const SHA = "a".repeat(40);
const TAG = "hub-v1.2.3";
const ASSETS = Object.fromEntries(["compose.yml", "remote.env.example", "remote.https.yml", "remote.tailscale.yml"]
  .map((name) => [name, Buffer.from(`${name}\n`)]));

function input(overrides = {}) {
  return { tag: TAG, headSha: SHA, protocolVersion: 1, assets: ASSETS,
    repository: "uberblick-ai/uberblick-2", eventName: "push", eventDeleted: false,
    actorType: "User", actorLogin: "bk-one", refType: "tag", refName: TAG,
    tagSha: SHA, workflowSha: SHA, ...overrides };
}

function image(revision = SHA) {
  return { Os: "linux", Architecture: "amd64", Config: { Labels: {
    "org.opencontainers.image.version": "1.2.3", "org.opencontainers.image.revision": revision,
    "io.uberblick.sync-protocol-version": "1",
  } } };
}

function asset(name, overrides = {}) {
  return { name, state: "uploaded", size: ASSETS[name].length,
    browser_download_url: `https://github.com/uberblick-ai/uberblick-2/releases/download/${TAG}/${name}`,
    ...overrides };
}

function release(overrides = {}) {
  return { id: 1, tag_name: TAG, target_commitish: SHA, draft: false, prerelease: false,
    upload_url: "https://uploads.github.com/releases/1/assets{?name,label}",
    assets: Object.keys(ASSETS).map((name) => asset(name)), ...overrides };
}

function services(overrides = {}) {
  const calls = [];
  return { calls,
    assertRemoteTag: async () => { calls.push("tag"); },
    getImage: async (ref) => { calls.push(`image ${ref}`); return image(); },
    getRelease: async () => { calls.push("release"); return null; },
    downloadAsset: async (url) => { calls.push(`download ${url.split("/").at(-1)}`); return ASSETS[url.split("/").at(-1)]; },
    createRelease: async () => { calls.push("create"); return release({ assets: [] }); },
    uploadAsset: async (_url, name) => { calls.push(`upload ${name}`); return asset(name); },
    listReleases: async () => { calls.push("list"); return []; },
    markLatest: async () => { calls.push("latest"); },
    log: () => {}, ...overrides,
  };
}

function mutations(fake) {
  return fake.calls.filter((call) => call === "create" || call === "latest" || call.startsWith("upload "));
}

test("assets publish only for a person's matching immutable hub tag push", async () => {
  for (const override of [{ actorType: "Bot" }, { actorLogin: "uberblick-agent" }, { actorLogin: undefined },
    { eventName: "workflow_dispatch" }, { eventDeleted: true }, { repository: "other/repo" },
    { refType: "branch" }, { refName: "v1.2.3" }, { tagSha: "b".repeat(40) },
    { workflowSha: "b".repeat(40) }]) {
    const fake = services();
    await assert.rejects(publishHubReleaseAssets(input(override), fake), /person's matching/);
    assert.deepEqual(fake.calls, []);
  }
});

test("both registry images match before any release is created, including an image-publisher no-op", async () => {
  const fake = services();
  assert.equal((await publishHubReleaseAssets(input(), fake)).outcome, "published");
  assert.deepEqual(fake.calls.slice(0, 4), ["tag", "image ghcr.io/uberblick-ai/hub:1.2.3",
    "image ghcr.io/uberblick-ai/hub-web:1.2.3", "release"]);
  assert.deepEqual(mutations(fake), ["create", ...Object.keys(ASSETS).map((name) => `upload ${name}`), "latest"]);
  assert.ok(fake.calls.indexOf("latest") > fake.calls.indexOf("download remote.tailscale.yml"));
});

test("missing, mismatching or unreadable registry images stop before any release write", async () => {
  for (const getImage of [async () => null, async () => image("b".repeat(40)),
    async () => { throw new Error("registry unavailable"); }]) {
    const fake = services({ getImage });
    await assert.rejects(publishHubReleaseAssets(input(), fake), /both images|disagrees|registry unavailable/);
    assert.deepEqual(mutations(fake), []);
    assert.ok(!fake.calls.includes("release"));
  }
});

test("rerunning a complete matching release reuses all bytes without uploading", async () => {
  const fake = services({ getRelease: async () => release() });
  assert.equal((await publishHubReleaseAssets(input(), fake)).outcome, "no-op");
  assert.deepEqual(mutations(fake), ["latest"]);
  assert.deepEqual(fake.calls.filter((call) => call.startsWith("download ")),
    Object.keys(ASSETS).map((name) => `download ${name}`));
});

test("stored release target metadata may name a branch when the existing tag and images prove the source commit", async () => {
  const fake = services({ getRelease: async () => release({ target_commitish: "main" }) });
  assert.equal((await publishHubReleaseAssets(input(), fake)).outcome, "no-op");
  assert.deepEqual(mutations(fake), ["latest"]);
});

test("a missing asset is recovered only after every existing asset is validated", async () => {
  const fake = services({ getRelease: async () => release({ assets: [asset("remote.env.example"),
    asset("remote.https.yml"), asset("remote.tailscale.yml")] }) });
  assert.equal((await publishHubReleaseAssets(input(), fake)).outcome, "published");
  assert.deepEqual(mutations(fake), ["upload compose.yml", "latest"]);
  assert.ok(fake.calls.indexOf("upload compose.yml") > fake.calls.indexOf("download remote.tailscale.yml"));
});

test("differing, duplicate or incomplete existing assets refuse without recovering even an earlier missing asset", async () => {
  for (const assets of [[asset("remote.env.example", { state: "starter" })],
    [asset("remote.env.example", { size: 999 })],
    [asset("remote.env.example", { browser_download_url: "https://example.org/remote.env.example" })],
    [asset("remote.env.example"), asset("remote.env.example")]]) {
    const fake = services({ getRelease: async () => release({ assets }) });
    await assert.rejects(publishHubReleaseAssets(input(), fake), /incompletely|disagrees|duplicate/);
    assert.deepEqual(mutations(fake), []);
  }
  const fake = services({ getRelease: async () => release({ assets: [asset("remote.env.example")] }),
    downloadAsset: async () => Buffer.from("different bytes\n") });
  await assert.rejects(publishHubReleaseAssets(input(), fake), /differs/);
  assert.deepEqual(mutations(fake), []);
});

test("a release for another tag, a draft or a prerelease is not reused", async () => {
  for (const override of [{ tag_name: "hub-v1.2.2" },
    { draft: true }, { prerelease: true }]) {
    const fake = services({ getRelease: async () => release(override) });
    await assert.rejects(publishHubReleaseAssets(input(), fake), /existing release disagrees/);
    assert.deepEqual(mutations(fake), []);
  }
});

test("a moved tag at the write boundary stops all publication", async () => {
  let reads = 0;
  const fake = services({ assertRemoteTag: async () => {
    if (++reads === 2) throw new Error("remote tag moved");
  } });
  await assert.rejects(publishHubReleaseAssets(input(), fake), /remote tag moved/);
  assert.deepEqual(mutations(fake), []);
});

test("a failed or incomplete upload is never promoted to latest and is not overwritten", async () => {
  for (const uploadAsset of [async () => { throw new Error("upload interrupted"); },
    async (_url, name) => asset(name, { state: "starter" })]) {
    const fake = services({ uploadAsset });
    await assert.rejects(publishHubReleaseAssets(input(), fake), /upload interrupted|incompletely/);
    assert.ok(!fake.calls.includes("latest"));
  }
});

test("latest follows the greatest stable hub version, never a later lower version", async () => {
  for (const [candidate, promote] of [[release({ tag_name: "hub-v1.2.10" }), false],
    [release({ tag_name: "hub-v10.0.0" }), false],
    [release({ tag_name: "hub-v1.2.2" }), true],
    [release({ tag_name: "hub-v1.2.3" }), true],
    [release({ tag_name: "hub-v9.0.0", draft: true }), true],
    [release({ tag_name: "hub-v9.0.0", prerelease: true }), true],
    [release({ tag_name: "hub-v9.0.0", assets: [] }), true],
    [release({ tag_name: "hub-v9.0.0", assets: [asset("compose.yml", { state: "starter" })] }), true],
    [release({ tag_name: "hub-v9.0.0-rc.1" }), true],
    [release({ tag_name: "v9.0.0" }), true]]) {
    const fake = services({ getRelease: async () => release(), listReleases: async () => [candidate] });
    await publishHubReleaseAssets(input(), fake);
    assert.equal(fake.calls.includes("latest"), promote, candidate.tag_name);
  }
});

test("only the serialized post-image job has contents write, without package installation or image execution", {
  skip: existsSync(".github/workflows/release-hub.yml") ? undefined : "workflow absent from review context",
}, () => {
  const workflow = readFileSync(".github/workflows/release-hub.yml", "utf8");
  const [before, assets] = workflow.split("\n  assets:\n");
  assert.doesNotMatch(before, /contents: write/);
  assert.match(assets, /needs: publish/);
  assert.match(assets, /github.event.sender.type == 'User'/);
  assert.match(assets, /github.event.sender.login != 'uberblick-agent'/);
  assert.match(assets, /github.event.deleted == false/);
  assert.match(assets, /group: hub-release-assets\n +queue: max\n +cancel-in-progress: false/);
  assert.match(assets, /timeout-minutes: 15/);
  assert.match(assets, /contents: write/);
  assert.match(assets, /node scripts\/publish-hub-release-assets.mjs/);
  assert.doesNotMatch(assets, /mise|pnpm|npm |docker (?:build|run)|setup-node|download-artifact/);
});
