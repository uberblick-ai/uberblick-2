/** Exercise the checkout preload and the release entry as real hub processes. */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createClient, testRoom, token, WORKSPACE } from "./helpers.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STORED_SECRET = "dev-preload-file-secret";
const OVERRIDE_SECRET = "dev-preload-environment-secret";
const roots: string[] = [];
const running: HubProcess[] = [];

interface Fixture {
  root: string;
  cwd: string;
  credentials: string;
  env: NodeJS.ProcessEnv;
}

function fixture(options: { exposed?: boolean; device?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), `uberblick-hub-dev-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  roots.push(root);
  const cwd = join(root, "project", "nested");
  const config = join(root, "config", "uberblick");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(config, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "project", ".uberblick.json"), JSON.stringify({
    workspaceId: WORKSPACE, hubUrl: options.device ? "ws://localhost:1234" : null,
  }));
  const credentials = join(config, "credentials.json");
  writeFileSync(credentials, JSON.stringify({ signingSecret: STORED_SECRET }), {
    mode: options.exposed ? 0o644 : 0o600,
  });
  if (options.device) {
    writeFileSync(join(config, "config.json"), JSON.stringify({
      hubAdmissions: { "ws://localhost:1234": "device" },
    }));
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["UB_WORKSPACE_ID", "UB_HUB_URL", "WORKSPACE_ID", "HUB_URL", "HUB_AUTH_TOKEN", "HUB_ADMISSION"]) {
    delete env[name];
  }
  Object.assign(env, {
    HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    HUB_DB_PATH: ":memory:", HUB_HOST: "127.0.0.1", PORT: "0", HUB_GITHUB_CLIENT_ID: "",
  });
  return { root, cwd, credentials, env };
}

interface HubProcess {
  stdout(): string;
  stderr(): string;
  listening: Promise<number>;
  closed: Promise<number | null>;
  stop(): Promise<number | null>;
}

function start(args: string[], box: Fixture): HubProcess {
  const child = spawn(process.execPath, args, {
    cwd: box.cwd, env: box.env, timeout: 15_000, killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  const closed = new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", (code) => done(code));
  });
  let resolvePort!: (port: number) => void;
  const listening = new Promise<number>((done) => { resolvePort = done; });
  let buffered = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      const record = JSON.parse(line) as { event?: string; port?: number };
      if (record.event === "hub.listen" && typeof record.port === "number") resolvePort(record.port);
    }
  });
  const hub: HubProcess = {
    stdout: () => stdout, stderr: () => stderr, closed,
    listening: Promise.race([
      listening,
      closed.then((code) => { throw new Error(`hub exited before listening (${code}): ${stderr}`); }),
    ]),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      return closed;
    },
  };
  // Refusal cases await closed; mark the alternative listening promise handled.
  void hub.listening.catch(() => {});
  running.push(hub);
  return hub;
}

function checkoutArgs(): string[] {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { scripts: { start: string } };
  // Exercise the package's real start invocation from a private project cwd.
  return manifest.scripts.start.split(" ").slice(1).map((arg) =>
    arg === "tsx" ? import.meta.resolve("tsx")
      : arg.endsWith(".ts") ? resolve(PACKAGE_ROOT, arg) : arg,
  );
}

async function authenticate(hub: HubProcess, secret: string): Promise<void> {
  const port = await hub.listening;
  const client = createClient({ port, room: testRoom(), token: await token("read-write", { secret }) });
  try {
    await client.synced;
  } finally {
    client.destroy();
  }
  expect(hub.stdout() + hub.stderr()).not.toContain(secret);
}

afterEach(async () => {
  for (const hub of running.splice(0)) await hub.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("starts the checkout hub from its nearest project and private credentials alone", async () => {
  const hub = start(checkoutArgs(), fixture());
  await authenticate(hub, STORED_SECRET);
  expect(await hub.stop()).toBe(0);
});

it("lets the explicit signing-secret override win without logging either secret", async () => {
  const box = fixture();
  box.env.HUB_AUTH_TOKEN = OVERRIDE_SECRET;
  const hub = start(checkoutArgs(), box);
  await authenticate(hub, OVERRIDE_SECRET);
  expect(hub.stderr()).toContain("HUB_AUTH_TOKEN in the environment is in force");
  expect(hub.stdout() + hub.stderr()).not.toContain(STORED_SECRET);
});

it("lets the complete environment binding override a device-bound project", async () => {
  const box = fixture({ device: true });
  box.env.UB_WORKSPACE_ID = WORKSPACE;
  box.env.UB_HUB_URL = "local";
  const hub = start(checkoutArgs(), box);
  await authenticate(hub, STORED_SECRET);
  expect(await hub.stop()).toBe(0);
});

it.each(["exposed", "device"] as const)("refuses the %s signing-secret path before listening", async (kind) => {
  const box = fixture({ exposed: kind === "exposed", device: kind === "device" });
  if (kind === "device") box.env.HUB_AUTH_TOKEN = OVERRIDE_SECRET;
  const hub = start(checkoutArgs(), box);
  const before = readFileSync(box.credentials);
  expect(await hub.closed).toBe(1);
  expect(hub.stderr()).not.toContain('"event":"hub.listen"');
  expect(hub.stderr()).toContain(kind === "exposed" ? "secret may have leaked" : "HUB_AUTH_TOKEN");
  if (kind === "exposed") {
    expect(hub.stderr()).toContain("restart running agents");
    expect(hub.stderr()).toContain("ub auth login");
    expect(hub.stderr()).not.toContain("chmod 600");
    expect(statSync(box.credentials).mode & 0o777).toBe(0o644);
  }
  expect(readFileSync(box.credentials)).toEqual(before);
  expect(hub.stdout() + hub.stderr()).not.toContain(STORED_SECRET);
  expect(hub.stdout() + hub.stderr()).not.toContain(OVERRIDE_SECRET);
});

it("refuses a fresh local binding without generating a secret or listening", async () => {
  const box = fixture();
  rmSync(box.credentials);
  const hub = start(checkoutArgs(), box);
  expect(await hub.closed).toBe(1);
  expect(hub.stderr()).not.toContain('"event":"hub.listen"');
  expect(hub.stderr()).toContain("ub workspace create <name>");
  expect(hub.stderr()).toContain("ub open");
  expect(hub.stderr()).toContain("export HUB_AUTH_TOKEN");
  expect(existsSync(box.credentials)).toBe(false);
});

it.each([
  { UB_WORKSPACE_ID: WORKSPACE },
  { UB_HUB_URL: "local" },
  { WORKSPACE_ID: WORKSPACE },
  { HUB_URL: "ws://localhost:1234" },
])("refuses unsupported checkout binding variables before listening (%j)", async (extra) => {
  const box = fixture();
  Object.assign(box.env, extra);
  const hub = start(checkoutArgs(), box);
  expect(await hub.closed).toBe(1);
  expect(hub.stderr()).not.toContain('"event":"hub.listen"');
  expect(hub.stderr()).toContain("UB_HUB_URL");
  expect(hub.stdout() + hub.stderr()).not.toContain(STORED_SECRET);
});

it("bundles the same main entry without the checkout credential preload", async () => {
  const box = fixture();
  const bundle = join(box.root, "hub.mjs");
  const { build } = createRequire(join(PACKAGE_ROOT, "..", "cli", "package.json"))("esbuild") as {
    build(options: Record<string, unknown>): Promise<unknown>;
  };
  await build({
    entryPoints: [join(PACKAGE_ROOT, "src", "main.ts")], outfile: bundle,
    bundle: true, platform: "node", format: "esm", target: "node26", minify: true, sourcemap: false,
  });
  const missing = start([bundle], box);
  expect(await missing.closed).toBe(1);
  expect(missing.stderr()).toContain("HUB_AUTH_TOKEN");
  expect(missing.stderr()).not.toContain(box.credentials);
  expect(missing.stdout() + missing.stderr()).not.toContain(STORED_SECRET);

  writeFileSync(box.credentials, "{ invalid credential JSON");
  chmodSync(box.credentials, 0o644);
  writeFileSync(join(box.root, "project", ".uberblick.json"), "{ invalid project JSON");
  box.env.HUB_AUTH_TOKEN = OVERRIDE_SECRET;
  const released = start([bundle], box);
  await authenticate(released, OVERRIDE_SECRET);
  expect(released.stderr()).not.toMatch(/invalid JSON|credentials\.json|\.uberblick\.json|0600/);
  expect(await released.stop()).toBe(0);
});
