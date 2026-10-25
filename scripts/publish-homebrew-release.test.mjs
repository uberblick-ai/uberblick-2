import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  formulaFor,
  productionServices,
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
    verifyAttestation: async (bytes, name, context) => {
      assert.deepEqual(bytes, BYTES);
      assert.equal(name, `uberblick-${VERSION}.tar.gz`);
      assert.deepEqual(context, input());
      calls.push("verify attestation");
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
      return { ...release(), draft: true, assets: [] };
    },
    uploadAsset: async () => {
      calls.push("upload");
      return release().assets[0];
    },
    publishRelease: async () => {
      calls.push("publish release");
      return release();
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
    id: 123,
    tag_name: TAG,
    body: releaseBody(VERSION, HEAD_SHA),
    draft: false,
    prerelease: false,
    upload_url: "https://uploads.github.test/assets{?name,label}",
    assets: [
      {
        id: 456,
        name: `uberblick-${VERSION}.tar.gz`,
        state: "uploaded",
        size: BYTES.length,
        digest: `sha256:${DIGEST}`,
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
      return { ...release(), draft: true, assets: [] };
    },
  });

  const result = await publishHomebrewRelease(input(), fake);

  assert.equal(result.outcome, "published");
  assert.equal(result.archive, "/fixture/archive");
  assert.deepEqual(fake.calls, [
    "get tap",
    "get release",
    "get formula",
    "build",
    "version",
    "read",
    "create release",
    "upload",
    "download",
    "publish release",
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
  assert.equal(result.archive, undefined);
  assert.deepEqual(fake.calls, [
    "get tap",
    "get release",
    "get formula",
    "download",
    "verify attestation",
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
    "verify attestation",
    "published version",
  ]);
});

test("reused payloads require provenance before executing the payload or recovering the formula", async () => {
  for (const draft of [false, true]) {
    const fake = services({
      getRelease: async () => {
        fake.calls.push("get release");
        return { ...release(), draft };
      },
      getTapFormula: async () => {
        fake.calls.push("get formula");
        return null;
      },
      verifyAttestation: async () => {
        fake.calls.push("verify attestation");
        throw new Error("missing or invalid provenance");
      },
    });

    await assert.rejects(() => publishHomebrewRelease(input(), fake),
      draft ? /inspect and delete the unpublished draft, then re-run/ : /missing or invalid provenance/);
    assert.deepEqual(fake.calls, [
      "get tap",
      "get release",
      "get formula",
      "download",
      "verify attestation",
    ]);
  }
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
    [releaseBody(VERSION, "b".repeat(40)), /records source commit b{40}, not a{40}/],
    ["Uberblick 1.2.3", /records source commit \(none recorded\), not a{40}/],
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
  assert.equal(result.archive, undefined);
  assert.deepEqual(fake.calls, [
    "get tap",
    "get release",
    "get formula",
    "download",
    "verify attestation",
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
  assert.equal(result.archive, undefined);
  assert.deepEqual(fake.calls, [
    "get tap",
    "get release",
    "get formula",
    "download",
    "verify attestation",
    "published version",
    "public asset",
    "put formula old-formula-sha",
  ]);
});

test("a draft missing its payload uploads, verifies, publishes, then commits the formula", async () => {
  const fake = services({
    getRelease: async () => {
      fake.calls.push("get release");
      return { ...release(), draft: true, assets: [] };
    },
  });

  const result = await publishHomebrewRelease(input(), fake);

  assert.equal(result.outcome, "published");
  assert.equal(result.archive, "/fixture/archive");
  assert.deepEqual(fake.calls, [
    "get tap", "get release", "get formula", "build", "version", "read",
    "upload", "download", "publish release", "public asset", "put formula new",
  ]);
});

test("an interrupted draft requires inspection and deletion before the same tag can be rebuilt", async () => {
  let draft = null;
  let interruptPublication = true;
  let attested = false;
  const fake = services({
    getRelease: async () => {
      fake.calls.push("get release");
      return draft;
    },
    createRelease: async () => {
      fake.calls.push("create release");
      draft = { ...release(), draft: true, assets: [] };
      return draft;
    },
    uploadAsset: async () => {
      fake.calls.push("upload");
      const asset = { ...release().assets[0], browser_download_url: "https://github.test/untagged/payload" };
      draft.assets.push(asset);
      return asset;
    },
    publishRelease: async () => {
      fake.calls.push("publish release");
      if (interruptPublication) throw new Error("publication interrupted");
      return release();
    },
    verifyAttestation: async () => {
      fake.calls.push("verify attestation");
      if (!attested) throw new Error("No verified release provenance; use a new version.");
    },
  });
  async function workflow() {
    const result = await publishHomebrewRelease(input(), fake);
    if (result.outcome === "published" && result.archive !== undefined) attested = true;
    return result;
  }

  await assert.rejects(workflow, /publication interrupted/);
  assert.equal(draft.draft, true);
  assert.equal(draft.assets.length, 1);
  assert.equal(attested, false);
  fake.calls.length = 0;

  await assert.rejects(workflow, (error) => {
    assert.match(error.message, /inspect and delete the unpublished draft, then re-run/);
    assert.doesNotMatch(error.message, /new version/);
    assert.match(error.cause.message, /No verified release provenance/);
    return true;
  });
  assert.deepEqual(fake.calls, [
    "get tap", "get release", "get formula", "download", "verify attestation",
  ]);

  draft = null;
  interruptPublication = false;
  fake.calls.length = 0;
  const result = await workflow();
  assert.equal(result.outcome, "published");
  assert.equal(result.archive, "/fixture/archive");
  assert.equal(result.formula, formulaFor(TAG, VERSION, DIGEST));
  assert.ok(fake.calls.includes("build"));
  assert.equal(attested, true);
});

test("a published release missing its required payload is never repaired", async () => {
  for (const assets of [[], [{ ...release().assets[0], name: "unexpected.tar.gz" }]]) {
    const fake = services({
      getRelease: async () => {
        fake.calls.push("get release");
        return { ...release(), assets };
      },
    });
    await assert.rejects(
      () => publishHomebrewRelease(input(), fake),
      /published release v1\.2\.3 is missing uberblick-1\.2\.3\.tar\.gz; recover with a new version/,
    );
    assert.deepEqual(fake.calls, ["get tap", "get release"]);
  }
});

test("a draft refuses incomplete, duplicate, or differing payloads before publication", async () => {
  for (const [assets, expected] of [
    [[{ ...release().assets[0], state: "starter" }], /not completely uploaded/],
    [[release().assets[0], release().assets[0]], /more than one .* asset/],
    [[{ ...release().assets[0], size: BYTES.length + 1 }], /differs from the intended payload/],
    [[{ ...release().assets[0], digest: `sha256:${"f".repeat(64)}` }], /differs from the intended payload/],
    [[{ ...release().assets[0], name: "unexpected.tar.gz" }], /has assets, but not uberblick/],
  ]) {
    const fake = services({
      getRelease: async () => ({ ...release(), draft: true, assets }),
    });
    await assert.rejects(() => publishHomebrewRelease(input(), fake), expected);
    assert.ok(!fake.calls.includes("publish release"));
    assert.ok(!fake.calls.some((call) => call.startsWith("put formula")));
  }
});

test("a newly uploaded payload must hold the exact prepared bytes before publication", async () => {
  const fake = services({
    uploadAsset: async () => {
      fake.calls.push("upload");
      return { ...release().assets[0], digest: null };
    },
    downloadAsset: async () => {
      fake.calls.push("download");
      return Buffer.alloc(BYTES.length, "x");
    },
  });

  await assert.rejects(() => publishHomebrewRelease(input(), fake), /differs from the intended payload/);
  assert.equal(fake.calls.at(-1), "download");
  assert.ok(!fake.calls.includes("publish release"));
});

test("draft payload version, recorded source, and formula disagreements refuse before publication", async () => {
  for (const [overrides, expected] of [
    [{ publishedArchiveVersion: async () => "1.2.4" }, /published payload reports "1\.2\.4"/],
    [{ getRelease: async () => ({ ...release(), draft: true, body: releaseBody(VERSION, "b".repeat(40)) }) }, /records source commit/],
    [{ getTapFormula: async () => ({ sha: "formula-sha", content: formulaFor(TAG, VERSION, "c".repeat(64)) }) }, /asset .* and the tap formula disagree/],
  ]) {
    const fake = services({
      getRelease: async () => ({ ...release(), draft: true }),
      ...overrides,
    });
    await assert.rejects(() => publishHomebrewRelease(input(), fake), expected);
    assert.ok(!fake.calls.includes("publish release"));
    assert.ok(!fake.calls.some((call) => call.startsWith("put formula")));
  }
});

test("a release for another tag or a prerelease is not reused, including drafts", async () => {
  for (const overrides of [
    { tag_name: "v1.2.4" },
    { prerelease: true },
    { draft: true, prerelease: true },
  ]) {
    const fake = services({
      getRelease: async () => ({ ...release(), ...overrides }),
    });
    await assert.rejects(() => publishHomebrewRelease(input(), fake), /immutable stable-tag contract/);
    assert.deepEqual(fake.calls, ["get tap"]);
  }
});

test("a failed or invalid publication never probes publicly or commits the formula", async () => {
  for (const publishRelease of [
    async () => { throw new Error("publish refused"); },
    async () => ({ ...release(), draft: true }),
    async () => ({ ...release(), prerelease: true }),
    async () => ({ ...release(), assets: [] }),
  ]) {
    const fake = services({ publishRelease });
    await assert.rejects(() => publishHomebrewRelease(input(), fake));
    assert.ok(!fake.calls.includes("public asset"));
    assert.ok(!fake.calls.some((call) => call.startsWith("put formula")));
  }
});

test("the production adapter discovers drafts across every release page and refuses ambiguous tags", async (t) => {
  const draft = { ...release(), draft: true };
  const calls = [];
  const pages = [
    Array.from({ length: 100 }, () => ({ tag_name: "v0.0.1" })),
    [draft],
    draft.assets,
  ];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json(pages.shift());
  });
  const adapter = productionServices("fixture-tap-token");

  assert.deepEqual(await adapter.getRelease(TAG), draft);
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/releases\?per_page=100&page=1$/);
  assert.match(calls[1].url, /\/releases\?per_page=100&page=2$/);
  assert.match(calls[2].url, /\/releases\/123\/assets\?per_page=100&page=1$/);
  assert.equal(calls[0].options.headers.authorization, "Bearer fixture-tap-token");
  pages.push([release(), draft]);
  await assert.rejects(() => adapter.getRelease(TAG), /more than one release, including drafts/);
  pages.push([]);
  assert.equal(await adapter.getRelease(TAG), null);
});

test("the production adapter checks required assets beyond the first full asset page", async (t) => {
  const pages = [];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    return Response.json(pages.shift());
  });
  const adapter = productionServices("fixture-tap-token");
  const unrelated = Array.from({ length: 100 }, (_, id) => ({ id, name: `other-${id}` }));
  for (const [firstPage, finalAsset, expected] of [
    [[release().assets[0], ...unrelated.slice(1)], release().assets[0], /more than one .* asset/],
    [unrelated, { ...release().assets[0], state: "starter" }, /not completely uploaded/],
  ]) {
    pages.push([{ ...release(), draft: true, assets: [] }], firstPage, [finalAsset]);
    const fake = services({ getRelease: adapter.getRelease });
    await assert.rejects(() => publishHomebrewRelease(input(), fake), expected);
    assert.ok(!fake.calls.includes("upload"));
    assert.ok(!fake.calls.includes("publish release"));
    assert.match(calls.at(-1), /\/releases\/123\/assets\?per_page=100&page=2$/);
  }
});

test("the production adapter creates drafts, reads asset bytes by authenticated ID, and publishes before public probing", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/releases/assets/456")) return new Response(BYTES);
    if (options.method === "HEAD") return new Response(null);
    return Response.json(release());
  });
  const adapter = productionServices("fixture-tap-token");

  await adapter.createRelease(TAG, releaseBody(VERSION, HEAD_SHA));
  assert.deepEqual(await adapter.downloadAsset(release().assets[0]), BYTES);
  await adapter.publishRelease(123);
  await adapter.assertPublicAsset(ASSET_URL);

  const create = JSON.parse(calls[0].options.body);
  assert.equal(create.draft, true);
  assert.equal(create.prerelease, false);
  assert.equal(create.tag_name, TAG);
  assert.equal(calls[1].options.headers.accept, "application/octet-stream");
  assert.equal(calls[1].options.headers.authorization, "Bearer fixture-tap-token");
  assert.match(calls[2].url, /\/releases\/123$/);
  assert.equal(calls[2].options.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[2].options.body), { draft: false });
  assert.equal(calls[3].url, ASSET_URL);
  assert.deepEqual(calls[3].options, { method: "HEAD" });
  await assert.rejects(() => adapter.downloadAsset({ id: "456" }), /no valid ID/);
});

test("a dry run builds the payload but reaches no repository API", async () => {
  const output = [];
  const fake = services({
    getRelease: async () => assert.fail("dry-run read the release"),
    getTapFormula: async () => assert.fail("dry-run read the tap"),
    createRelease: async () => assert.fail("dry-run created a release"),
    uploadAsset: async () => assert.fail("dry-run uploaded an asset"),
    putTapFormula: async () => assert.fail("dry-run wrote the tap"),
    verifyAttestation: async () => assert.fail("dry-run verified an attestation"),
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
    "download",
    "publish release",
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
