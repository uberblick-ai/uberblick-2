import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Run each real entry point with a simulated runner. Stop at its first brew
// call so these platform checks never install anything or touch host state.
for (const [script, args] of [
  ["homebrew-formula-proof.mjs", ["proof/uberblick", "0.1.0", "Formula/uberblick.rb"]],
  ["homebrew-upgrade-proof.mjs", ["0.1.0", "0.1.1"]],
]) {
  for (const [platform, arch, supported] of [
    ["darwin", "arm64", true],
    ["linux", "x64", true],
    ["darwin", "x64", false],
    ["linux", "arm64", false],
    ["win32", "x64", false],
    ["freebsd", "x64", false],
    ["linux", "ia32", false],
  ]) {
    test(`${script} ${supported ? "accepts" : "refuses"} ${platform}/${arch}`, (t) => {
      const scratch = mkdtempSync(join(tmpdir(), "uberblick-homebrew-platform-test-"));
      t.after(() => rmSync(scratch, { recursive: true, force: true }));
      const preload = `
        import assert from "node:assert/strict";
        import childProcess from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
        Object.defineProperty(process, "arch", { value: ${JSON.stringify(arch)} });
        childProcess.spawnSync = (command) => {
          assert.equal(command, "brew");
          process.stdout.write("reached brew\\n");
          process.exit(0);
        };
        syncBuiltinESMExports();
      `;
      const result = spawnSync(
        process.execPath,
        ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, new URL(script, import.meta.url).pathname, ...args],
        { encoding: "utf8", timeout: 10_000, env: { ...process.env, TMPDIR: scratch } },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      if (supported) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "reached brew\n");
      } else {
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, "");
        assert.ok(result.stderr.includes(`got ${platform}/${arch}`), result.stderr);
      }
    });
  }
}
