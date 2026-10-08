/** Interactive init wiring against the real binary and its durable update log. */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { resolveMcpConfig, storeWorkspaceName } from "@uberblick/mcp-server";
import { getWorkspaceName, parseWorkspaceId, settingsRoom } from "@uberblick/schema";
import * as Y from "yjs";
import { afterAll, expect, it } from "vitest";
import { acquireInitLock, seedLockPath } from "../src/init-lock.js";
import {
  UB_BIN,
  hubless,
  removeTempDirs,
  runUb,
  unboundSandbox as anyUnboundSandbox,
  waitUntil,
} from "./helpers.js";
import type { Run, Sandbox, SandboxFiles } from "./helpers.js";

afterAll(removeTempDirs);

/** No test here starts a hub, so none waits for one; see {@link hubless}. */
function unboundSandbox(files?: SandboxFiles): Sandbox {
  return hubless(anyUnboundSandbox(files));
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const IDENTITY = "A person's display name";

function workspace(box: Sandbox): string {
  return JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8")).workspaceId;
}

/** Read only persisted Yjs state; no later reader can repair the init result. */
function nameFromLog(box: Sandbox): string | null {
  const config = resolveMcpConfig({ ...box.env, WORKSPACE_ID: workspace(box) });
  if (!existsSync(config.databasePath)) return null;
  const doc = new Y.Doc();
  const db = new DatabaseSync(config.databasePath, { readOnly: true });
  try {
    const room = settingsRoom(config.workspaceId);
    for (const row of db.prepare("SELECT state FROM snapshots WHERE room = ?").all(room)) {
      Y.applyUpdate(doc, new Uint8Array(row.state as Uint8Array));
    }
    for (const row of db.prepare("SELECT payload FROM updates WHERE room = ? ORDER BY seq").all(room)) {
      Y.applyUpdate(doc, new Uint8Array(row.payload as Uint8Array));
    }
    return getWorkspaceName(doc);
  } finally {
    db.close();
    doc.destroy();
  }
}

/**
 * Replace only terminal input, through Node's supported builtin-module seam.
 * All command wiring, locking, persistence and exits run in a real process.
 * There is no product environment flag for the optional workspace name.
 */
function namedInit(
  box: Sandbox,
  answer: string,
  options: {
    args?: string[];
    failStarters?: boolean;
    onStdout?: (text: string) => void;
    promptBarrier?: string;
  } = {},
): Promise<Run> {
  const preload = join(box.cwd, `terminal-${randomUUID()}.mjs`);
  writeFileSync(preload, `
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url);
const readline = require("node:readline/promises");
Object.defineProperty(process.stdin, "isTTY", { value: true });
readline.createInterface = () => ({
  question: async (prompt) => {
    process.stdout.write(prompt);
    ${options.promptBarrier === undefined ? "" : `
    while (!require("node:fs").existsSync(${JSON.stringify(options.promptBarrier)})) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }`}
    return prompt.startsWith("workspace name") ? ${JSON.stringify(answer)} : "";
  },
  close: () => {},
});
${options.failStarters === true ? `
const fs = require("node:fs");
const readdir = fs.readdirSync;
fs.readdirSync = (path, ...args) => {
  if (String(path).endsWith("/templates")) throw new Error("starter read refused");
  return readdir(path, ...args);
};` : ""}
syncBuiltinESMExports();
`, "utf8");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import", pathToFileURL(preload).href,
      UB_BIN, "init", "--name", IDENTITY, "--color", "#0e8085", "--no-mcp",
      ...(options.args ?? []),
    ], { cwd: box.cwd, env: box.env, timeout: 25_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      options.onStdout?.(stdout);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (child.killed) stderr += "\nnamed init exceeded its 25-second deadline\n";
      resolve({ status, stdout, stderr, output: stdout + stderr });
    });
  });
}

it("asks for a shared name and derives its cosmetic slug from the trimmed answer", async () => {
  const box = unboundSandbox();
  const run = await namedInit(box, "  Product Research  ");
  expect(run.status, run.output).toBe(0);
  expect(run.stdout).toContain("workspace name (optional;");
  expect(workspace(box)).toMatch(/^product-research-/);
  expect(parseWorkspaceId(workspace(box)).uuid).toMatch(UUID);
  expect(nameFromLog(box)).toBe("Product Research");
  const config = JSON.parse(readFileSync(join(box.configHome, "uberblick", "config.json"), "utf8"));
  expect(config.displayName).toBe(IDENTITY);
  expect(config).not.toHaveProperty("workspaceName");
  expect(config).not.toHaveProperty("name");
});

it("stores a name with no ASCII slug under a bare UUID", async () => {
  const box = unboundSandbox();
  const run = await namedInit(box, "研究");
  expect(run.status, run.output).toBe(0);
  expect(workspace(box)).toMatch(UUID);
  expect(nameFromLog(box)).toBe("研究");
});

it("leaves a blank interactive answer unnamed", async () => {
  const box = unboundSandbox();
  const run = await namedInit(box, "   ");
  expect(run.status, run.output).toBe(0);
  expect(workspace(box)).toMatch(UUID);
  expect(nameFromLog(box)).toBeNull();
});

it("leaves unattended init unnamed", () => {
  const box = unboundSandbox();
  const run = runUb(["init", "--name", IDENTITY, "--no-mcp"], box);
  expect(run.status, run.output).toBe(0);
  expect(workspace(box)).toMatch(UUID);
  expect(nameFromLog(box)).toBeNull();
});

it.each(["x".repeat(65), "bad\u0000name"])("refuses invalid names before writing (%j)", async (answer) => {
  const box = unboundSandbox();
  const run = await namedInit(box, answer);
  expect(run.status, run.output).toBe(2);
  expect(run.stderr).toContain("Workspace name must be 1–64 characters");
  expect(existsSync(join(box.configHome, "uberblick", "config.json"))).toBe(false);
  expect(existsSync(join(box.configHome, "uberblick", "credentials.json"))).toBe(false);
  expect(existsSync(box.dataHome)).toBe(false);
});

it("never infers a name from an explicit decorated id, or overwrites an existing name", async () => {
  const id = "old-address-64e4bc22-dfd0-4f06-a898-3bc3b0e512e8";
  const box = unboundSandbox();
  const joined = await namedInit(box, "Never written", { args: ["--workspace", id] });
  expect(joined.status, joined.output).toBe(0);
  expect(joined.stdout).not.toContain("workspace name");
  expect(nameFromLog(box)).toBeNull();
  storeWorkspaceName(resolveMcpConfig({ ...box.env, WORKSPACE_ID: id }), "Current shared name");
  const rerun = await namedInit(box, "Never written either");
  expect(rerun.status, rerun.output).toBe(0);
  expect(rerun.stdout).not.toContain("workspace name");
  expect(workspace(box)).toBe(id);
  expect(nameFromLog(box)).toBe("Current shared name");
});

it("durably stores a named creator's answer when another run holds the seed lock", async () => {
  const box = unboundSandbox();
  const lock = await acquireInitLock(box.env, { path: seedLockPath(box.env) });
  try {
    const run = await namedInit(box, "Product Research");
    expect(run.status, run.output).toBe(0);
    expect(run.stderr).toContain("left the starter documents to it");
    expect(nameFromLog(box)).toBe("Product Research");
  } finally {
    lock.release();
  }
});

it("durably stores a name even when starter-document reading fails", async () => {
  const box = unboundSandbox();
  const run = await namedInit(box, "Product Research", { failStarters: true });
  expect(run.status, run.output).toBe(0);
  expect(run.stderr).toContain("starter read refused");
  expect(nameFromLog(box)).toBe("Product Research");
});

it("an adopting concurrent init never writes its proposed answer to the claimed workspace", async () => {
  const box = unboundSandbox();
  const seedLock = await acquireInitLock(box.env, { path: seedLockPath(box.env) });
  const barrier = join(box.cwd, "release-prompts");
  const prompted = [false, false];
  const answers = ["First name", "Second name"];
  const runs = answers.map((answer, index) => namedInit(box, answer, {
    promptBarrier: barrier,
    onStdout: (text) => { prompted[index] = text.includes("workspace name"); },
  }));
  try {
    await waitUntil("both named runs waiting with their UUID proposals", () => prompted.every(Boolean));
    writeFileSync(barrier, "continue", "utf8");
    const results = await Promise.all(runs);
    expect(results.map((run) => run.status), results.map((run) => run.output).join("\n")).toEqual([0, 0]);
    const claimed = parseWorkspaceId(workspace(box));
    const expected = claimed.slug === "first-name" ? answers[0] : answers[1];
    expect(["first-name", "second-name"]).toContain(claimed.slug);
    expect(nameFromLog(box)).toBe(expected);
    for (const run of results) {
      const proposal = run.stdout.match(/the id is ([0-9a-f-]{36})/u)?.[1];
      expect(proposal).toBeDefined();
      if (proposal === claimed.uuid) continue;
      const proposedConfig = resolveMcpConfig({ ...box.env, WORKSPACE_ID: proposal });
      expect(existsSync(proposedConfig.databasePath)).toBe(false);
    }
  } finally {
    writeFileSync(barrier, "continue", "utf8");
    seedLock.release();
    await Promise.allSettled(runs);
  }
});

it("a failed name write exits 1 and points to settings instead of retrying starter seeding", async () => {
  const box = unboundSandbox();
  writeFileSync(box.dataHome, "a file blocks the replica directory", "utf8");
  const run = await namedInit(box, "Product Research");
  expect(run.status, run.output).toBe(1);
  expect(run.stderr).toContain("could not store the workspace name");
  expect(run.stderr).toContain("Workspace Settings → General");
  expect(run.stderr).not.toContain("starter documents");
  expect(run.stderr).not.toContain("run `ub init` again");
  expect(workspace(box)).toMatch(/^product-research-/);
});
