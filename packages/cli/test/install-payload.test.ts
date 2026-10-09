/** The checkout-free archive, exercised through the binaries it ships. */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  REPO_ROOT,
  pointAt,
  removeTempDirs,
  sandbox,
  unboundSandbox,
  waitUntil,
} from "./helpers.js";

const VERSION = "0.1.0";
const WORKSPACE = "956f508d-40ec-43f7-974a-0e71dca68c35";
const BUILD_SCRIPT = join(REPO_ROOT, "scripts", "build-install-payload.mjs");
const scratch = mkdtempSync(join(tmpdir(), "uberblick-install-payload-test-"));
const webFixture = join(scratch, "web");
const output = join(scratch, "output");
const extracted = join(scratch, "extracted");
const nodeBin = join(scratch, "node-bin");
const archive = join(output, `uberblick-${VERSION}.tar.gz`);
const payload = join(extracted, `uberblick-${VERSION}`);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  removeTempDirs();
});

function build(version: string, outputDir = output) {
  return spawnSync(process.execPath, [BUILD_SCRIPT, version], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      UBERBLICK_PAYLOAD_OUTPUT_DIR: outputDir,
      UBERBLICK_PAYLOAD_WEB_DIST: webFixture,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function runtimeEnv(
  box: ReturnType<typeof sandbox>,
  root = payload,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...box.env,
    PATH: `${join(root, "bin")}:${nodeBin}`,
  };
  delete env.FORCE_COLOR;
  env.NO_COLOR = "1";
  return env;
}

function runPayload(
  box: ReturnType<typeof sandbox>,
  args: string[],
  options: { command?: "ub" | "uberblick"; cwd?: string; root?: string } = {},
) {
  return spawnSync(options.command ?? "ub", args, {
    cwd: options.cwd ?? box.cwd,
    env: runtimeEnv(box, options.root),
    encoding: "utf8",
    timeout: 30_000,
  });
}

function filesBelow(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(root);
  return files;
}

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  for (const path of filesBelow(root)) {
    const stat = lstatSync(path);
    hash.update(relative(root, path));
    hash.update(String(stat.mode));
    hash.update(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
  }
  return hash.digest("hex");
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not reserve a port");
  }
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

beforeAll(() => {
  mkdirSync(webFixture, { recursive: true });
  writeFileSync(
    join(webFixture, "index.html"),
    "<!doctype html><title>payload web</title><div id=root></div>\n",
    "utf8",
  );
  writeFileSync(
    join(webFixture, "uberblick-build.json"),
    `${JSON.stringify({ syncProtocolVersion: SYNC_PROTOCOL_VERSION })}\n`,
    "utf8",
  );
  mkdirSync(nodeBin, { recursive: true });
  symlinkSync(process.execPath, join(nodeBin, "node"));

  const built = build(VERSION);
  expect(built.status, built.stderr).toBe(0);
  mkdirSync(extracted, { recursive: true });
  const unpacked = spawnSync("tar", ["-xzf", archive, "-C", extracted], {
    encoding: "utf8",
  });
  expect(unpacked.status, unpacked.stderr).toBe(0);
});

describe("the versioned install payload", () => {
  it("builds web assets without the builder's environment or checkout binding", () => {
    const isolatedOutput = join(scratch, "real-web-output");
    const isolatedExtracted = join(scratch, "real-web-extracted");
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      UBERBLICK_PAYLOAD_OUTPUT_DIR: isolatedOutput,
      UB_WORKSPACE_ID: "builder-89c7e520-1111-4111-8111-123456789abc",
      UB_HUB_URL: "wss://builder-binding.invalid/ws",
      HUB_AUTH_TOKEN: "builder-secret-must-never-reach-the-web-bundle",
    };
    delete environment.UBERBLICK_PAYLOAD_WEB_DIST;
    const built = spawnSync(process.execPath, [BUILD_SCRIPT, VERSION], {
      cwd: REPO_ROOT, env: environment, encoding: "utf8", timeout: 120_000,
    });
    expect(built.status, built.stderr).toBe(0);
    mkdirSync(isolatedExtracted);
    const unpacked = spawnSync("tar", ["-xzf", join(isolatedOutput, `uberblick-${VERSION}.tar.gz`), "-C", isolatedExtracted], {
      encoding: "utf8", timeout: 30_000,
    });
    expect(unpacked.status, unpacked.stderr).toBe(0);
    const bundle = filesBelow(join(isolatedExtracted, `uberblick-${VERSION}`, "packages", "web", "dist"))
      .filter(path => path.endsWith(".js")).map(path => readFileSync(path, "utf8")).join("\n");
    const checkout = JSON.parse(readFileSync(join(REPO_ROOT, ".uberblick.json"), "utf8")) as {
      workspaceId: string; hubUrl: string;
    };
    for (const value of [environment.UB_WORKSPACE_ID, environment.UB_HUB_URL, environment.HUB_AUTH_TOKEN,
      checkout.workspaceId, checkout.workspaceId.slice(-36), checkout.hubUrl]) {
      expect(bundle.includes(value ?? ""), "builder configuration is absent from packaged web assets").toBe(false);
    }
  }, 150_000);

  it("refuses the checkout placeholder as a release version", () => {
    const invalidOutput = join(scratch, "invalid");
    const invalid = build("0.0.0", invalidOutput);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("0.0.0 is not a release");
  });

  it("runs init, status, MCP and the packaged web app with only Node on PATH", async () => {
    const box = unboundSandbox();
    const initialPayload = treeDigest(payload);

    const version = runPayload(box, ["--version"]);
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(VERSION);
    expect(
      runPayload(box, ["--version"], {
        command: "uberblick",
      }).stdout.trim(),
    ).toBe(VERSION);
    const help = runPayload(box, ["--help"]);
    expect(help.status, help.stderr).toBe(0);
    expect(filesBelow(payload).some((path) => path.endsWith(".map"))).toBe(false);

    const initialized = runPayload(box, ["init", "--yes", "--no-mcp"]);
    expect(initialized.status, initialized.stderr).toBe(0);
    expect(initialized.stdout).toContain("ub open");
    expect(initialized.stdout).not.toMatch(/mise run|pnpm/);

    const status = runPayload(box, ["status", "--json"]);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      version: VERSION,
      storage: {
        layout: "xdg",
        config: join(box.configHome, "uberblick", "config.json"),
        data: join(box.dataHome, "uberblick"),
      },
    });

    const transport = new StdioClientTransport({
      command: "ub",
      args: ["mcp", "serve"],
      cwd: box.cwd,
      env: stringEnv(runtimeEnv(box)),
      stderr: "pipe",
    });
    const client = new Client({ name: "install-payload-test", version: VERSION });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("list_docs");
    } finally {
      await client.close();
    }

    const hubPort = await freePort();
    const webPort = await freePort();
    pointAt(box, `ws://127.0.0.1:${hubPort}`);
    const opened = spawn("ub", ["open", "--no-browser", "--port", String(webPort)], {
      cwd: box.cwd,
      env: runtimeEnv(box),
    });
    let stdout = "";
    let stderr = "";
    opened.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    opened.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (done) => opened.on("close", (code, signal) => done({ code, signal })),
    );
    let outcome: Awaited<typeof closed>;
    try {
      await waitUntil("the installed web app to start", () =>
        stdout.includes("uberblick is at"),
      );
      expect(await (await fetch(`http://127.0.0.1:${webPort}/`)).text()).toContain(
        "payload web",
      );
      expect(stderr).not.toMatch(/mise run|pnpm|building/);
    } finally {
      if (opened.exitCode === null && opened.signalCode === null) opened.kill("SIGINT");
      outcome = await closed;
    }
    expect(outcome).toEqual({ code: 0, signal: null });

    const home = dirname(box.cwd);
    for (const file of filesBelow(home)) {
      expect(
        file.startsWith(box.configHome) || file.startsWith(box.dataHome) ||
          file === join(box.cwd, ".uberblick.json"),
        `${file} is outside the project binding and XDG roots`,
      ).toBe(true);
    }
    expect(treeDigest(payload)).toBe(initialPayload);
  });

  /**
   * `ub update` reaches Homebrew and nothing else.
   *
   * The tree is the shape #849 installs — the payload under Homebrew's prefix —
   * and `brew`, `git` and `mise` are all on PATH, all recording what they were
   * asked to do. The working directory is this repository's own checkout on
   * purpose: which copy `ub update` updates comes from where `ub`'s own files
   * live, so a Homebrew `ub` typed inside a checkout must still be Homebrew's.
   */
  it("updates a Homebrew installation through Homebrew, and touches nothing else", () => {
    const prefix = join(scratch, "homebrew");
    const keg = join(prefix, "Cellar", "uberblick", VERSION, "libexec");
    mkdirSync(dirname(keg), { recursive: true });
    cpSync(payload, keg, { recursive: true });
    const fakeBin = join(scratch, "homebrew-bin");
    mkdirSync(fakeBin, { recursive: true });
    const log = join(scratch, "homebrew-commands.log");
    writeFileSync(
      join(fakeBin, "brew"),
      `#!/bin/sh\necho "brew $*" >> "${log}"\n[ "$1" = "--prefix" ] && echo "${prefix}"\nexit 0\n`,
      { encoding: "utf8", mode: 0o755 },
    );
    for (const other of ["git", "mise", "pnpm"]) {
      writeFileSync(join(fakeBin, other), `#!/bin/sh\necho "${other} $*" >> "${log}"\nexit 0\n`, {
        encoding: "utf8",
        mode: 0o755,
      });
    }
    const box = sandbox();
    const before = treeDigest(keg);

    const run = spawnSync("ub", ["update"], {
      cwd: REPO_ROOT,
      env: {
        ...runtimeEnv(box, keg),
        UB_WORKSPACE_ID: WORKSPACE,
        UB_HUB_URL: "local",
        PATH: `${fakeBin}:${join(keg, "bin")}:${nodeBin}`,
      },
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual([
      // The recognition read: only a payload under the prefix Homebrew itself
      // reports is one `brew upgrade` can replace.
      "brew --prefix",
      "brew update",
      "brew upgrade uberblick-ai/tap/uberblick",
    ]);
    // No repository operation, no build, and nothing under the XDG layout: this
    // path resolves no configuration and writes no state of its own.
    expect(existsSync(box.configHome)).toBe(false);
    expect(existsSync(box.dataHome)).toBe(false);
    expect(treeDigest(keg)).toBe(before);
  });

  it("refuses to update a payload Homebrew did not install", () => {
    const box = sandbox();

    // No `brew` on this PATH, so the payload is nobody's installation.
    const run = runPayload(box, ["update"]);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("neither a Homebrew installation nor a checkout");
    expect(run.stderr).toContain("only updates Homebrew installations");
    expect(run.stderr).toContain("brew install uberblick-ai/tap/uberblick");
  });

  it("refuses an unpacked payload even when it sits inside a checkout", () => {
    const checkout = join(scratch, "checkout-containing-payload");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "package.json"), '{ "name": "uberblick" }\n', "utf8");
    writeFileSync(join(checkout, "mise.toml"), "[env]\n", "utf8");
    const nested = join(checkout, "dist", `uberblick-${VERSION}`);
    mkdirSync(dirname(nested), { recursive: true });
    cpSync(payload, nested, { recursive: true });
    const log = join(checkout, "commands.log");
    for (const command of ["git", "mise", "pnpm"]) {
      writeFileSync(join(nested, "bin", command), `#!/bin/sh\necho "${command} $*" >> "${log}"\n`, {
        encoding: "utf8",
        mode: 0o755,
      });
    }
    const box = sandbox();

    // There is deliberately no `brew` on PATH: this payload is nobody's
    // installation, and its containing checkout must not become the target.
    const run = runPayload(box, ["update"], { root: nested });

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("neither a Homebrew installation nor a checkout");
    expect(run.stderr).toContain("only updates Homebrew installations");
    expect(existsSync(log)).toBe(false);
  });

  it.each([
    ["missing", (root: string) => rmSync(join(root, "packages", "web", "dist", "index.html"))],
    [
      "incompatible",
      (root: string) =>
        writeFileSync(
          join(root, "packages", "web", "dist", "uberblick-build.json"),
          `${JSON.stringify({ syncProtocolVersion: SYNC_PROTOCOL_VERSION + 1 })}\n`,
          "utf8",
        ),
    ],
  ])("refuses %s packaged web assets without changing the payload", (_case, breakWeb) => {
    const broken = join(scratch, `broken-${_case}`);
    cpSync(payload, broken, { recursive: true });
    breakWeb(broken);
    const before = treeDigest(broken);
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });

    const opened = runPayload(box, ["open", "--no-browser"], { root: broken });
    expect(opened.status).toBe(1);
    expect(opened.stderr).toContain("Reinstall Uberblick");
    expect(opened.stderr).not.toMatch(/mise run|pnpm/);
    expect(treeDigest(broken)).toBe(before);
  });
});
