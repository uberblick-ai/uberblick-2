#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY = "uberblick-ai/uberblick-2";
const TAG = /^hub-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

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

export function assertImage(image, input) {
  const labels = image.Config?.Labels ?? {};
  if (image.Os !== "linux" || image.Architecture !== "amd64" ||
      labels["org.opencontainers.image.version"] !== versionForTag(input.tag) ||
      labels["org.opencontainers.image.revision"] !== input.headSha ||
      labels["io.uberblick.sync-protocol-version"] !== String(input.protocolVersion)) {
    fail("published image disagrees with this tag's source commit, version, protocol or platform; use a new hub version");
  }
}

/** Inspect both immutable destinations before any build or push. A partial
 * publication is deliberately refused: rebuilding its missing half could mix
 * different base images under one release version. */
export async function publishHubRelease(input, services) {
  const version = versionForTag(input.tag);
  if (!/^[0-9a-f]{40}$/.test(input.headSha) || !Number.isSafeInteger(input.protocolVersion) ||
      input.protocolVersion < 1 || input.protocolVersion > 999999) fail("invalid release metadata");
  if (!input.dryRun && (input.repository !== REPOSITORY || input.eventName !== "push" ||
      input.actorType !== "User" || input.refType !== "tag" || input.refName !== input.tag ||
      input.tagSha !== input.headSha || input.workflowSha !== input.headSha)) {
    fail("publishing requires a person's matching GitHub Actions hub tag push at the checked-out commit");
  }
  const refs = imageRefs(version);
  if (!input.dryRun) {
    await services.assertRemoteTag(input.tag, input.headSha);
    const existing = await Promise.all(refs.map((ref) => services.getImage(ref)));
    for (const image of existing) if (image !== null) assertImage(image, input);
    if (existing.every((image) => image !== null)) {
      services.log(`Hub ${version} already matches; no images rebuilt or published.`);
      return { outcome: "no-op", refs };
    }
    if (existing.some((image) => image !== null)) {
      fail("partial hub publication; do not rebuild or overwrite it, cut a new hub version");
    }
  }
  await services.buildImages({ version, sourceCommit: input.headSha, protocolVersion: input.protocolVersion, refs });
  // Both scans and metadata checks finish before the first image is pushed.
  for (const ref of refs) {
    assertImage(await services.inspectLocalImage(ref), input);
    await services.scanImage(ref);
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
  for (const ref of refs) await services.pushImage(ref);
  services.log(`Published hub ${version} from ${input.headSha}, sync protocol ${input.protocolVersion}.`);
  return { outcome: "published", refs };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", ...options });
  if (result.status !== 0) fail(`${command} failed: ${result.stderr ?? result.signal ?? result.status}`);
  return result.stdout?.trim() ?? "";
}

function localServices(scratch) {
  return {
    buildImages: async ({ version, sourceCommit, protocolVersion, refs }) => {
      for (const [index, target] of ["hub", "web"].entries()) {
        run("docker", ["build", "--platform", "linux/amd64", "--file", "Dockerfile.hub-release",
          "--target", target, "--tag", refs[index],
          "--build-arg", `HUB_RELEASE_VERSION=${version}`,
          "--build-arg", `HUB_RELEASE_COMMIT=${sourceCommit}`,
          "--build-arg", `HUB_SYNC_PROTOCOL_VERSION=${protocolVersion}`,
          "--build-arg", `HUB_RELEASE_HUB_IMAGE=${refs[0]}`,
          "--build-arg", `HUB_RELEASE_WEB_IMAGE=${refs[1]}`, "."], { stdio: "inherit" });
      }
    },
    inspectLocalImage: async (ref) => JSON.parse(run("docker", ["image", "inspect", ref]))[0],
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
  return {
    ...localServices(scratch),
    assertRemoteTag: async (tag, sha) => {
      const refs = run("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
      const lines = refs.split("\n");
      const resolved = lines.find((line) => line.endsWith("^{}")) ?? lines[0];
      if (resolved.split(/\s/)[0] !== sha) fail(`remote tag ${tag} moved or disappeared; nothing published`);
    },
    getImage: async (ref) => {
      const probe = spawnSync("docker", ["manifest", "inspect", ref], { encoding: "utf8" });
      if (probe.status !== 0) {
        // Network/auth failures must never masquerade as an unpublished tag.
        if (/manifest unknown|no such manifest/i.test(probe.stderr)) return null;
        fail(`cannot establish whether ${ref} exists: ${probe.stderr}`);
      }
      run("docker", ["pull", "--platform", "linux/amd64", ref], { stdio: "inherit" });
      return JSON.parse(run("docker", ["image", "inspect", ref]))[0];
    },
    pushImage: async (ref) => run("docker", ["push", ref], { stdio: "inherit" }),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((arg) => arg !== "--dry-run");
  if (positional.length !== 1) fail("usage: mise run publish-hub-release -- hub-vMAJOR.MINOR.PATCH [--dry-run]");
  const tag = positional[0];
  versionForTag(tag);
  const source = readFileSync(join(ROOT, "packages/hub/src/protocol.ts"), "utf8");
  const protocol = /^export const SYNC_PROTOCOL_VERSION = ([1-9][0-9]*);$/m.exec(source);
  if (protocol === null) fail("cannot read SYNC_PROTOCOL_VERSION from the hub source");
  const scratch = mkdtempSync(join(tmpdir(), `hub-release-${process.env.UB_AGENTS_RUN ?? "local"}-`));
  try {
    const headSha = run("git", ["rev-parse", "HEAD"]);
    const event = dryRun ? null : JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    await publishHubRelease({ tag, dryRun, headSha, protocolVersion: Number(protocol[1]),
      repository: process.env.GITHUB_REPOSITORY, eventName: process.env.GITHUB_EVENT_NAME,
      actorType: event?.sender?.type, refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME,
      tagSha: dryRun ? headSha : run("git", ["rev-parse", `${tag}^{commit}`]), workflowSha: process.env.GITHUB_SHA,
    }, dryRun ? localServices(scratch) : productionServices(scratch));
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
