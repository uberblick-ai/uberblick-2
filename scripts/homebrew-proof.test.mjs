import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
