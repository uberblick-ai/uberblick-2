import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  formulaFor,
  publishHomebrewRelease,
  releaseBody,
  versionForTag,
} from "./publish-homebrew-release.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BYTES = Buffer.from("versioned payload");
const DIGEST = createHash("sha256").update(BYTES).digest("hex");
const TAG = "v1.2.3";
const VERSION = "1.2.3";
const HEAD_SHA = "a".repeat(40);
const ASSET_URL =
  "https://github.com/uberblick-ai/homebrew-tap/releases/download/v1.2.3/uberblick-1.2.3.tar.gz";
const WORKFLOW_ROOT = join(ROOT, ".github", "workflows");
const workflowSkip = existsSync(WORKFLOW_ROOT)
  ? undefined
  : ".github/workflows is absent from this checkout, so workflow isolation cannot be checked here";

function input(overrides = {}) {
  return {
    tag: TAG,
    dryRun: false,
    repository: "uberblick-ai/uberblick-2",
    refType: "tag",
    refName: TAG,
    headSha: HEAD_SHA,
    tagSha: HEAD_SHA,
    workflowSha: HEAD_SHA,
    ...overrides,
  };
}

function services(overrides = {}) {
  const calls = [];
  const service = {
    calls,
    getTapRepository: async () => {
      calls.push("get tap");
      return { visibility: "public", initialized: true };
    },
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
    assertPublicAsset: async () => {
      calls.push("public asset");
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
    body: releaseBody(VERSION, HEAD_SHA),
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
  let createdBody = null;
  const fake = services({
    getTapFormula: async () => {
      fake.calls.push("get formula");
      return { sha: "old-sha", content: oldFormula };
    },
    createRelease: async (_tag, body) => {
      fake.calls.push("create release");
      createdBody = body;
      return { upload_url: "https://uploads.github.test/assets{?name,label}" };
    },
  });

  const result = await publishHomebrewRelease(input(), fake);

  assert.equal(result.outcome, "published");
  assert.deepEqual(fake.calls, [
    "get tap",
    "get release",
    "get formula",
    "build",
    "version",
    "read",
    "create release",
    "upload",
    "public asset",
    "put formula old-sha",
  ]);
  assert.equal(result.formula, formulaFor(TAG, VERSION, DIGEST));
  assert.match(createdBody, new RegExp(`^Source-commit: ${HEAD_SHA}$`, "m"));
});

test("the formula downloads the asset anonymously from the public tap", () => {
  const formula = formulaFor(TAG, VERSION, DIGEST);

  assert.match(formula, new RegExp(`^  url "${ASSET_URL}"$`, "m"));
  assert.doesNotMatch(formula, /uberblick-2\/releases/);
  assert.doesNotMatch(formula, /headers:|Authorization|Bearer|TOKEN/i);
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
  assert.deepEqual(fake.calls, [
    "get tap",
    "get release",
    "get formula",
    "download",
    "published version",
    "public asset",
  ]);
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
  assert.deepEqual(fake.calls, [
    "get tap",
    "get release",
    "get formula",
    "download",
    "published version",
    "public asset",
  ]);
});

test("a payload version mismatch publishes nothing", async () => {
  const fake = services({
    archiveVersion: async () => {
      fake.calls.push("version");
      return "1.2.4";
    },
  });

  await assert.rejects(() => publishHomebrewRelease(input(), fake), /payload reports "1\.2\.4"/);
  assert.deepEqual(fake.calls, ["get tap", "get release", "get formula", "build", "version"]);
});

test("a published release stays bound to the source commit it was published from", async () => {
  // The tap release targets a tap commit, so the source commit is carried in the
  // release body. Both a moved tag and a release that records no source commit
  // are refused before the formula is even read, so nothing is mutated.
  for (const [body, expected] of [
    [releaseBody(VERSION, "b".repeat(40)), /published from source commit b{40}, not a{40}/],
    ["Uberblick 1.2.3", /published from source commit \(none recorded\), not a{40}/],
  ]) {
    const fake = services({
      getRelease: async () => {
        fake.calls.push("get release");
        return { ...release(), body };
      },
    });

    await assert.rejects(() => publishHomebrewRelease(input(), fake), expected);
    assert.deepEqual(fake.calls, ["get tap", "get release"]);
  }
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
    "get tap",
    "get release",
    "get formula",
    "download",
    "published version",
    "public asset",
    "put formula new",
  ]);
});

test("a partial publication advances an older formula from the verified asset", async () => {
  const fake = services({
    getRelease: async () => {
      fake.calls.push("get release");
      return release();
    },
    getTapFormula: async () => {
      fake.calls.push("get formula");
      return {
        sha: "old-formula-sha",
        content: formulaFor("v1.2.2", "1.2.2", "b".repeat(64)),
      };
    },
  });

  const result = await publishHomebrewRelease(input(), fake);

  assert.equal(result.outcome, "recovered-formula");
  assert.deepEqual(fake.calls, [
    "get tap",
    "get release",
    "get formula",
    "download",
    "published version",
    "public asset",
    "put formula old-formula-sha",
  ]);
});

test("a malformed tap version is refused with the publisher's own diagnostic", async () => {
  const malformed = formulaFor("v1.2.3", "1.2.3", DIGEST).replace(
    'version "1.2.3"',
    'version "1.2"',
  );
  const fake = services({
    getRelease: async () => {
      fake.calls.push("get release");
      return release();
    },
    getTapFormula: async () => {
      fake.calls.push("get formula");
      return { sha: "formula-sha", content: malformed };
    },
  });

  await assert.rejects(
    () => publishHomebrewRelease(input(), fake),
    /publish-homebrew-release: the tap formula has invalid version "1\.2"/,
  );
  assert.deepEqual(fake.calls, [
    "get tap",
    "get release",
    "get formula",
    "download",
    "published version",
    "public asset",
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

test("a private artifact destination refuses before any release or tap mutation", async () => {
  const fake = services({
    getTapRepository: async () => {
      fake.calls.push("get tap");
      return { visibility: "private", initialized: true };
    },
  });

  await assert.rejects(
    () => publishHomebrewRelease(input(), fake),
    /homebrew-tap must be public before publishing/,
  );
  assert.deepEqual(fake.calls, ["get tap"]);
});

test("an artifact destination without commits refuses and names the seed step", async () => {
  const fake = services({
    getTapRepository: async () => {
      fake.calls.push("get tap");
      return { visibility: "public", initialized: false };
    },
  });

  await assert.rejects(
    () => publishHomebrewRelease(input(), fake),
    /has no commits; seed it with one commit on its default branch/,
  );
  assert.deepEqual(fake.calls, ["get tap"]);
});

test("an anonymously unreachable uploaded asset never reaches the public tap", async () => {
  const fake = services({
    assertPublicAsset: async () => {
      fake.calls.push("public asset");
      throw new Error("anonymous asset probe returned 404");
    },
  });

  await assert.rejects(
    () => publishHomebrewRelease(input(), fake),
    /anonymous asset probe returned 404/,
  );
  assert.deepEqual(fake.calls, [
    "get tap",
    "get release",
    "get formula",
    "build",
    "version",
    "read",
    "create release",
    "upload",
    "public asset",
  ]);
});

test("only the tag-triggered publishing job can declare the tap environment", { skip: workflowSkip }, () => {
  const workflows = readdirSync(WORKFLOW_ROOT)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => [name, readFileSync(join(WORKFLOW_ROOT, name), "utf8")]);
  const declarations = workflows.flatMap(([name, body]) =>
    [...body.matchAll(/homebrew-tap/g)].map(() => name),
  );
  assert.deepEqual(declarations, ["release-homebrew.yml"]);

  const releaseWorkflow = workflows.find(([name]) => name === "release-homebrew.yml")?.[1];
  assert.ok(releaseWorkflow);
  assert.match(releaseWorkflow, /^on:\n\s+push:\n\s+tags:/m);
  assert.doesNotMatch(releaseWorkflow, /^\s+branches:|^\s+pull_request:/m);
  assert.equal((releaseWorkflow.match(/^\s+HOMEBREW_TAP_TOKEN:/gm) ?? []).length, 1);
});
