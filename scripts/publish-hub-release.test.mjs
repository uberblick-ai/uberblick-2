import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { assertImage, imageRefs, PLATFORMS, platformDigests,
  platformImageRef, publishHubRelease, versionForTag } from "./publish-hub-release.mjs";

const SHA = "a".repeat(40);
const TAG = "hub-v1.2.3";
function input(overrides = {}) {
  return { tag: TAG, dryRun: false, headSha: SHA, protocolVersion: 1,
    repository: "uberblick-ai/uberblick-2", eventName: "push", actorType: "User", actorLogin: "bk-one",
    refType: "tag", refName: TAG, tagSha: SHA, workflowSha: SHA, ...overrides };
}
const REFS = imageRefs("1.2.3");
function image(platform = "linux/amd64", ref = REFS[0], revision = SHA) {
  return { Id: `sha256:${createHash("sha256").update(`${ref}/${platform}`).digest("hex")}`,
    Os: "linux", Architecture: platform.split("/")[1], Config: { Labels: {
    "org.opencontainers.image.version": "1.2.3", "org.opencontainers.image.revision": revision,
    "io.uberblick.sync-protocol-version": "1",
  } }, release: { version: "1.2.3", sourceCommit: revision, syncProtocolVersion: 1,
    images: { hub: REFS[0], web: REFS[1] } } };
}
function uploadedRef(ref, platform) {
  return `${ref.split(":")[0]}@sha256:${createHash("sha256").update(`uploaded/${ref}/${platform}`).digest("hex")}`;
}
function indexDigest(ref) {
  return `sha256:${createHash("sha256").update(`index/${ref}`).digest("hex")}`;
}
function published(ref = REFS[0]) {
  return Object.fromEntries(PLATFORMS.map((platform) => {
    const inspected = image(platform, ref);
    return [platform, { ...inspected, registryRef: uploadedRef(ref, platform) }];
  }));
}
function services(overrides = {}) {
  const calls = [];
  const indexes = new Set();
  return { calls,
    assertRemoteTag: async () => { calls.push("tag"); },
    getImage: async (ref) => { calls.push(`read ${ref}`); return indexes.has(ref) ? published(ref) : null; },
    buildImages: async () => { calls.push("build"); },
    inspectLocalImage: async (ref, platform) => {
      calls.push(`inspect ${ref} ${platform}`);
      return image(platform, ref.replace(/-(amd64|arm64)$/, ""));
    },
    scanImage: async (id, platform) => { calls.push(`scan ${id} ${platform}`); },
    pushImage: async (ref, id, platform) => {
      calls.push(`push ${ref} ${id} ${platform}`);
      return uploadedRef(ref.replace(/-(amd64|arm64)$/, ""), platform);
    },
    publishIndex: async (ref, digests) => {
      calls.push(`index ${ref} ${digests.join(" ")}`);
      indexes.add(ref);
      return indexDigest(ref);
    },
    verifyAttestation: async (subject, input) => {
      calls.push(`verify ${subject} ${input.tag} ${input.headSha}`);
    },
    log: () => {}, ...overrides,
  };
}

function pushes(fake) {
  return fake.calls.filter((call) => call.startsWith("push ") || call.startsWith("index "));
}

function localChecks() {
  return REFS.flatMap((ref) => PLATFORMS.flatMap((platform) => [
    `inspect ${platformImageRef(ref, platform)} ${platform}`,
    `scan ${image(platform, ref).Id} ${platform}`,
  ]));
}

test("hub/client version numbers and tag triggers are disjoint", () => {
  assert.equal(versionForTag(TAG), "1.2.3");
  for (const tag of ["v1.2.3", "hub-v01.2.3", "hub-v1.2.3-rc", "hub-v1.2", "hub-v1x2x3"]) {
    assert.throws(() => versionForTag(tag), /exactly hub-v/);
  }
});

test("only a person's matching tag push admits publication", async () => {
  for (const override of [{actorType: "Bot"}, {actorLogin: "uberblick-agent"}, {actorLogin: undefined},
    {eventName: "workflow_dispatch"}, {refType: "branch"},
    {refName: "v1.2.3"}, {workflowSha: "b".repeat(40)}, {tagSha: "b".repeat(40)}, {repository: "other/repo"}]) {
    const fake = services();
    await assert.rejects(publishHubRelease(input(override), fake), /person's matching/);
    assert.deepEqual(fake.calls, []);
  }
});

test("all four platform images are checked before publishing those exact images and their indexes", async () => {
  const fake = services();
  const result = await publishHubRelease(input(), fake);
  assert.equal(result.outcome, "published");
  assert.deepEqual(result.digests, REFS.map(indexDigest));
  const firstPush = fake.calls.findIndex((call) => call.startsWith("push "));
  assert.deepEqual(fake.calls.slice(0, firstPush), ["tag", ...REFS.map((ref) => `read ${ref}`),
    "build", ...localChecks(), "tag", ...REFS.map((ref) => `read ${ref}`)]);
  assert.deepEqual(fake.calls.filter((call) => call.startsWith("push ")), REFS.flatMap((ref) =>
    PLATFORMS.map((platform) => `push ${platformImageRef(ref, platform)} ${image(platform, ref).Id} ${platform}`)));
  assert.deepEqual(fake.calls.filter((call) => call.startsWith("index ")), REFS.map((ref) =>
    `index ${ref} ${PLATFORMS.map((platform) => uploadedRef(ref, platform)).join(" ")}`));
  const firstIndex = fake.calls.findIndex((call) => call.startsWith("index "));
  assert.deepEqual(fake.calls.slice(firstIndex - 3, firstIndex), ["tag", ...REFS.map((ref) => `read ${ref}`)]);
  assert.deepEqual(fake.calls.slice(-2), REFS.map((ref) => `read ${ref}`));
});

test("an unchanged published version scans all four platform images without rebuilding or pushing", async () => {
  const fake = services({ getImage: async (ref) => published(ref) });
  assert.equal((await publishHubRelease(input(), fake)).outcome, "no-op");
  assert.deepEqual(fake.calls, ["tag", ...REFS.map((ref) => `verify oci://${ref} ${TAG} ${SHA}`), ...REFS.flatMap((ref) => PLATFORMS.map((platform) =>
    `scan ${image(platform, ref).Id} ${platform}`))]);
});

test("a reused hub release missing either index attestation cannot succeed or rebuild", async () => {
  for (const missing of REFS) {
    const fake = services({ getImage: async (ref) => published(ref),
      verifyAttestation: async (subject) => {
        if (subject === `oci://${missing}`) throw new Error("missing or invalid provenance");
      } });
    await assert.rejects(publishHubRelease(input(), fake), /provenance/);
    assert.ok(!fake.calls.includes("build"));
    assert.deepEqual(pushes(fake), []);
  }
});

test("a publishing result cannot omit a captured index digest", async () => {
  const fake = services({ publishIndex: async () => undefined });
  await assert.rejects(publishHubRelease(input(), fake), /identify published index/);
});

test("mismatching platform identity and partial publications refuse before building or publishing", async () => {
  const mismatching = published();
  mismatching["linux/arm64"] = image("linux/arm64", REFS[0], "b".repeat(40));
  for (const [existing, message] of [[mismatching, /disagrees/], [published(), /partial/]]) {
    let n = 0;
    const fake = services({ getImage: async () => n++ === 0 ? existing : null });
    await assert.rejects(publishHubRelease(input(), fake), message);
    assert.deepEqual(fake.calls, ["tag"]);
  }
});

test("an existing tag missing a required platform is refused in publishing and dry runs", async () => {
  for (const dryRun of [false, true]) {
    for (const platform of PLATFORMS) {
      const incomplete = published();
      delete incomplete[platform];
      const fake = services({ getImage: async () => incomplete });
      await assert.rejects(publishHubRelease(input({ dryRun }), fake), /missing|platform|disagrees/);
      assert.ok(!fake.calls.includes("build"));
      assert.deepEqual(pushes(fake), []);
    }
  }
});

test("a version with either tag published is never rebuilt during a dry run", async () => {
  let reads = 0;
  const fake = services({ getImage: async () => reads++ === 0 ? published() : null });
  await assert.rejects(publishHubRelease(input({ dryRun: true }), fake), /partial/);
  assert.deepEqual(fake.calls, []);
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
  assert.deepEqual(pushes(fake), []);
});

test("a tag appearing after the build prevents every push", async () => {
  let reads = 0;
  const fake = services({ getImage: async () => ++reads > 2 ? published() : null });
  await assert.rejects(publishHubRelease(input(), fake), /appeared/);
  assert.ok(fake.calls.includes("build"));
  assert.deepEqual(pushes(fake), []);
});

test("a tag appearing during staging upload is never replaced by an index", async () => {
  let reads = 0;
  const fake = services({ getImage: async () => ++reads > 4 ? published() : null });
  await assert.rejects(publishHubRelease(input(), fake), /appeared/);
  assert.equal(fake.calls.filter((call) => call.startsWith("push ")).length, 4);
  assert.ok(!fake.calls.some((call) => call.startsWith("index ")));
});

test("a failed fourth platform scan publishes nothing", async () => {
  let scans = 0;
  const fake = services({ scanImage: async () => {
    if (++scans === 4) throw new Error("forbidden file");
  } });
  await assert.rejects(publishHubRelease(input(), fake), /forbidden file/);
  assert.equal(scans, 4);
  assert.deepEqual(pushes(fake), []);
});

test("a failed fourth platform identity check publishes nothing", async () => {
  let inspections = 0;
  const fake = services({ inspectLocalImage: async (ref, platform) => {
    inspections += 1;
    return image(platform, ref.replace(/-(amd64|arm64)$/, ""), inspections === 4 ? "b".repeat(40) : SHA);
  } });
  await assert.rejects(publishHubRelease(input(), fake), /disagrees/);
  assert.equal(inspections, 4);
  assert.deepEqual(pushes(fake), []);
});

test("each platform requires matching OS, architecture, labels and embedded release metadata", () => {
  for (const platform of PLATFORMS) {
    assert.doesNotThrow(() => assertImage(image(platform), input(), platform));
    const good = image(platform);
    for (const bad of [{ ...good, Architecture: platform === "linux/arm64" ? "amd64" : "arm64" },
      { ...good, Os: "windows" }, { ...good, Variant: platform === "linux/arm64" ? "v9" : "v3" },
      { ...good, Config: { Labels: {} } },
      { ...good, release: { ...good.release, version: "1.2.4" } },
      { ...good, release: { ...good.release, sourceCommit: "b".repeat(40) } },
      { ...good, release: { ...good.release, syncProtocolVersion: 2 } },
      { ...good, release: { ...good.release, images: { ...good.release.images, web: "other:1.2.3" } } },
      { ...good, release: undefined }]) {
      assert.throws(() => assertImage(bad, input(), platform), /disagrees/);
    }
  }
});

test("a published index is rechecked against all uploaded platform digests", async () => {
  let reads = 0;
  const fake = services({ getImage: async (ref) => {
    if (++reads <= 6) return null;
    const result = published(ref);
    result["linux/arm64"].registryRef = `${ref.split(":")[0]}@sha256:${"b".repeat(64)}`;
    return result;
  } });
  await assert.rejects(publishHubRelease(input(), fake), /checked|identity|disagrees/);
});

test("a dry run checks immutable destinations then builds and scans all four images without publishing", async () => {
  const fake = services();
  assert.equal((await publishHubRelease(input({dryRun: true, repository: undefined}), fake)).outcome, "dry-run");
  assert.deepEqual(fake.calls, [...REFS.map((ref) => `read ${ref}`), "build", ...localChecks()]);
  assert.deepEqual(pushes(fake), []);
});

test("dry runs validate layer contents of all four existing platform images", async () => {
  let scans = 0;
  const fake = services({ getImage: async (ref) => published(ref), scanImage: async () => {
    if (++scans === 4) throw new Error("forbidden file");
  } });
  await assert.rejects(publishHubRelease(input({ dryRun: true }), fake), /forbidden file/);
  assert.equal(scans, 4);
  assert.ok(!fake.calls.includes("build"));
  assert.deepEqual(pushes(fake), []);
});

function index() {
  return { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: PLATFORMS.map((platform, position) => ({
      mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${String(position + 1).repeat(64)}`,
      platform: { os: "linux", architecture: platform.split("/")[1] },
    })) };
}

test("published platform digests come from one complete index and tolerate only recognized attestations", () => {
  const valid = index();
  const expected = Object.fromEntries(PLATFORMS.map((platform, position) =>
    [platform, `sha256:${String(position + 1).repeat(64)}`]));
  assert.deepEqual(platformDigests(valid), expected);
  for (const variant of ["8", "v8", "v8.0"]) {
    const explicit = index();
    explicit.manifests[0].platform.variant = "v1";
    explicit.manifests[1].platform.variant = variant;
    assert.deepEqual(platformDigests(explicit), expected);
  }
  assert.deepEqual(platformDigests({ ...valid, mediaType: "application/vnd.docker.distribution.manifest.list.v2+json" }), expected);
  valid.manifests.push({ digest: `sha256:${"3".repeat(64)}`, platform: { os: "unknown", architecture: "unknown" },
    annotations: { "vnd.docker.reference.type": "attestation-manifest",
      "vnd.docker.reference.digest": valid.manifests[0].digest } });
  assert.deepEqual(platformDigests(valid), expected);
  for (const invalid of [
    { schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: {} },
    { ...index(), manifests: index().manifests.slice(0, 1) },
    { ...index(), manifests: [...index().manifests, index().manifests[0]] },
    { ...index(), manifests: [...index().manifests, { digest: `sha256:${"3".repeat(64)}`,
      platform: { os: "linux", architecture: "arm", variant: "v7" } }] },
    { ...index(), manifests: [...index().manifests, { digest: `sha256:${"3".repeat(64)}`,
      platform: { os: "unknown", architecture: "unknown" } }] },
  ]) assert.throws(() => platformDigests(invalid), /platform|index|manifest/);
  for (const [position, variant] of [[0, "v3"], [1, "v9"]]) {
    const narrowed = index();
    narrowed.manifests[position].platform.variant = variant;
    assert.throws(() => platformDigests(narrowed), /unsupported/,
      "a digest pull must not hide an index variant that excludes baseline hosts");
  }
});

test("the index publisher captures the digest assembled from this run's platform subjects", async () => {
  const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(),
    `hub-index-adapter-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  try {
    const docker = join(scratch, "docker");
    const log = join(scratch, "docker.json");
    const metadata = join(scratch, "metadata.json");
    writeFileSync(docker, `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
writeFileSync(args[args.indexOf("--metadata-file") + 1], JSON.stringify({
  "containerimage.descriptor": { digest: process.env.INDEX_TEST_DIGEST }
}));
`);
    chmodSync(docker, 0o755);
    for (const digest of [indexDigest(REFS[0]), "", "sha256:invalid"]) {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
import { publishIndex } from ${JSON.stringify(new URL("./publish-hub-release.mjs", import.meta.url).href)};
process.stdout.write(await publishIndex(${JSON.stringify(REFS[0])},
  ${JSON.stringify(PLATFORMS.map((platform) => uploadedRef(REFS[0], platform)))}, ${JSON.stringify(metadata)}));
`], { env: { ...process.env, PATH: scratch, INDEX_TEST_DIGEST: digest }, encoding: "utf8", timeout: 10_000 });
      if (digest === indexDigest(REFS[0])) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, digest);
      } else {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /cannot identify published index/);
      }
      assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), ["buildx", "imagetools", "create", "--tag", REFS[0],
        "--metadata-file", metadata, ...PLATFORMS.map((platform) => uploadedRef(REFS[0], platform))]);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the registry adapter pulls each platform digest and reads metadata without running images, cleaning up even invalid JSON", () => {
  for (const malformedMetadata of [false, true]) {
    const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(),
      `hub-registry-adapter-${process.env.UB_AGENTS_RUN ?? "test"}-`));
    try {
      const log = join(scratch, "docker.jsonl");
      const fixturePath = join(scratch, "fixture.json");
      const manifest = index();
      const children = Object.fromEntries(PLATFORMS.map((platform, position) =>
        [platform, `${REFS[0].split(":")[0]}@${manifest.manifests[position].digest}`]));
      const inspected = Object.fromEntries(PLATFORMS.map((platform) => {
        const { release: _release, ...config } = image(platform);
        return [children[platform], config];
      }));
      writeFileSync(fixturePath, JSON.stringify({ manifest, inspected,
        metadata: Object.fromEntries(PLATFORMS.map((platform) =>
          [platform, { ...image(platform).release, builtFor: platform }])) }));
      const docker = join(scratch, "docker");
      writeFileSync(docker, `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.DOCKER_TEST_LOG, JSON.stringify(args) + "\\n");
const fixture = JSON.parse(readFileSync(process.env.DOCKER_TEST_FIXTURE, "utf8"));
if (args[0] === "manifest" && args[1] === "inspect") {
  process.stdout.write(JSON.stringify(fixture.manifest));
} else if (args[0] === "pull") {
} else if (args[0] === "image" && args[1] === "inspect") {
  if (!fixture.inspected[args[2]]) throw new Error("inspect must name a platform digest");
  process.stdout.write(JSON.stringify([fixture.inspected[args[2]]]));
} else if (args[0] === "create") {
  process.stdout.write(args[2].split("/")[1] + "-container");
} else if (args[0] === "cp") {
  const platform = "linux/" + args[1].split("-container:")[0];
  const bytes = process.env.DOCKER_TEST_BAD_JSON === "true" && platform === "linux/arm64"
    ? "{" : JSON.stringify(fixture.metadata[platform]);
  writeFileSync(args[2], bytes);
} else if (args[0] !== "rm") {
  throw new Error("unexpected Docker operation: " + args.join(" "));
}
`);
      chmodSync(docker, 0o755);
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
import { getImage } from ${JSON.stringify(new URL("./publish-hub-release.mjs", import.meta.url).href)};
process.stdout.write(JSON.stringify(await getImage(${JSON.stringify(REFS[0])})));
`], { env: { ...process.env, PATH: scratch, UB_AGENTS_SCRATCH: scratch,
        DOCKER_TEST_LOG: log, DOCKER_TEST_FIXTURE: fixturePath, DOCKER_TEST_BAD_JSON: String(malformedMetadata) },
        encoding: "utf8", timeout: 10_000 });
      if (malformedMetadata) {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /SyntaxError/);
      } else {
        assert.equal(result.status, 0, result.stderr);
        const images = JSON.parse(result.stdout);
        for (const platform of PLATFORMS) {
          assert.equal(images[platform].Id, image(platform).Id);
          assert.equal(images[platform].registryRef, children[platform]);
          assert.equal(images[platform].release.builtFor, platform);
        }
      }
      const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(calls[0], ["manifest", "inspect", REFS[0]]);
      for (const [position, platform] of PLATFORMS.entries()) {
        const platformCalls = calls.slice(1 + position * 5, 6 + position * 5);
        const container = `${platform.split("/")[1]}-container`;
        assert.deepEqual(platformCalls.slice(0, 3), [["pull", "--platform", platform, children[platform]],
          ["image", "inspect", children[platform]],
          ["create", "--platform", platform, "--entrypoint", "/bin/true", image(platform).Id]]);
        assert.deepEqual(platformCalls[3].slice(0, 2), ["cp", `${container}:/release/release.json`]);
        assert.equal(dirname(dirname(platformCalls[3][2])), scratch);
        assert.equal(existsSync(platformCalls[3][2]), false);
        assert.deepEqual(platformCalls[4], ["rm", container]);
      }
      assert.equal(calls.length, 11);
      assert.ok(!calls.some((args) => args[0] === "run" || args[0] === "start"));
      assert.ok(!readdirSync(scratch).some((name) => name.startsWith("hub-metadata-")));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test("workflow has only the human hub tag push trigger and the scoped workflow token", {
  skip: existsSync(".github/workflows/release-hub.yml") ? undefined : "workflow files absent from review context",
}, () => {
  const body = readFileSync(".github/workflows/release-hub.yml", "utf8");
  assert.match(body, /^on:\n {2}push:\n {4}tags:\n {6}- "hub-v/m);
  assert.doesNotMatch(body, /schedule:|workflow_dispatch:|branches:|pull_request:/);
  assert.match(body, /github.event.sender.type == 'User'/);
  assert.match(body, /github.event.sender.login != 'uberblick-agent'/);
  assert.match(body, /packages: write/);
  assert.match(body, /secrets.GITHUB_TOKEN/);
  assert.doesNotMatch(body, /HOMEBREW_TAP_TOKEN|:latest/);
  const homebrew = readFileSync(".github/workflows/release-homebrew.yml", "utf8");
  assert.doesNotMatch(homebrew, /hub-v/);
});
