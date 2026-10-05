import assert from "node:assert/strict";
import { test } from "node:test";
import { assertHomebrewPlatform } from "./lib/homebrew-proof.mjs";

test("Homebrew proof accepts Apple Silicon macOS and Linux x86_64 only", () => {
  for (const [platform, arch] of [["darwin", "arm64"], ["linux", "x64"]]) {
    assert.doesNotThrow(() => assertHomebrewPlatform(platform, arch));
  }
  for (const [platform, arch] of [["darwin", "x64"], ["linux", "arm64"], ["win32", "x64"]]) {
    assert.throws(() => assertHomebrewPlatform(platform, arch), /Apple Silicon macOS or Linux x86_64/);
  }
});
