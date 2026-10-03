/** The operator wrapper enters the running hub through the deployment gate. */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../hub-admin-setup.sh", import.meta.url));
const WORKSPACE = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const SETUP = "5b2d7e10-4c33-4f92-9e08-71a6d3c85220";
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function run(args: string[], exitCode = 0, terminal = false) {
  const directory = mkdtempSync(join(tmpdir(), `uberblick-${process.env.UB_AGENTS_RUN ?? "test"}-admin-wrapper-`));
  directories.push(directory);
  copyFileSync(SCRIPT, join(directory, "hub-admin-setup.sh"));
  const capture = join(directory, "compose-arguments");
  writeFileSync(join(directory, "remote-compose.sh"), `#!/bin/sh
printf '%s\\n' "$PWD" "$@" > "$UB_TEST_ADMIN_CAPTURE"
exit "$UB_TEST_ADMIN_EXIT"
`);
  const command = [join(directory, "hub-admin-setup.sh"), ...args];
  // Use the same cross-platform PTY utility as the CLI's welcome-script tests.
  const scriptArgs = process.platform === "darwin"
    ? ["-q", "/dev/null", "/bin/sh", ...command]
    : ["-qec", `/bin/sh ${command.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")}`, "/dev/null"];
  const result = spawnSync(terminal ? "script" : "sh", terminal ? scriptArgs : command, {
    cwd: tmpdir(),
    env: { ...process.env, UB_TEST_ADMIN_CAPTURE: capture, UB_TEST_ADMIN_EXIT: String(exitCode) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  return { directory, capture, result };
}

describe("first-admin host wrapper", () => {
  it.each([[WORKSPACE], ["status", SETUP]])("runs %j inside the hub through remote-compose.sh", (...args) => {
    const { directory, capture, result } = run(args, 7);
    expect(result.status).toBe(7);
    expect(readFileSync(capture, "utf8").trimEnd().split("\n")).toEqual([
      directory, "exec", "-T", "hub", "node", "/app/hub-admin-setup.mjs", ...args,
    ]);
  });

  it.each([[WORKSPACE], ["status", SETUP]])("gives terminal input %j a container TTY so Ctrl-C can reach the command", (...args) => {
    const { directory, capture, result } = run(args, 0, true);
    expect(result.status).toBe(0);
    expect(readFileSync(capture, "utf8").trimEnd().split("\n")).toEqual([
      directory, "exec", "hub", "node", "/app/hub-admin-setup.mjs", ...args,
    ]);
  });

  it.each([[], ["status"], [WORKSPACE, "extra"], ["status", SETUP, "extra"]])("refuses an incomplete invocation %j", (...args) => {
    const { result } = run(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
  });
});
