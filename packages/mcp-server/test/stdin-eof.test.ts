import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PACKAGE_ROOT, mainTsProcess } from "./helpers.js";

const WORKSPACE = "9c1f0b4a-6d27-4e83-9b5a-1f2e3d4c5b6a";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("shuts down cleanly when redirected stdin is already at EOF", async () => {
  const dataHome = mkdtempSync(join(tmpdir(), "uberblick-stdin-eof-"));
  tempDirs.push(dataHome);
  const { command, args } = mainTsProcess();
  const child = spawn(command, args, {
    cwd: PACKAGE_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      WORKSPACE_ID: WORKSPACE,
      XDG_DATA_HOME: dataHome,
    },
    // `ignore` connects stdin to /dev/null, the non-pipe EOF case from #102.
    stdio: ["ignore", "pipe", "pipe"],
  });

  const result = await new Promise<{ code: number | null; stdout: string }>(
    (resolve, reject) => {
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stdout }));
    },
  );

  expect(result).toEqual({ code: 0, stdout: "" });
}, 10_000);
