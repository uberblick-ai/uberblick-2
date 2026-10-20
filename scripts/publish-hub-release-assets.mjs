#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHubReleaseAssets } from "./hub-release-assets.mjs";
import { assertImage, imageRefs, versionForTag } from "./publish-hub-release.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY = "uberblick-ai/uberblick-2";
const TAG = /^hub-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function fail(message) {
  throw new Error(`publish-hub-release-assets: ${message}`);
}

function assetUrl(tag, name) {
  return `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`;
}

function compareTags(left, right) {
  const a = TAG.exec(left).slice(1).map(BigInt);
  const b = TAG.exec(right).slice(1).map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

async function assertAsset(asset, name, bytes, tag, services) {
  if (asset.state !== "uploaded") fail(`${name} is incompletely uploaded; refusing to replace it`);
  if (asset.browser_download_url !== assetUrl(tag, name) || asset.size !== bytes.length) {
    fail(`${name} disagrees with this release; refusing to replace it`);
  }
  const published = await services.downloadAsset(asset.browser_download_url);
  if (!bytes.equals(published)) fail(`${name} differs from this commit; refusing to replace it`);
}

/** Only native runner tools run with repository write permission. The image
 * publisher may have been a no-op, so verify both registry images again before
 * creating a release or uploading any asset. */
export async function publishHubReleaseAssets(input, services) {
  const version = versionForTag(input.tag);
  if (!/^[0-9a-f]{40}$/.test(input.headSha) || !Number.isSafeInteger(input.protocolVersion) ||
      input.protocolVersion < 1 || input.protocolVersion > 999999) fail("invalid release metadata");
  if (input.repository !== REPOSITORY || input.eventName !== "push" || input.eventDeleted !== false ||
      input.actorType !== "User" || !input.actorLogin || input.actorLogin === "uberblick-agent" ||
      input.refType !== "tag" || input.refName !== input.tag ||
      input.tagSha !== input.headSha || input.workflowSha !== input.headSha) {
    fail("publishing requires a person's matching GitHub Actions hub tag push at the checked-out commit");
  }
  await services.assertRemoteTag(input.tag, input.headSha);
  for (const ref of imageRefs(version)) {
    const image = await services.getImage(ref);
    if (image === null) fail(`both images must be published before release assets; ${ref} is missing`);
    assertImage(image, input);
  }

  let release = await services.getRelease(input.tag);
  const missing = [];
  if (release !== null && (release.tag_name !== input.tag ||
      release.draft !== false || release.prerelease !== false)) {
    fail("existing release disagrees with this stable tag");
  }
  // Validate the complete existing set before recovering a missing upload. A
  // mismatch or an interrupted upload must never authorize replacing an asset.
  for (const [name, bytes] of Object.entries(input.assets)) {
    const existing = (release?.assets ?? []).filter((asset) => asset.name === name);
    if (existing.length > 1) fail(`release has duplicate ${name} assets`);
    if (existing.length === 0) missing.push([name, bytes]);
    else await assertAsset(existing[0], name, bytes, input.tag, services);
  }
  await services.assertRemoteTag(input.tag, input.headSha);
  release ??= await services.createRelease(input.tag, input.headSha);
  for (const [name, bytes] of missing) {
    const uploaded = await services.uploadAsset(release.upload_url, name, bytes);
    await assertAsset(uploaded, name, bytes, input.tag, services);
  }

  // The workflow serializes this job across hub tags. Publish latest only after
  // every asset is usable, and never let a later lower-version tag displace it.
  const releases = await services.listReleases();
  const newer = releases.some((candidate) => !candidate.draft && !candidate.prerelease &&
    TAG.test(candidate.tag_name) && compareTags(candidate.tag_name, input.tag) > 0 &&
    Object.keys(input.assets).every((name) => {
      const assets = (candidate.assets ?? []).filter((asset) => asset.name === name);
      return assets.length === 1 && assets[0].state === "uploaded";
    }));
  if (!newer) await services.markLatest(release.id);
  services.log(`Hub ${version} release assets ${missing.length === 0 ? "already match" : "published"}.`);
  return { outcome: missing.length === 0 ? "no-op" : "published" };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", ...options });
  if (result.status !== 0) fail(`${command} failed: ${result.stderr ?? result.signal ?? result.status}`);
  return result.stdout?.trim() ?? "";
}

function productionServices() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail("GITHUB_TOKEN is required");
  async function request(path, options = {}) {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      method: options.method ?? "GET",
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28", "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (options.notFound && response.status === 404) return null;
    if (!response.ok) fail(`GitHub ${options.method ?? "GET"} ${path} returned ${response.status}`);
    return response.json();
  }
  async function list(path) {
    const entries = [];
    for (let page = 1; ; page += 1) {
      const batch = await request(`${path}?per_page=100&page=${page}`);
      entries.push(...batch);
      if (batch.length < 100) return entries;
    }
  }
  return {
    assertRemoteTag: async (tag, sha) => {
      const refs = run("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
      const lines = refs.split("\n");
      const resolved = lines.find((line) => line.endsWith("^{}")) ?? lines[0];
      if (resolved.split(/\s/)[0] !== sha) fail(`remote tag ${tag} moved or disappeared`);
    },
    getImage: async (ref) => {
      const probe = spawnSync("docker", ["manifest", "inspect", ref], { encoding: "utf8" });
      if (probe.status !== 0) {
        if (/manifest unknown|no such manifest/i.test(probe.stderr)) return null;
        fail(`cannot establish whether ${ref} exists: ${probe.stderr}`);
      }
      run("docker", ["pull", "--platform", "linux/amd64", ref], { stdio: "inherit" });
      return JSON.parse(run("docker", ["image", "inspect", ref]))[0];
    },
    getRelease: async (tag) => {
      const release = await request(`/releases/tags/${tag}`, { notFound: true });
      if (release !== null) release.assets = await list(`/releases/${release.id}/assets`);
      return release;
    },
    downloadAsset: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) fail(`anonymous asset download returned ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    createRelease: (tag, sha) => request("/releases", { method: "POST", body: {
      tag_name: tag, target_commitish: sha, name: tag, draft: false, prerelease: false,
      generate_release_notes: false, make_latest: "false",
    } }),
    uploadAsset: async (uploadUrl, name, bytes) => {
      const url = new URL(uploadUrl.replace(/\{.*$/, ""));
      if (url.origin !== "https://uploads.github.com" ||
          !url.pathname.startsWith(`/repos/${REPOSITORY}/releases/`)) fail("unexpected release upload URL");
      url.searchParams.set("name", name);
      const response = await fetch(url, { method: "POST", headers: {
        authorization: `Bearer ${token}`, "content-type": "application/octet-stream",
        "x-github-api-version": "2022-11-28",
      }, body: bytes, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) fail(`GitHub asset upload returned ${response.status}`);
      return response.json();
    },
    listReleases: () => list("/releases"),
    markLatest: (id) => request(`/releases/${id}`, { method: "PATCH", body: { make_latest: "true" } }),
    log: (message) => process.stdout.write(`${message}\n`),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) fail("usage: node scripts/publish-hub-release-assets.mjs hub-vMAJOR.MINOR.PATCH");
  const tag = args[0];
  versionForTag(tag);
  const source = readFileSync(join(ROOT, "packages/schema/src/protocol.ts"), "utf8");
  const protocol = /^export const SYNC_PROTOCOL_VERSION = ([1-9][0-9]*);$/m.exec(source);
  if (protocol === null) fail("cannot read SYNC_PROTOCOL_VERSION from the schema source");
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  await publishHubReleaseAssets({ tag, headSha: run("git", ["rev-parse", "HEAD"]),
    protocolVersion: Number(protocol[1]), assets: readHubReleaseAssets(ROOT),
    repository: process.env.GITHUB_REPOSITORY, eventName: process.env.GITHUB_EVENT_NAME,
    eventDeleted: event.deleted, actorType: event.sender?.type, actorLogin: event.sender?.login,
    refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME,
    tagSha: run("git", ["rev-parse", `${tag}^{commit}`]), workflowSha: process.env.GITHUB_SHA,
  }, productionServices());
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
