#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeDigest, withMcpSession } from "./lib/homebrew-proof.mjs";

const [formulaName, expectedVersion, formulaPath] = process.argv.slice(2);
if (formulaName === undefined || expectedVersion === undefined || formulaPath === undefined) {
  throw new Error(
    "usage: node scripts/homebrew-formula-proof.mjs <tap/formula> <version> <formula-path>",
  );
}
if (
  !(process.platform === "darwin" && process.arch === "arm64") &&
  !(process.platform === "linux" && process.arch === "x64")
) {
  throw new Error(
    `Homebrew proof needs Apple Silicon macOS or Linux x86_64, got ${process.platform}/${process.arch}`,
  );
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
  await withMcpSession(
    {
      cwd,
      env: proofEnv,
      clientName: "homebrew-formula-proof",
      clientVersion: expectedVersion,
    },
    async (callTool) => {
      const listed = await callTool("list_docs");
      expect(Array.isArray(listed.docs), "list_docs returned no docs array");
    },
  );
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
