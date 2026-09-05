#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const [formulaName, expectedVersion, formulaPath] = process.argv.slice(2);
if (formulaName === undefined || expectedVersion === undefined || formulaPath === undefined) {
  throw new Error(
    "usage: node scripts/homebrew-formula-proof.mjs <tap/formula> <version> <formula-path>",
  );
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(`Homebrew proof needs Apple Silicon macOS, got ${process.platform}/${process.arch}`);
}

const scratch = mkdtempSync(join(tmpdir(), "uberblick-homebrew-proof-"));
const cwd = join(scratch, "cwd");
const configHome = process.env.XDG_CONFIG_HOME ?? join(scratch, "config");
const dataHome = process.env.XDG_DATA_HOME ?? join(scratch, "data");
mkdirSync(cwd, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: proofEnv,
    encoding: "utf8",
    timeout: 120_000,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} ${result.signal === null ? `exited ${result.status}` : `ended from ${result.signal}`}: ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function treeDigest(root) {
  const hash = createHash("sha256");
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      hash.update(relative(root, path));
      hash.update(String(stat.mode));
      if (stat.isDirectory()) visit(path);
      else hash.update(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
    }
  };
  visit(root);
  return hash.digest("hex");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not reserve a web port"));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

async function listDocsOverStdio() {
  const child = spawn("ub", ["mcp", "serve"], {
    cwd,
    env: proofEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  const failPending = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        failPending(new Error(`MCP server wrote non-JSON stdout: ${line.slice(0, 120)}`));
        continue;
      }
      const waiter = pending.get(message.id);
      if (waiter === undefined) continue;
      pending.delete(message.id);
      if (message.error === undefined) waiter.resolve(message.result);
      else waiter.reject(new Error(message.error.message));
    }
  });
  child.once("exit", (code, signal) => {
    failPending(
      new Error(
        `ub mcp serve ${signal === null ? `exited ${code}` : `ended from ${signal}`}: ${stderr}`,
      ),
    );
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const deadline = setTimeout(() => {
    failPending(new Error(`ub mcp serve did not answer within 60s: ${stderr}`));
    child.kill("SIGKILL");
  }, 60_000);
  try {
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "homebrew-formula-proof", version: expectedVersion },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const result = await request("tools/call", { name: "list_docs", arguments: {} });
    const text = result?.content?.[0]?.text;
    expect(typeof text === "string", "list_docs returned no text content");
    const listed = JSON.parse(text);
    expect(Array.isArray(listed.docs), "list_docs returned no docs array");
  } finally {
    clearTimeout(deadline);
    child.stdin.end();
    child.kill("SIGTERM");
    await closed;
  }
}

async function proveOpen() {
  const port = await freePort();
  const child = spawn("ub", ["open", "--no-browser", "--port", String(port)], {
    cwd,
    env: proofEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  let stopped = false;
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      stopped = true;
      resolve({ code, signal });
    }),
  );
  const deadline = Date.now() + 60_000;
  try {
    for (;;) {
      if (stopped) throw new Error(`ub open stopped before serving: ${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) {
          expect((await response.text()).includes('id="root"'), "ub open served no app shell");
          break;
        }
      } catch {
        // The server has not bound yet.
      }
      if (Date.now() >= deadline) throw new Error(`ub open did not serve within 60s: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    if (!stopped) child.kill("SIGINT");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const outcome = await closed;
    clearTimeout(timer);
    expect(outcome.code === 0 && outcome.signal === null, `ub open stopped uncleanly: ${output}`);
  }
}

const brewPrefix = spawnSync("brew", ["--prefix"], { encoding: "utf8" }).stdout.trim();
const formulaPrefix = spawnSync("brew", ["--prefix", formulaName], {
  encoding: "utf8",
}).stdout.trim();
expect(brewPrefix !== "" && formulaPrefix !== "", "Homebrew did not report its prefixes");
expect(
  formulaPrefix.startsWith(`${brewPrefix}/`),
  `formula prefix ${formulaPrefix} is outside Homebrew prefix ${brewPrefix}`,
);
const installedFiles = spawnSync("brew", ["list", "--formula", formulaName], {
  encoding: "utf8",
}).stdout
  .trim()
  .split("\n")
  .filter(Boolean);
expect(installedFiles.length > 0, "Homebrew reported no installed formula files");
expect(
  installedFiles.every((path) => path.startsWith(`${brewPrefix}/`)),
  "the formula installed a file outside Homebrew's prefix",
);
const foreignBin = join(scratch, "foreign-bin");
mkdirSync(foreignBin);
writeFileSync(join(foreignBin, "node"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
chmodSync(join(foreignBin, "node"), 0o755);

const proofEnv = {
  ...process.env,
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: configHome,
  XDG_DATA_HOME: dataHome,
  PATH: `${foreignBin}:${brewPrefix}/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
};
for (const key of ["HUB_AUTH_TOKEN", "HUB_DB_PATH", "HUB_URL", "UBERBLICK_DB", "WORKSPACE_ID", "WORKSPACES"]) {
  delete proofEnv[key];
}

try {
  expect(!lstatExists(join(configHome, "uberblick")), "formula installation created Uberblick config");
  expect(!lstatExists(join(dataHome, "uberblick")), "formula installation created Uberblick data");
  const formula = readFileSync(formulaPath, "utf8");
  expect(!formula.includes("service do"), "formula registers a Homebrew service");
  expect(!formula.includes("post_install"), "formula runs post-install code");

  const initialDigest = treeDigest(formulaPrefix);
  expect(run("ub", ["--version"]) === expectedVersion, "ub reported the wrong version");
  expect(
    run("uberblick", ["--version"]) === expectedVersion,
    "uberblick reported the wrong version",
  );
  const initialized = run("ub", ["init", "--yes", "--no-mcp"]);
  expect(initialized.includes("ub open"), "installed init gave no ub open next step");
  expect(!/mise run|pnpm/.test(initialized), "installed init mentioned contributor tooling");
  const status = JSON.parse(run("ub", ["status", "--json"]));
  expect(status.version === expectedVersion, "installed status reported the wrong version");
  await listDocsOverStdio();
  await proveOpen();
  expect(treeDigest(formulaPrefix) === initialDigest, "payload changed while its journeys ran");
  process.stdout.write(
    `homebrew formula proof: ${formulaName} ${expectedVersion} on ${process.arch} passed\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
