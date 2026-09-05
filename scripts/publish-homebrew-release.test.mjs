import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  formulaFor,
  publishHomebrewRelease,
  versionForTag,
} from "./publish-homebrew-release.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BYTES = Buffer.from("versioned payload");
const DIGEST = createHash("sha256").update(BYTES).digest("hex");
const TAG = "v1.2.3";
const VERSION = "1.2.3";
const ASSET_URL =
  "https://github.com/uberblick-ai/uberblick-2/releases/download/v1.2.3/uberblick-1.2.3.tar.gz";

function input(overrides = {}) {
  return {
    tag: TAG,
    dryRun: false,
    repository: "uberblick-ai/uberblick-2",
    refType: "tag",
    refName: TAG,
    headSha: "a".repeat(40),
    tagSha: "a".repeat(40),
    workflowSha: "a".repeat(40),
    ...overrides,
  };
}

function services(overrides = {}) {
  const calls = [];
  const service = {
    calls,
    getRelease: async () => {
      calls.push("get release");
      return null;
    },
    getTapFormula: async () => {
      calls.push("get formula");
      return null;
    },
    downloadAsset: async () => {
      calls.push("download");
      return BYTES;
    },
    publishedArchiveVersion: async () => {
      calls.push("published version");
      return VERSION;
    },
    buildArchive: async () => {
      calls.push("build");
      return "/fixture/archive";
    },
    archiveVersion: async () => {
      calls.push("version");
      return VERSION;
    },
    readArchive: async () => {
      calls.push("read");
      return BYTES;
    },
    createRelease: async () => {
      calls.push("create release");
      return { upload_url: "https://uploads.github.test/assets{?name,label}" };
    },
    uploadAsset: async () => {
      calls.push("upload");
    },
    putTapFormula: async (_formula, sha) => {
      calls.push(`put formula ${sha ?? "new"}`);
    },
    log: () => {},
    ...overrides,
  };
  return service;
}

function release() {
  return {
    tag_name: TAG,
    target_commitish: "a".repeat(40),
    draft: false,
    prerelease: false,
    upload_url: "https://uploads.github.test/assets{?name,label}",
    assets: [
      {
        name: `uberblick-${VERSION}.tar.gz`,
        state: "uploaded",
        browser_download_url: ASSET_URL,
      },
    ],
  };
}

test("release tags are exact vMAJOR.MINOR.PATCH values", () => {
  assert.equal(versionForTag("v0.1.0"), "0.1.0");
  for (const invalid of ["0.1.0", "v01.2.3", "v1.2", "v1.2.3-rc.1", "v1x2x3", "v1.2.3.4"]) {
    assert.throws(() => versionForTag(invalid), /exactly vMAJOR\.MINOR\.PATCH/);
  }
});

test("a new tag builds, verifies, publishes, then commits the generated formula", async () => {
  const oldFormula = formulaFor("v1.2.2", "1.2.2", "b".repeat(64));
  const fake = services({
    getTapFormula: async () => {
      fake.calls.push("get formula");
      return { sha: "old-sha", content: oldFormula };
    },
  });

  const result = await publishHomebrewRelease(input(), fake);

  assert.equal(result.outcome, "published");
  assert.deepEqual(fake.calls, [
    "get release",
    "get formula",
    "build",
    "version",
    "read",
    "create release",
    "upload",
    "put formula old-sha",
  ]);
  assert.equal(result.formula, formulaFor(TAG, VERSION, DIGEST));
  assert.doesNotMatch(result.formula, /headers:|HOMEBREW_GITHUB_API_TOKEN/);
});

test("a matching published tag verifies the asset and changes nothing", async () => {
  const expected = formulaFor(TAG, VERSION, DIGEST);
  const fake = services({
    getRelease: async () => {
      fake.calls.push("get release");
      return release();
    },
    getTapFormula: async () => {
      fake.calls.push("get formula");
      return { sha: "formula-sha", content: expected };
    },
  });

  const result = await publishHomebrewRelease(input(), fake);

  assert.equal(result.outcome, "no-op");
  assert.deepEqual(fake.calls, ["get release", "get formula", "download", "published version"]);
});

test("a published payload refuses a disagreeing formula without mutating either repository", async () => {
  const fake = services({
    getRelease: async () => {
      fake.calls.push("get release");
      return release();
    },
    getTapFormula: async () => {
      fake.calls.push("get formula");
      return { sha: "formula-sha", content: formulaFor(TAG, VERSION, "c".repeat(64)) };
    },
  });

  await assert.rejects(() => publishHomebrewRelease(input(), fake), /asset .* and the tap formula disagree/);
  assert.deepEqual(fake.calls, ["get release", "get formula", "download", "published version"]);
});

test("a payload version mismatch publishes nothing", async () => {
  const fake = services({
    archiveVersion: async () => {
      fake.calls.push("version");
      return "1.2.4";
    },
  });

  await assert.rejects(() => publishHomebrewRelease(input(), fake), /payload reports "1\.2\.4"/);
  assert.deepEqual(fake.calls, ["get release", "get formula", "build", "version"]);
});

test("moving a tag after publication is refused before the asset is downloaded", async () => {
  const movedRelease = { ...release(), target_commitish: "b".repeat(40) };
  const fake = services({
    getRelease: async () => {
      fake.calls.push("get release");
      return movedRelease;
    },
  });

  await assert.rejects(
    () => publishHomebrewRelease(input(), fake),
    /immutable stable-tag contract/,
  );
  assert.deepEqual(fake.calls, ["get release"]);
});

test("a partial publication can add an absent formula from the verified asset", async () => {
  const fake = services({
    getRelease: async () => {
      fake.calls.push("get release");
      return release();
    },
  });

  const result = await publishHomebrewRelease(input(), fake);

  assert.equal(result.outcome, "recovered-formula");
  assert.deepEqual(fake.calls, [
    "get release",
    "get formula",
    "download",
    "published version",
    "put formula new",
  ]);
});

test("a dry run builds the payload but reaches no repository API", async () => {
  const output = [];
  const fake = services({
    getRelease: async () => assert.fail("dry-run read the release"),
    getTapFormula: async () => assert.fail("dry-run read the tap"),
    createRelease: async () => assert.fail("dry-run created a release"),
    uploadAsset: async () => assert.fail("dry-run uploaded an asset"),
    putTapFormula: async () => assert.fail("dry-run wrote the tap"),
    log: (line) => output.push(line),
  });

  const result = await publishHomebrewRelease(input({ dryRun: true, repository: undefined }), fake);

  assert.equal(result.outcome, "dry-run");
  assert.deepEqual(fake.calls, ["build", "version", "read"]);
  assert.match(output.join("\n"), /would publish uberblick-1\.2\.3\.tar\.gz/);
  assert.match(output.join("\n"), /would commit Formula\/uberblick\.rb/);
});

test("a mismatched tag ref refuses before any external read or write", async () => {
  const fake = services();
  await assert.rejects(
    () => publishHomebrewRelease(input({ refName: "v1.2.4" }), fake),
    /matching GitHub Actions tag ref/,
  );
  assert.deepEqual(fake.calls, []);
});

test("only the tag-triggered publishing job can declare the tap environment", () => {
  const workflowRoot = join(ROOT, ".github", "workflows");
  const workflows = readdirSync(workflowRoot)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => [name, readFileSync(join(workflowRoot, name), "utf8")]);
  const declarations = workflows.flatMap(([name, body]) =>
    [...body.matchAll(/^\s*environment:\s*homebrew-tap\s*$/gm)].map(() => name),
  );
  assert.deepEqual(declarations, ["release-homebrew.yml"]);

  const releaseWorkflow = workflows.find(([name]) => name === "release-homebrew.yml")?.[1];
  assert.ok(releaseWorkflow);
  assert.match(releaseWorkflow, /^on:\n\s+push:\n\s+tags:/m);
  assert.doesNotMatch(releaseWorkflow, /^\s+branches:|^\s+pull_request:/m);
  assert.equal((releaseWorkflow.match(/^\s+HOMEBREW_TAP_TOKEN:/gm) ?? []).length, 1);
});
