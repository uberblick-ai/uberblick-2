import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DEFAULT_HOST_LIMITS } from "../src/host-capacity.js";
import { hostGrantHash } from "../src/host-grants.js";
import { prepareFixture } from "./fixture.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scenario = process.argv[2];
const output = process.argv[3];
if (!scenario || !["all", "memory", "cap", "restart", "cold"].includes(scenario) || !output) {
  throw new Error("Usage: node --import tsx packages/mcp-server/capacity/run.ts all|memory|cap|restart|cold NEW_OUTPUT_DIRECTORY [runtime-cap]");
}
if (process.platform !== "linux") throw new Error("Linux /proc is required for worker-inclusive RSS, CPU and file descriptors");
const runtimeCap = process.argv[4] === undefined ? DEFAULT_HOST_LIMITS.maxRuntimes : Number(process.argv[4]);
if (!Number.isSafeInteger(runtimeCap) || runtimeCap < 1 || runtimeCap > 32) throw new Error("runtime-cap must be 1..32");
const root = resolve(output);
mkdirSync(root, { mode: 0o700 });
const clockTicks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
const children = new Set<ChildProcess>();
const completions = new Map<ChildProcess, Promise<void>>();
const clients = new Set<Client>();
const findings: string[] = [];
let phase = "setup";
const refusals: Record<string, number> = {};
const samples: Array<{ phase: string; elapsedMs: number; host: Resources | undefined; hub: Resources | undefined }> = [];
let host: ChildProcess | undefined;
let hub: ChildProcess | undefined;
const started = performance.now();
const deadline = AbortSignal.timeout(20 * 60_000);
const results: Record<string, unknown> = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "",
  scenario, runtimeCap, limits: { ...DEFAULT_HOST_LIMITS, maxRuntimes: runtimeCap },
  machine: { os: `Linux ${release()}`, node: process.version, cpu: cpus()[0]?.model,
    logicalCpus: cpus().length, memoryBytes: totalmem(), openFileLimits: readFileSync("/proc/self/limits", "utf8").split("\n").find(line => line.startsWith("Max open files")) },
};

interface Resources { rssBytes: number; highWaterRssBytes: number; cpuSeconds: number; openFiles: number }
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing fixture value");
  return value;
}
function resources(child: ChildProcess | undefined): Resources | undefined {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
    const stat = required(readFileSync(`/proc/${child.pid}/stat`, "utf8").split(") ")[1]).split(" ");
    return {
      rssBytes: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024,
      highWaterRssBytes: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1]) * 1024,
      cpuSeconds: (Number(stat[11]) + Number(stat[12])) / clockTicks,
      openFiles: readdirSync(`/proc/${child.pid}/fd`).length,
    };
  } catch { return; }
}

function disk(directory: string): { bytes: number; allocatedBytes: number; files: number } {
  let bytes = 0;
  let allocatedBytes = 0;
  let files = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = disk(path);
      bytes += nested.bytes; allocatedBytes += nested.allocatedBytes; files += nested.files;
    } else if (entry.isFile()) {
      const stat = statSync(path);
      bytes += stat.size; allocatedBytes += stat.blocks * 512; files += 1;
    }
  }
  return { bytes, allocatedBytes, files };
}

function sample() {
  samples.push({ phase, elapsedMs: performance.now() - started, ...{ host: resources(host), hub: resources(hub) } });
}
const sampling = setInterval(sample, 100);
sampling.unref();

function launch(name: string, entry: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const fd = openSync(join(root, `${name}.log`), "a", 0o600);
  // Do not inherit operator hub configuration or credentials into the fixture services.
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve(packageRoot, entry), ...args], {
    cwd: root, env: { PATH: process.env.PATH, ...env },
    stdio: ["ignore", "pipe", fd], timeout: 18 * 60_000, killSignal: "SIGKILL",
  });
  closeSync(fd);
  children.add(child);
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => { children.delete(child); resolve(); });
  });
  completions.set(child, closed);
  return child;
}

async function stop(child: ChildProcess | undefined) {
  if (!child) return;
  const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await completions.get(child);
    if (child.exitCode !== 0 && child.signalCode !== "SIGTERM") {
      findings.push(`Child ended with exit=${child.exitCode}, signal=${child.signalCode}`);
      process.exitCode = 1;
    }
  } finally { clearTimeout(kill); }
}

async function port() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing temporary listener");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function startHost(hubUrl: string) {
  host = launch("host", "capacity/host.ts", [root, hubUrl, String(runtimeCap)]);
  let text = "";
  const child = host;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Host readiness timed out")), 30_000);
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Host exited before ready")); });
    required(child.stdout).on("data", (data: Buffer) => {
      text += data.toString();
      for (const line of text.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (typeof event.port === "number") { clearTimeout(timer); resolve(`http://127.0.0.1:${event.port}`); return; }
        } catch { /* Other stdout lines are not readiness events. */ }
      }
    });
  });
}

async function closeClients() {
  await Promise.all([...clients].map(async client => { await client.close(); clients.delete(client); }));
}

type Fixture = Awaited<ReturnType<typeof prepareFixture>>;
type Grant = Fixture["grants"][number];
type Session = { client: Client; grant: Grant };
async function connect(origin: string, grant: Grant): Promise<Session> {
  const client = new Client({ name: "capacity-measurement", version: "1" });
  clients.add(client);
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp/${grant.grant.workspace}`), {
    requestInit: { headers: { Authorization: `Bearer ${grant.token}` } },
    fetch: async (input, init) => {
      const response = await fetch(input, { ...init, signal: AbortSignal.any([deadline, AbortSignal.timeout(120_000), ...(init?.signal ? [init.signal] : [])]) });
      if (response.status === 503) refusals[phase] = (refusals[phase] ?? 0) + 1;
      return response;
    },
  });
  await client.connect(transport as Transport, { timeout: 120_000 });
  return { client, grant };
}

async function call(session: Session, name: string, args: Record<string, unknown>) {
  const result = await session.client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.structuredContent ?? result.content)}`);
  return result.structuredContent as Record<string, unknown>;
}

async function ready(session: Session, fixture: Fixture) {
  const workspace = required(fixture.workspaces.find(w => w.uuid === session.grant.grant.workspace));
  const end = performance.now() + 120_000;
  for (;;) {
    const found = new Set<string>();
    let exact = true;
    for (const bucket of new Set(workspace.documents.map(d => d.bucket))) {
      let result: Record<string, unknown>;
      try { result = await call(session, "search", { query: bucket, limit: 100 }); }
      catch (error) {
        if (!(error instanceof StreamableHTTPError) || error.code !== 503) throw error;
        if (performance.now() >= end) throw error;
        // Busy-host replies advertise Retry-After: 1; readiness reads are safe to repeat.
        await pause(1000, undefined, { signal: deadline });
        exact = false;
        break;
      }
      const hits = result.hits as Array<{ uuid: string }>;
      const expected = workspace.documents.filter(d => d.bucket === bucket).map(d => d.uuid);
      if (hits.length !== expected.length || hits.some(hit => !expected.includes(hit.uuid))) exact = false;
      for (const hit of hits) found.add(hit.uuid);
    }
    if (exact && found.size === workspace.documents.length) return;
    if (performance.now() >= end) throw new Error(`Search incomplete for grant ${session.grant.grant.grantId}: ${found.size}/${workspace.documents.length}`);
    await pause(100, undefined, { signal: deadline });
  }
}

function historyState(grant: Grant) {
  const path = join(root, "mirrors", hostGrantHash(grant.grant.grantId), `${grant.grant.workspace}.sqlite`);
  let counts: { pages: number; snapshots: number } = { pages: 0, snapshots: 0 };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'history_v1_pages'").get()) {
      counts = {
        pages: Number(db.prepare("SELECT COUNT(*) AS n FROM history_v1_pages WHERE complete = 1 AND failed = 0").get()?.n),
        snapshots: Number(db.prepare("SELECT COUNT(*) AS n FROM history_v1_snapshots").get()?.n),
      };
    }
  } finally { db.close(); }
  return counts;
}

function checkpoint() {
  sample();
  const hostResources = required(resources(host));
  const hubResources = required(resources(hub));
  if (![hostResources.rssBytes, hubResources.rssBytes, hostResources.cpuSeconds, hubResources.cpuSeconds].every(Number.isFinite)) throw new Error("Invalid process resource sample");
  return { host: hostResources, hub: hubResources, mirror: disk(join(root, "mirrors")) };
}
function peaks(name: string) {
  const selected = samples.filter(s => s.phase === name);
  return Object.fromEntries((["host", "hub"] as const).map(key => [key, {
    rssBytes: Math.max(0, ...selected.map(s => s[key]?.rssBytes ?? 0)),
    highWaterRssBytes: Math.max(0, ...selected.map(s => s[key]?.highWaterRssBytes ?? 0)),
    openFiles: Math.max(0, ...selected.map(s => s[key]?.openFiles ?? 0)),
  }]));
}

async function run() {
  const fixture = await prepareFixture(root, 33);
  mkdirSync(join(root, "mirrors"), { mode: 0o700 });
  results.profile = fixture.profile;
  const hubPort = await port();
  hub = launch("hub", "../hub/src/main.ts", [], {
    HUB_HOST: "0.0.0.0", PORT: String(hubPort), HUB_DB_PATH: join(root, "hub.sqlite"),
  });
  const hubUrl = `ws://127.0.0.1:${hubPort}`;
  for (let attempt = 0; ; attempt++) {
    if (!children.has(hub)) throw new Error("Hub exited before ready; see hub.log");
    try { await fetch(`http://127.0.0.1:${hubPort}/health`, { signal: AbortSignal.timeout(1000) }); break; }
    catch { if (attempt >= 100) throw new Error("Hub readiness timed out"); await pause(100, undefined, { signal: deadline }); }
  }
  let origin = await startHost(hubUrl);
  const grants = fixture.grants.slice(0, runtimeCap);
  let sessions: Session[] = [];
  phase = "memory";
  const memory = [{ runtimes: 0, ...checkpoint() }];
  results.memory = { checkpoints: memory };
  for (const grant of grants) {
    const before = performance.now();
    const session = await connect(origin, grant);
    await ready(session, fixture);
    const openToSearchMs = performance.now() - before;
    await pause(1000, undefined, { signal: deadline });
    const history = historyState(grant);
    sessions.push(session);
    memory.push({ runtimes: sessions.length, ...checkpoint(), ...{ openToSearchMs, history } });
    console.log(`Ready ${sessions.length}/${runtimeCap}`);
  }
  results.memory = { checkpoints: memory, peaks: peaks(phase) };

  if (scenario === "all" || scenario === "cap") {
    phase = "cap";
    const primary = [...sessions];
    while (sessions.length < DEFAULT_HOST_LIMITS.maxSessions) {
      sessions.push(await connect(origin, required(grants[sessions.length % grants.length])));
    }
    const before = checkpoint();
    const begin = performance.now();
    const latencies: { search: number[]; set_metadata: number[] } = { search: [], set_metadata: [] };
    let acknowledgedWrites = 0;
    // Each wave submits the full call limit. Distinct documents avoid conflicting edits.
    for (let wave = 0; wave < 10; wave++) {
      await Promise.all(Array.from({ length: DEFAULT_HOST_LIMITS.maxCalls }, async (_, index) => {
        const session = required(sessions[(wave * DEFAULT_HOST_LIMITS.maxCalls + index) % sessions.length]);
        const workspace = required(fixture.workspaces.find(w => w.uuid === session.grant.grant.workspace));
        const document = required(workspace.documents[index]);
        const write = (index + wave) % 4 === 0;
        const name = write ? "set_metadata" : "search";
        const t = performance.now();
        const result = await call(session, name, write
          ? { uuid: document.uuid, description: `Capacity acknowledged write ${wave} ${index}` }
          : { query: document.bucket, limit: 100 });
        latencies[name].push(performance.now() - t);
        if (write) {
          if (result.applied !== true || result.synced !== true) throw new Error("Hosted write did not receive hub acknowledgement");
          acknowledgedWrites++;
        }
      }));
    }
    const elapsedMs = performance.now() - begin;
    const after = checkpoint();
    for (const session of primary) await ready(session, fixture);
    const latency = Object.fromEntries(Object.entries(latencies).map(([name, values]) => {
      values.sort((a, b) => a - b);
      return [name, { calls: values.length, p50Ms: values[Math.floor(values.length * 0.5)], p95Ms: values[Math.ceil(values.length * 0.95) - 1], maxMs: values.at(-1) }];
    }));
    results.cap = { sessions: sessions.length, concurrency: DEFAULT_HOST_LIMITS.maxCalls, acknowledgedWrites,
      elapsedMs, before, after, peaks: peaks(phase), latency,
      hostCpuPercent: 100_000 * ((after.host?.cpuSeconds ?? 0) - (before.host?.cpuSeconds ?? 0)) / elapsedMs,
      hubCpuPercent: 100_000 * ((after.hub?.cpuSeconds ?? 0) - (before.hub?.cpuSeconds ?? 0)) / elapsedMs };
  }

  if (scenario === "all" || scenario === "restart") {
    phase = "shutdown";
    await closeClients();
    await stop(host);
    host = undefined;
    phase = "restart";
    const begin = performance.now();
    origin = await startHost(hubUrl);
    const listeningMs = performance.now() - begin;
    const completionMs: number[] = [];
    sessions = await Promise.all(Array.from({ length: DEFAULT_HOST_LIMITS.maxSessions }, async (_, index) => {
      const session = await connect(origin, required(grants[index % grants.length]));
      await ready(session, fixture);
      completionMs.push(performance.now() - begin);
      return session;
    }));
    results.restart = { sessions: sessions.length, listeningMs, allSearchableMs: performance.now() - begin, completionMs,
      refusals503: refusals[phase] ?? 0, ...checkpoint(), peaks: peaks(phase) };
  }

  if (scenario === "all" || scenario === "cold") {
    phase = "shutdown";
    await closeClients();
    await stop(host);
    host = undefined;
    origin = await startHost(hubUrl);
    const times: Record<string, unknown>[] = [];
    // The extra grant was never admitted, while grant zero already has its complete mirror.
    for (const [label, grant] of [["empty", required(fixture.grants[runtimeCap])], ["kept", required(grants[0])]] as const) {
      phase = `cold-${label}`;
      const begin = performance.now();
      const session = await connect(origin, grant);
      await ready(session, fixture);
      times.push({ mirrorState: label, firstRequestToSearchMs: performance.now() - begin, ...checkpoint(), peaks: peaks(phase) });
      await closeClients();
      await stop(host);
      host = undefined;
      if (label === "empty") origin = await startHost(hubUrl);
    }
    results.cold = times;
  }
}

const shutdown = () => {
  for (const child of children) child.kill("SIGKILL");
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
deadline.addEventListener("abort", shutdown, { once: true });
try {
  await run();
} catch (error) {
  findings.push(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  phase = "shutdown";
  try { await closeClients(); } catch (error) { findings.push(String(error)); process.exitCode = 1; }
  await stop(host);
  await stop(hub);
  clearInterval(sampling);
  results.findings = findings;
  results.refusals503 = refusals;
  results.elapsedMs = performance.now() - started;
  writeFileSync(join(root, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(root, "samples.json"), `${JSON.stringify(samples)}\n`);
  console.log(JSON.stringify({ results: join(root, "results.json"), findings }));
}
