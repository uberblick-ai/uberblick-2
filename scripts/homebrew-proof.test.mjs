import assert from "node:assert/strict";
import { test } from "node:test";
import { assertHomebrewPlatform } from "./lib/homebrew-proof.mjs";

for (const [platform, arch, supported] of [
  ["darwin", "arm64", true],
  ["linux", "x64", true],
  ["darwin", "x64", false],
  ["linux", "arm64", false],
  ["win32", "x64", false],
  ["freebsd", "x64", false],
  ["linux", "ia32", false],
]) {
  test(`Homebrew proof ${supported ? "accepts" : "refuses"} ${platform}/${arch}`, () => {
    const check = () => assertHomebrewPlatform(platform, arch);
    if (supported) assert.doesNotThrow(check);
    else assert.throws(check, {
      message: `Homebrew proof needs Apple Silicon macOS or Linux x86_64, got ${platform}/${arch}`,
    });
  });
}
