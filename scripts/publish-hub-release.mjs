#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseAttestation } from "./release-attestation.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY = "uberblick-ai/uberblick-2";
const TAG = /^hub-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export const PLATFORMS = ["linux/amd64", "linux/arm64"];

function fail(message) {
  throw new Error(`publish-hub-release: ${message}`);
}

export function versionForTag(tag) {
  if (!TAG.test(tag)) fail("tag must be exactly hub-vMAJOR.MINOR.PATCH");
  return tag.slice(5);
}

export function imageRefs(version) {
  return [`ghcr.io/uberblick-ai/hub:${version}`, `ghcr.io/uberblick-ai/hub-web:${version}`];
}

export function platformImageRef(ref, platform) {
  return `${ref}-${platform.split("/")[1]}`;
}

function baselineVariant(platform, variant) {
  const variants = platform === "linux/arm64" ? ["", "8", "v8", "v8.0"] : ["", "v1"];
  return PLATFORMS.includes(platform) && variants.includes(variant ?? "");
}

export function assertImage(image, input, platform) {
  const labels = image.Config?.Labels ?? {};
  const release = image.release ?? {};
  const refs = imageRefs(versionForTag(input.tag));
  if (!baselineVariant(platform, image.Variant) || `${image.Os}/${image.Architecture}` !== platform ||
      labels["org.opencontainers.image.version"] !== versionForTag(input.tag) ||
      labels["org.opencontainers.image.revision"] !== input.headSha ||
      labels["io.uberblick.sync-protocol-version"] !== String(input.protocolVersion) ||
      release.version !== versionForTag(input.tag) || release.sourceCommit !== input.headSha ||
      release.syncProtocolVersion !== input.protocolVersion ||
      release.images?.hub !== refs[0] || release.images?.web !== refs[1]) {
    fail("published image disagrees with this tag's source commit, version, protocol or platform; use a new hub version");
  }
}

export function assertPublishedImage(images, input) {
  for (const platform of PLATFORMS) {
    if (!images?.[platform]) fail(`published image is missing ${platform}; use a new hub version`);
    assertImage(images[platform], input, platform);
  }
}

export function platformDigests(index) {
  if (!["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"]
    .includes(index.mediaType) || !Array.isArray(index.manifests)) fail("published tag must be a multi-platform image index");
  const platforms = {};
  for (const entry of index.manifests) {
    const platform = `${entry.platform?.os}/${entry.platform?.architecture}`;
    if (platform === "unknown/unknown" &&
        entry.annotations?.["vnd.docker.reference.type"] === "attestation-manifest") continue;
    if (!baselineVariant(platform, entry.platform?.variant) || platforms[platform] || !/^sha256:[0-9a-f]{64}$/.test(entry.digest)) {
      fail(`published index has an unsupported or duplicate platform: ${platform}/${entry.platform?.variant ?? ""}`);
    }
    platforms[platform] = entry.digest;
  }
  for (const platform of PLATFORMS) if (!platforms[platform]) fail(`published index is missing ${platform}; use a new hub version`);
  return platforms;
}

/** Inspect both immutable destinations before any build or push. A partial
 * publication is deliberately refused: rebuilding its missing half could mix
 * different base images under one release version. */
export async function publishHubRelease(input, services) {
  const version = versionForTag(input.tag);
  if (!/^[0-9a-f]{40}$/.test(input.headSha) || !Number.isSafeInteger(input.protocolVersion) ||
      input.protocolVersion < 1 || input.protocolVersion > 999999) fail("invalid release metadata");
  if (!input.dryRun && (input.repository !== REPOSITORY || input.eventName !== "push" ||
      input.actorType !== "User" || !input.actorLogin || input.actorLogin === "uberblick-agent" ||
      input.refType !== "tag" || input.refName !== input.tag ||
      input.tagSha !== input.headSha || input.workflowSha !== input.headSha)) {
    fail("publishing requires a person's matching GitHub Actions hub tag push at the checked-out commit");
  }
  const refs = imageRefs(version);
  if (!input.dryRun) await services.assertRemoteTag(input.tag, input.headSha);
  const existing = await Promise.all(refs.map((ref) => services.getImage(ref)));
  for (const image of existing) if (image !== null) assertPublishedImage(image, input);
  if (existing.every((image) => image !== null)) {
    if (!input.dryRun) for (const ref of refs) await services.verifyAttestation(`oci://${ref}`, input);
    for (const image of existing) for (const platform of PLATFORMS) await services.scanImage(image[platform].Id, platform);
    services.log(`Hub ${version} already matches; all platforms scanned, no images rebuilt or published.`);
    return { outcome: "no-op", refs };
  }
  if (existing.some((image) => image !== null)) {
    fail("partial hub publication; do not rebuild or overwrite it, cut a new hub version");
  }
  await services.buildImages({ version, sourceCommit: input.headSha, protocolVersion: input.protocolVersion, refs });
  const checked = new Map();
  // Save and push by ID: a mutable local tag must not substitute unscanned bytes.
  for (const ref of refs) {
    for (const platform of PLATFORMS) {
      const localRef = platformImageRef(ref, platform);
      const image = await services.inspectLocalImage(localRef, platform);
      assertImage(image, input, platform);
      await services.scanImage(image.Id, platform);
      checked.set(localRef, image.Id);
    }
  }
  if (input.dryRun) {
    services.log(`Dry run: built and scanned ${refs.join(" and ")}; nothing published.`);
    return { outcome: "dry-run", refs };
  }
  // Building can take minutes. Recheck the remote tag and both destinations at
  // the irreversible boundary; workflow concurrency serializes this version.
  await services.assertRemoteTag(input.tag, input.headSha);
  for (const ref of refs) if (await services.getImage(ref) !== null) {
    fail("hub version appeared during the build; refusing to overwrite it");
  }
  const uploaded = new Map();
  for (const ref of refs) {
    const digests = [];
    for (const platform of PLATFORMS) {
      const localRef = platformImageRef(ref, platform);
      digests.push(await services.pushImage(localRef, checked.get(localRef), platform));
    }
    uploaded.set(ref, digests);
  }
  // Uploads can also take minutes; refuse a version that appeared meanwhile.
  await services.assertRemoteTag(input.tag, input.headSha);
  for (const ref of refs) if (await services.getImage(ref) !== null) {
    fail("hub version appeared during upload; refusing to overwrite it");
  }
  const digests = [];
  for (const ref of refs) {
    const digest = await services.publishIndex(ref, uploaded.get(ref));
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) fail(`cannot identify published index for ${ref}`);
    digests.push(digest);
  }
  for (const ref of refs) {
    const published = await services.getImage(ref);
    assertPublishedImage(published, input);
    for (const [index, platform] of PLATFORMS.entries()) if (published[platform].registryRef !== uploaded.get(ref)[index]) {
      fail(`published ${ref} ${platform} is not the checked image`);
    }
  }
  services.log(`Published hub ${version} from ${input.headSha}, sync protocol ${input.protocolVersion}.`);
  return { outcome: "published", refs, digests };
}

export async function publishIndex(ref, digests, metadataPath) {
  run("docker", ["buildx", "imagetools", "create", "--tag", ref, "--metadata-file", metadataPath, ...digests], { stdio: "inherit" });
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const digest = metadata["containerimage.descriptor"]?.digest;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) fail(`cannot identify published index for ${ref}`);
  return digest;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", timeout: 1_200_000, ...options });
  if (result.status !== 0) fail(`${command} failed: ${result.stderr ?? result.signal ?? result.status}`);
  return result.stdout?.trim() ?? "";
}

export async function assertRemoteTag(tag, sha) {
  const refs = run("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  const lines = refs.split("\n");
  const resolved = lines.find((line) => line.endsWith("^{}")) ?? lines[0];
  if (resolved.split(/\s/)[0] !== sha) fail(`remote tag ${tag} moved or disappeared; nothing published`);
}

export async function getImage(ref) {
  const probe = spawnSync("docker", ["manifest", "inspect", ref], { encoding: "utf8", timeout: 60_000 });
  if (probe.status !== 0) {
    // Network/auth failures must never masquerade as an unpublished tag.
    if (/manifest unknown|no such manifest/i.test(probe.stderr)) return null;
    fail(`cannot establish whether ${ref} exists: ${probe.stderr}`);
  }
  const images = {};
  const repository = ref.slice(0, ref.lastIndexOf(":"));
  for (const [platform, digest] of Object.entries(platformDigests(JSON.parse(probe.stdout)))) {
    const child = `${repository}@${digest}`;
    run("docker", ["pull", "--platform", platform, child], { stdio: "inherit" });
    images[platform] = { ...inspectImage(child, platform), registryRef: child };
  }
  return images;
}

function inspectImage(ref, platform) {
  const image = JSON.parse(run("docker", ["image", "inspect", ref]))[0];
  const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(), `hub-metadata-${process.env.UB_AGENTS_RUN ?? "local"}-`));
  let container;
  try {
    container = run("docker", ["create", "--platform", platform, "--entrypoint", "/bin/true", image.Id]);
    const path = join(scratch, "release.json");
    run("docker", ["cp", `${container}:/release/release.json`, path]);
    return { ...image, release: JSON.parse(readFileSync(path, "utf8")) };
  } finally {
    try { if (container) run("docker", ["rm", container]); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
  }
}

function localServices(scratch) {
  return {
    getImage,
    buildImages: async ({ version, sourceCommit, protocolVersion, refs }) => {
      for (const [index, target] of ["hub", "web"].entries()) {
        for (const platform of PLATFORMS) run("docker", ["buildx", "build", "--load", "--provenance=false", "--platform", platform, "--file", "Dockerfile.hub-release",
          "--target", target, "--tag", platformImageRef(refs[index], platform),
          "--build-arg", `HUB_RELEASE_VERSION=${version}`,
          "--build-arg", `HUB_RELEASE_COMMIT=${sourceCommit}`,
          "--build-arg", `HUB_SYNC_PROTOCOL_VERSION=${protocolVersion}`,
          "--build-arg", `HUB_RELEASE_HUB_IMAGE=${refs[0]}`,
          "--build-arg", `HUB_RELEASE_WEB_IMAGE=${refs[1]}`, "."], { stdio: "inherit" });
      }
      const native = run("docker", ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]);
      if (PLATFORMS.includes(native)) for (const ref of refs) {
        run("docker", ["tag", platformImageRef(ref, native), ref]);
      }
    },
    inspectLocalImage: async (ref, platform) => inspectImage(ref, platform),
    scanImage: async (ref) => {
      const archive = join(scratch, "image.tar");
      run("docker", ["image", "save", "--output", archive, ref]);
      run("python3", ["scripts/check-hub-image.py", archive], { stdio: "inherit" });
      rmSync(archive);
    },
    log: (message) => process.stdout.write(`${message}\n`),
  };
}

function productionServices(scratch) {
  const staging = randomUUID();
  return {
    ...localServices(scratch),
    assertRemoteTag,
    getImage,
    pushImage: async (ref, id, platform) => {
      const repository = ref.slice(0, ref.lastIndexOf(":"));
      const stage = `${repository}:staging-${staging}-${platform.split("/")[1]}`;
      run("docker", ["tag", id, stage]);
      run("docker", ["push", stage], { stdio: "inherit" });
      const image = JSON.parse(run("docker", ["image", "inspect", stage]))[0];
      if (image.Id !== id) fail(`uploaded ${stage} is not the checked image`);
      const manifest = JSON.parse(run("docker", ["buildx", "imagetools", "inspect", stage, "--format", "{{json .Manifest}}"]));
      if (!/^sha256:[0-9a-f]{64}$/.test(manifest.digest)) fail(`cannot identify pushed digest for ${stage}`);
      return `${repository}@${manifest.digest}`;
    },
    publishIndex: (ref, digests) => publishIndex(ref, digests, join(scratch, "index.json")),
    verifyAttestation: (subject, input) => verifyReleaseAttestation(subject, "release-hub.yml", input),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((arg) => arg !== "--dry-run");
  if (positional.length !== 1) fail("usage: mise run publish-hub-release -- hub-vMAJOR.MINOR.PATCH [--dry-run]");
  const tag = positional[0];
  versionForTag(tag);
  const source = readFileSync(join(ROOT, "packages/schema/src/protocol.ts"), "utf8");
  const protocol = /^export const SYNC_PROTOCOL_VERSION = ([1-9][0-9]*);$/m.exec(source);
  if (protocol === null) fail("cannot read SYNC_PROTOCOL_VERSION from the schema source");
  const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(), `hub-release-${process.env.UB_AGENTS_RUN ?? "local"}-`));
  try {
    const headSha = run("git", ["rev-parse", "HEAD"]);
    const event = dryRun ? null : JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const result = await publishHubRelease({ tag, dryRun, headSha, protocolVersion: Number(protocol[1]),
      repository: process.env.GITHUB_REPOSITORY, eventName: process.env.GITHUB_EVENT_NAME,
      actorType: event?.sender?.type, actorLogin: event?.sender?.login,
      refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME,
      tagSha: dryRun ? headSha : run("git", ["rev-parse", `${tag}^{commit}`]), workflowSha: process.env.GITHUB_SHA,
    }, dryRun ? localServices(scratch) : productionServices(scratch));
    if (!dryRun && process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `outcome=${result.outcome}\n`);
      if (result.outcome === "published") {
        appendFileSync(process.env.GITHUB_OUTPUT, `hub-digest=${result.digests[0]}\nweb-digest=${result.digests[1]}\n`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
