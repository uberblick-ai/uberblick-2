import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertHomebrewPlatform, assertReleaseWebIsolation } from "./lib/homebrew-proof.mjs";

test("Homebrew proof accepts Apple Silicon macOS and Linux x86_64 only", () => {
  for (const [platform, arch] of [["darwin", "arm64"], ["linux", "x64"]]) {
    assert.doesNotThrow(() => assertHomebrewPlatform(platform, arch));
  }
  for (const [platform, arch] of [["darwin", "x64"], ["linux", "arm64"], ["win32", "x64"]]) {
    assert.throws(() => assertHomebrewPlatform(platform, arch), /Apple Silicon macOS or Linux x86_64/);
  }
});

test("release web isolation rejects missing JavaScript and builder values in nested assets", () => {
  const scratch = mkdtempSync(join(tmpdir(), "uberblick-web-isolation-test-"));
  try {
    assert.throws(() => assertReleaseWebIsolation(scratch, ["builder-secret"]), /no built web JavaScript/);
    mkdirSync(join(scratch, "assets"));
    const javascript = join(scratch, "assets", "client.js");
    writeFileSync(javascript, 'console.log("runtime configuration");\n');
    assert.doesNotThrow(() => assertReleaseWebIsolation(scratch, ["builder-secret"]));
    writeFileSync(javascript, 'console.log("builder-secret");\n');
    assert.throws(() => assertReleaseWebIsolation(scratch, ["builder-secret"]), /builder configuration reached/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "failed formula prefix lookup", script: '#!/bin/sh\nif [ "$#" -eq 1 ]; then printf "/fixture/homebrew\\n"; else printf "formula lookup fixture failure\\n" >&2; exit 23; fi\n', error: /brew --prefix fixture\/tap\/uberblick exited 23: formula lookup fixture failure/ },
  { name: "missing brew executable", script: null, error: /brew --prefix spawnSync brew ENOENT/ },
]) {
  test(`formula proof reports ${scenario.name}`, {
    skip: !((process.platform === "darwin" && process.arch === "arm64") || (process.platform === "linux" && process.arch === "x64")),
  }, () => {
    const scratch = mkdtempSync(join(tmpdir(), "uberblick-homebrew-discovery-test-"));
    try {
      const temporary = join(scratch, "tmp");
      mkdirSync(temporary);
      if (scenario.script !== null) writeFileSync(join(scratch, "brew"), scenario.script, { mode: 0o755 });
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./homebrew-formula-proof.mjs", import.meta.url)),
        "fixture/tap/uberblick", "0.1.1", "/unused/formula.rb"], {
        cwd: scratch,
        env: { ...process.env, PATH: scratch, TMPDIR: temporary },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, scenario.error);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
