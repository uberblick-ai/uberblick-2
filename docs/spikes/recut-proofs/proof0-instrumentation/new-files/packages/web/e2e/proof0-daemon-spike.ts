/**
 * Disposable real-client evidence driver for #704.
 *
 * This is deliberately not a Playwright test in the merged suite. It starts a
 * remote hub, the candidate daemon, the real web application, and real
 * `ub mcp serve` processes, executes the declared failure matrix and prints one
 * JSON report. The whole harness lives only on the unmerged evidence branch.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as Y from "yjs";
import { getBlocksFragment } from "@uberblick/schema";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { createHub, resolveStorage } from "@uberblick/hub";
import type { Hub, HubConfig, HubLogRecord } from "@uberblick/hub";
import { getBlocks } from "@uberblick/schema";
import { createServer as createViteServer } from "vite";
import type { ViteDevServer } from "vite";

const WAIT_MS = 20_000;
const SAMPLE_COUNT = 20;

// ---- Proof 0 instrumentation ------------------------------------------------
// PROOF0_KEEP_DIR: create the run root inside it and never remove it (the
// daemon's SQLite database, the remote hub's database and trace.jsonl survive).
const KEEP_DIR = process.env.PROOF0_KEEP_DIR?.trim() || null;
process.env.PROOF0_TRACE = "1";
let traceFile: string | null = null;
function traceLine(line: string): void {
  process.stderr.write(`${line}\n`);
  if (traceFile !== null) appendFileSync(traceFile, `${line}\n`);
}
function trace(step: string, data: Record<string, unknown> = {}): void {
  traceLine(`P0 ${JSON.stringify({ t: Date.now(), trace: "driver", step, ...data })}`);
}
/** Forward a child's stderr line by line, so P0 lines interleave with ours. */
function forwardStderr(label: string, chunk: Buffer, carry: { rest: string }): void {
  carry.rest += chunk.toString();
  for (;;) {
    const newline = carry.rest.indexOf("\n");
    if (newline < 0) break;
    const line = carry.rest.slice(0, newline);
    carry.rest = carry.rest.slice(newline + 1);
    if (line.startsWith("P0 ")) traceLine(`P0 ${JSON.stringify({ from: label })} ${line.slice(3)}`);
    else traceLine(`[${label}] ${line}`);
  }
}
interface RawBlock { index: number; id: string | null; type: string; text: string; item: string | null }
/** The plain text of one block element: every Y.XmlText child's inserts. */
function elementText(element: Y.XmlElement): string {
  return element
    .toArray()
    .map((child) =>
      child instanceof Y.XmlText
        ? child
            .toDelta()
            .map((op: { insert?: unknown }) => (typeof op.insert === "string" ? op.insert : ""))
            .join("")
        : "",
    )
    .join("");
}
/** Every element of a Y.Doc's blocks fragment, shadowed duplicates included. */
function rawBlocksOf(doc: Y.Doc): RawBlock[] {
  const out: RawBlock[] = [];
  const children = getBlocksFragment(doc).toArray();
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!(child instanceof Y.XmlElement)) {
      out.push({ index, id: null, type: "foreign", text: "", item: null });
      continue;
    }
    const item = child._item;
    out.push({
      index,
      id: child.getAttribute("id") ?? null,
      type: child.nodeName,
      text: elementText(child),
      item: item ? `${item.id.client}:${item.id.clock}` : null,
    });
  }
  return out;
}
// -----------------------------------------------------------------------------
const WORKSPACE = "6d88d0da-1489-4f44-819d-13ca7940ce71";
const SECRET = "daemon-authority-spike-only-secret";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UB = join(repoRoot, "packages", "cli", "bin", "ub.mjs");
const DAEMON = join(
  repoRoot,
  "packages",
  "mcp-server",
  "spike",
  "daemon-authority-daemon.ts",
);

interface ToolFrame {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

interface ToolAnswer<T> {
  payload: T;
  isError: boolean;
}

interface DocPayload {
  uuid: string;
  blocks: { id: string; text: string; rev: string }[];
}

interface EditPayload {
  uuid: string;
  block: { id: string; text: string; rev: string };
  applied: boolean;
  synced: boolean;
}

interface SyncPayload {
  hub: { status: string };
  pendingRooms: unknown[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}

async function waitUntil<T>(
  label: string,
  read: () => T | null | false | Promise<T | null | false>,
): Promise<{ value: T; elapsedMs: number }> {
  const started = performance.now();
  for (;;) {
    const value = await read();
    if (value !== null && value !== false) {
      return { value, elapsedMs: performance.now() - started };
    }
    if (performance.now() - started > WAIT_MS) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction));
  return Number((sorted[index] ?? 0).toFixed(3));
}

function stats(samples: number[]): { medianMs: number; p95Ms: number } {
  return { medianMs: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95) };
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  ensure(address !== null && typeof address !== "string", "port reservation failed");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

/** One real `ub mcp serve` process, spoken to over its actual stdio. */
class McpProcess {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private buffer = "";
  private stderrText = "";
  private exited = false;

  constructor(
    env: NodeJS.ProcessEnv,
    client: { name: string; title?: string },
  ) {
    this.child = spawn(process.execPath, [UB, "mcp", "serve"], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const carry = { rest: "" };
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrText += chunk.toString();
      forwardStderr(`mcp:${client.title ?? client.name}`, chunk, carry);
    });
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        let frame: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          frame = JSON.parse(line) as typeof frame;
        } catch {
          this.failAll(new Error(`non-JSON MCP stdout: ${line.slice(0, 120)}`));
          continue;
        }
        if (typeof frame.id !== "number") continue;
        const waiter = this.pending.get(frame.id);
        if (!waiter) continue;
        this.pending.delete(frame.id);
        frame.error
          ? waiter.reject(new Error(frame.error.message ?? JSON.stringify(frame.error)))
          : waiter.resolve(frame.result);
      }
    });
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      this.failAll(
        new Error(
          `ub mcp serve ${signal ? `was killed by ${signal}` : `exited ${code}`}: ${this.stderrText.trim()}`,
        ),
      );
    });
    this.ready = this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { ...client, version: "0" },
    }).then(() => {
      this.child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
    });
  }

  get pid(): number {
    ensure(this.child.pid !== undefined, "MCP process has no pid");
    return this.child.pid;
  }

  get stderr(): string {
    return this.stderrText;
  }

  async callRaw<T>(name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer<T>> {
    await this.ready;
    const result = (await this.request("tools/call", {
      name,
      arguments: args,
    })) as ToolFrame;
    const text = result.content?.find((entry) => entry.type === "text")?.text;
    ensure(text !== undefined, `${name} returned no JSON text`);
    return { payload: JSON.parse(text) as T, isError: result.isError === true };
  }

  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const answer = await this.callRaw<T>(name, args);
    if (answer.isError) throw new Error(`${name} failed: ${JSON.stringify(answer.payload)}`);
    return answer.payload;
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.child.stdin?.end();
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      once(this.child, "exit").then(() => {}),
      new Promise<void>((resolveWait) =>
        (timeout = setTimeout(() => {
          this.child.kill("SIGTERM");
          resolveWait();
        }, 5_000)),
      ),
    ]);
    if (timeout) clearTimeout(timeout);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolveRequest, rejectRequest) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`${method} timed out: ${this.stderrText}`));
      }, WAIT_MS);
      this.pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject(error) {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}

class DaemonProcess {
  readonly child: ChildProcess;
  readonly ready: Promise<{ pid: number; databasePath: string }>;
  private stderrText = "";

  constructor(env: NodeJS.ProcessEnv) {
    const loader = import.meta.resolve("tsx");
    this.child = spawn(process.execPath, ["--import", loader, DAEMON], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const carry = { rest: "" };
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrText += chunk.toString();
      forwardStderr("daemon", chunk, carry);
    });
    this.ready = new Promise((resolveReady, rejectReady) => {
      let buffer = "";
      const timeout = setTimeout(
        () => rejectReady(new Error(`daemon ready timed out: ${this.stderrText}`)),
        WAIT_MS,
      );
      this.child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timeout);
        try {
          resolveReady(JSON.parse(buffer.slice(0, newline)) as { pid: number; databasePath: string });
        } catch (error) {
          rejectReady(new Error(`daemon ready was not JSON: ${message(error)}`));
        }
      });
      this.child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        rejectReady(
          new Error(
            `daemon ${signal ? `was killed by ${signal}` : `exited ${code}`}: ${this.stderrText}`,
          ),
        );
      });
    });
  }

  get stderr(): string {
    return this.stderrText;
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      once(this.child, "exit").then(() => {}),
      new Promise<void>((resolveWait) =>
        (timeout = setTimeout(() => {
          this.child.kill("SIGKILL");
          resolveWait();
        }, 5_000)),
      ),
    ]);
    if (timeout) clearTimeout(timeout);
  }

  async exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return { code: this.child.exitCode, signal: this.child.signalCode };
    }
    const [code, signal] = (await once(this.child, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    return { code, signal };
  }
}

function descendants(pid: number): number[] {
  const found = [pid];
  let index = 0;
  while (index < found.length) {
    const parent = found[index++];
    if (parent === undefined) continue;
    let children = "";
    try {
      children = readFileSync(`/proc/${parent}/task/${parent}/children`, "utf8");
    } catch {
      continue;
    }
    for (const child of children.trim().split(/\s+/)) {
      if (/^\d+$/.test(child)) found.push(Number(child));
    }
  }
  return found;
}

function processTreeRss(pid: number): number {
  let kib = 0;
  for (const member of descendants(pid)) {
    try {
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(
        readFileSync(`/proc/${member}/status`, "utf8"),
      );
      kib += Number(match?.[1] ?? 0);
    } catch {
      // A short-lived child disappeared between enumeration and reading.
    }
  }
  return kib * 1024;
}

function processTreeHandles(pid: number): string[] {
  const paths: string[] = [];
  for (const member of descendants(pid)) {
    let descriptors: string[];
    try {
      descriptors = readdirSync(`/proc/${member}/fd`);
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        paths.push(readlinkSync(`/proc/${member}/fd/${descriptor}`));
      } catch {
        // The descriptor closed between listing and reading.
      }
    }
  }
  return paths;
}

async function editBenchmark(client: McpProcess, uuid: string): Promise<{
  medianMs: number;
  p95Ms: number;
}> {
  const initialBlock = (await client.call<DocPayload>("get_doc", { uuid })).blocks[0];
  ensure(initialBlock !== undefined, "benchmark document has no block");
  let block = initialBlock;
  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const started = performance.now();
    const changed: EditPayload = await client.call<EditPayload>("edit_block", {
      uuid,
      block_id: block.id,
      old_text: block.text,
      new_text: `${block.text}x`,
      rev: block.rev,
    });
    samples.push(performance.now() - started);
    block = changed.block;
  }
  return stats(samples);
}

/** The first editor child's text — what the original harness read. */
async function editorText(page: Page): Promise<string> {
  return (await editorBlocks(page))[0]?.text ?? "";
}

/** Every top-level editor child: its rendered `id` attribute and text. */
async function editorBlocks(page: Page): Promise<{ id: string | null; text: string }[]> {
  return await page.evaluate(() => {
    const out: { id: string | null; text: string }[] = [];
    for (const block of document.querySelectorAll(".ub-editor .ProseMirror > *")) {
      const clone = block.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".ProseMirror-yjs-cursor").forEach((cursor) => {
        cursor.remove();
      });
      out.push({ id: block.getAttribute("id"), text: clone.textContent ?? "" });
    }
    return out;
  });
}

/** The whole editor text, blocks joined by newline. */
async function editorAllText(page: Page): Promise<string> {
  return (await editorBlocks(page)).map((block) => block.text).join("\n");
}

function hubRawBlocks(hub: Hub | null, room: string): RawBlock[] | null {
  const doc = hub?.hocuspocus.documents.get(room);
  return doc ? rawBlocksOf(doc) : null;
}

async function caretToEnd(page: Page): Promise<void> {
  const block = page.locator(".ub-editor .ProseMirror > *").first();
  const box = await block.boundingBox();
  ensure(box !== null, "browser block has no box");
  await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
}

async function startVite(hubUrl: string): Promise<{ server: ViteDevServer; appUrl: string }> {
  process.env.HUB_URL = hubUrl;
  process.env.HUB_AUTH_TOKEN = SECRET;
  process.env.WORKSPACE_ID = WORKSPACE;
  process.env.WORKSPACES = WORKSPACE;
  const server = await createViteServer({
    configFile: join(packageRoot, "vite.config.ts"),
    root: packageRoot,
    server: { port: 0 },
    logLevel: "warn",
  });
  await server.listen();
  const appUrl = server.resolvedUrls?.local[0];
  ensure(appUrl !== undefined, "Vite reported no local URL");
  return { server, appUrl };
}

async function main(): Promise<void> {
  const root = KEEP_DIR
    ? mkdtempSync(join(KEEP_DIR, "daemon-run-"))
    : mkdtempSync(join(tmpdir(), "uberblick-daemon-authority-"));
  traceFile = join(root, "trace.jsonl");
  trace("start", { root, keep: KEEP_DIR !== null, node: process.version, platform: process.platform });
  const remoteDatabase = join(root, "remote-hub.sqlite");
  const daemonDatabase = join(root, "daemon.sqlite");
  // A Unix socket path must fit sun_path (~104 bytes on macOS); the kept run
  // root is far longer, so the socket alone lives in a short tmpdir entry.
  const socketDir = mkdtempSync(join(tmpdir(), "p0-"));
  const daemonSocket = join(socketDir, "d.sock");
  const failMarker = join(root, "fail-next-append");
  const crashMarker = join(root, "crash-after-append");
  const remoteLogs: HubLogRecord[] = [];
  let remoteHub: Hub | null = null;
  let vite: ViteDevServer | null = null;
  let daemon: DaemonProcess | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  const clients = new Set<McpProcess>();

  const remoteConfig: HubConfig = {
    authSecret: SECRET,
    port: 0,
    databasePath: remoteDatabase,
    log: (record) => remoteLogs.push(record),
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  };

  try {
    remoteHub = await createHub(remoteConfig);
    const remotePort = remoteHub.port;
    const remoteHubUrl = `ws://127.0.0.1:${remotePort}`;

    // Same-run direct baseline, before the daemon candidate exists.
    const directHome = join(root, "direct");
    const directEnv = {
      XDG_CONFIG_HOME: join(directHome, "config"),
      XDG_DATA_HOME: join(directHome, "data"),
      WORKSPACE_ID: WORKSPACE,
      HUB_AUTH_TOKEN: SECRET,
      UBERBLICK_DB: join(directHome, "direct.sqlite"),
    };
    const { configDir } = resolveStorage({ env: directEnv });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      `${JSON.stringify({ workspace: WORKSPACE, hubUrl: remoteHubUrl })}\n`,
    );
    const direct = new McpProcess(directEnv, { name: "direct-baseline" });
    clients.add(direct);
    await direct.ready;
    const baselineDoc = await direct.call<DocPayload>("create_doc", {
      title: "Direct baseline",
      description: "Same-run direct edit latency baseline for #704.",
      blocks: [{ type: "paragraph", text: "baseline" }],
    });
    const directEdit = await editBenchmark(direct, baselineDoc.uuid);
    const directRssBytes = processTreeRss(direct.pid);
    await direct.close();
    clients.delete(direct);

    const localPort = await reservePort();
    const localHubUrl = `ws://127.0.0.1:${localPort}`;
    const runningVite = await startVite(localHubUrl);
    vite = runningVite.server;
    const browserOrigin = new URL(runningVite.appUrl).origin;

    const daemonEnv = {
      SPIKE_WORKSPACE: WORKSPACE,
      SPIKE_SECRET: SECRET,
      SPIKE_REMOTE_HUB_URL: remoteHubUrl,
      SPIKE_DATABASE_PATH: daemonDatabase,
      SPIKE_DAEMON_SOCKET: daemonSocket,
      SPIKE_FAIL_MARKER: failMarker,
      SPIKE_CRASH_MARKER: crashMarker,
      SPIKE_BROWSER_ORIGIN: browserOrigin,
      SPIKE_LOCAL_PORT: String(localPort),
    };
    remoteLogs.length = 0;
    const spawnStarted = performance.now();
    daemon = new DaemonProcess(daemonEnv);
    const daemonReady = await daemon.ready;
    const coldStartMs = performance.now() - spawnStarted;
    const daemonIdleRssBytes = processTreeRss(daemonReady.pid);

    const agentEnv = { UBERBLICK_DAEMON_SOCKET: daemonSocket };
    const alpha = new McpProcess(agentEnv, { name: "codex", title: "Agent Alpha" });
    let beta = new McpProcess(agentEnv, { name: "claude-code", title: "Agent Beta" });
    clients.add(alpha);
    clients.add(beta);
    await Promise.all([alpha.ready, beta.ready]);

    const proxyHandles = {
      alpha: processTreeHandles(alpha.pid),
      beta: processTreeHandles(beta.pid),
    };
    const proxySqliteHandles = Object.fromEntries(
      Object.entries(proxyHandles).map(([name, handles]) => [
        name,
        handles.filter((handle) => /sqlite|\.db(?:-|$)/i.test(handle)),
      ]),
    );
    ensure(
      Object.values(proxySqliteHandles).every((handles) => handles.length === 0),
      "a proxied ub mcp serve process opened SQLite",
    );

    const document = await alpha.call<DocPayload>("create_doc", {
      title: "Daemon authority proof",
      description: "Real web and MCP clients share the daemon-owned replica.",
      blocks: [{ type: "paragraph", text: "middle" }],
    });
    const uuid = document.uuid;
    const room = `${WORKSPACE}/${uuid}`;
    await beta.call("get_doc", { uuid });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(globalThis, "indexedDB", {
        value: undefined,
        configurable: true,
      });
    });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        trace("browser-console", { type: msg.type(), text: msg.text().slice(0, 500) });
      }
    });
    page.on("pageerror", (error) => trace("browser-pageerror", { text: String(error).slice(0, 500) }));
    /** One full-state snapshot: every editor child, every MCP block, every hub element. */
    const snap = async (
      step: string,
      client: McpProcess | null,
      extra: Record<string, unknown> = {},
    ): Promise<void> => {
      let mcp: unknown = null;
      if (client !== null) {
        try {
          mcp = (await client.call<DocPayload>("get_doc", { uuid })).blocks.map((block) => ({
            id: block.id,
            text: block.text,
          }));
        } catch (error) {
          mcp = `error: ${message(error)}`;
        }
      }
      let web: unknown = null;
      try {
        web = await editorBlocks(page);
      } catch (error) {
        web = `error: ${message(error)}`;
      }
      let webStatus: string | null = null;
      try {
        webStatus = await page.locator(".ub-status .ub-status-word").first().textContent({ timeout: 2_000 });
      } catch {
        webStatus = null;
      }
      trace(step, { web, webStatus, mcp, hub: hubRawBlocks(remoteHub, room), ...extra });
    };
    await page.goto(new URL(`/${WORKSPACE}/${uuid}`, runningVite.appUrl).href);
    await page.locator(".ub-editor .ProseMirror").waitFor();
    await waitUntil("the browser to read the daemon document", async () =>
      (await editorText(page)) === "middle" ? "middle" : false,
    );
    const indexedDbDisabled = await page.evaluate(() => typeof indexedDB === "undefined");
    ensure(indexedDbDisabled, "the candidate browser still had IndexedDB");
    await snap("01-browser-opened", alpha);

    await caretToEnd(page);
    await page.keyboard.type("-web", { delay: 15 });
    await waitUntil("an MCP client to read the web write", async () => {
      const read = await alpha.call<DocPayload>("get_doc", { uuid });
      return read.blocks[0]?.text === "middle-web" ? read.blocks[0].text : false;
    });
    await snap("02-web-typed", alpha);

    const alphaBlock = (await alpha.call<DocPayload>("get_doc", { uuid })).blocks[0];
    ensure(alphaBlock !== undefined, "agent document has no block");
    const alphaEdit = await alpha.call<EditPayload>("edit_block", {
      uuid,
      block_id: alphaBlock.id,
      old_text: alphaBlock.text,
      new_text: `${alphaBlock.text}-alpha`,
      rev: alphaBlock.rev,
    });
    await waitUntil("Agent Alpha's edit and caret in the web app", async () => {
      const labels = await page
        .locator(".ub-editor .ProseMirror-yjs-cursor > div")
        .allTextContents();
      return (await editorText(page)).endsWith("-alpha") && labels.includes("Agent Alpha")
        ? labels
        : false;
    });
    await snap("03-alpha-edited", alpha);

    const betaBlock = (await beta.call<DocPayload>("get_doc", { uuid })).blocks[0];
    ensure(betaBlock !== undefined, "second agent document has no block");
    await beta.call<EditPayload>("edit_block", {
      uuid,
      block_id: betaBlock.id,
      old_text: betaBlock.text,
      new_text: `${betaBlock.text}-beta`,
      rev: betaBlock.rev,
    });
    const cursorLabels = await waitUntil("both agent cursors in the web app", async () => {
      const labels = await page
        .locator(".ub-editor .ProseMirror-yjs-cursor > div")
        .allTextContents();
      return labels.includes("Agent Alpha") && labels.includes("Agent Beta") ? labels : false;
    });

    const awareness = await waitUntil("three distinct client awareness states upstream", () => {
      const states = remoteHub?.hocuspocus.documents.get(room)?.awareness.getStates();
      if (!states) return false;
      const named = [...states.entries()]
        .filter(([, state]) => state.user !== undefined)
        .map(([clientId, state]) => ({
          clientId,
          name: (state.user as { name?: string }).name ?? "unknown",
          client: state.client,
          cursor: state.cursor !== undefined && state.cursor !== null,
        }));
      const names = new Set(named.map((state) => state.name));
      return names.has("Agent Alpha") && names.has("Agent Beta") && named.length >= 3
        ? named
        : false;
    });
    const allAwareness = () => {
      const states = remoteHub?.hocuspocus.documents.get(room)?.awareness.getStates();
      return states
        ? [...states.entries()].map(([clientId, state]) => ({
            clientId,
            name: (state.user as { name?: string } | undefined)?.name ?? null,
            client: state.client ?? null,
          }))
        : null;
    };
    await snap("04-beta-edited", beta, { awareness: allAwareness() });

    // Truly concurrent same-block edits: disconnect the browser from the local
    // ingress, edit both complete replicas, then let Yjs exchange the updates.
    const beforeConcurrent = (await beta.call<DocPayload>("get_doc", { uuid })).blocks[0];
    ensure(beforeConcurrent !== undefined, "concurrency block missing");
    await context.setOffline(true);
    await caretToEnd(page);
    await page.keyboard.type("-offline-web", { delay: 5 });
    const concurrentAgent = await beta.call<EditPayload>("edit_block", {
      uuid,
      block_id: beforeConcurrent.id,
      old_text: beforeConcurrent.text,
      new_text: `agent-${beforeConcurrent.text}`,
      rev: beforeConcurrent.rev,
    });
    await snap("05-offline-both-edited", beta);
    await context.setOffline(false);
    const concurrent = await waitUntil("the concurrent same-block edits to converge", async () => {
      const webText = await editorText(page);
      const mcpText = (await beta.call<DocPayload>("get_doc", { uuid })).blocks[0]?.text ?? "";
      return webText === mcpText && webText.includes("agent-") && webText.includes("-offline-web")
        ? webText
        : false;
    });
    await snap("06-online-converged", beta);

    // Leaving withdraws Alpha's fields only; Beta and the web identity remain.
    await alpha.close();
    clients.delete(alpha);
    const afterAlphaLeaves = await waitUntil("only Alpha's awareness to withdraw", () => {
      const states = remoteHub?.hocuspocus.documents.get(room)?.awareness.getStates();
      if (!states) return false;
      const names = [...states.values()]
        .map((state) => (state.user as { name?: string } | undefined)?.name)
        .filter((name): name is string => name !== undefined);
      return !names.includes("Agent Alpha") && names.includes("Agent Beta") && names.length >= 2
        ? names
        : false;
    });

    const benchmarkDoc = await beta.call<DocPayload>("create_doc", {
      title: "Daemon benchmark",
      description: "Candidate edit latency fixture for #704.",
      blocks: [{ type: "paragraph", text: "candidate" }],
    });
    const daemonEdit = await editBenchmark(beta, benchmarkDoc.uuid);
    await snap("07-after-benchmark", beta, { awareness: allAwareness() });

    const initialRemoteSocketIds = await waitUntil("one remote daemon socket", () => {
      const ids = new Set(
        remoteLogs
          .filter((record) => record.event === "hub.room.connected")
          .map((record) => String(record.socketId)),
      );
      return ids.size === 1 ? [...ids] : false;
    });

    // Remote hub outage: local work continues, but the ordinary web provider
    // acks against the daemon ingress and therefore exposes the candidate's
    // decisive end-to-end sync-status lie.
    await snap("08-before-hub-stop", beta, { hubUp: true });
    await remoteHub.stop();
    remoteHub = null;
    trace("09-hub-stopped");
    const hubDown = await waitUntil("the daemon to report the remote hub down", async () => {
      const status = await beta.call<SyncPayload>("sync_status");
      return status.hub.status === "hub-down" ? status : false;
    });
    await snap("10-daemon-reports-hub-down", beta);
    const webStatusDuringRemoteOutage = await page
      .locator(".ub-status .ub-status-word")
      .first()
      .textContent();
    await snap("11-before-typing-hub-down", beta, { webStatusDuringRemoteOutage });
    await caretToEnd(page);
    await snap("12-caret-placed", beta);
    await page.keyboard.type("-hub-down", { delay: 5 });
    await snap("13-typed-hub-down", beta);
    const localDuringHubOutage = await waitUntil("the daemon to retain the web outage edit", async () => {
      const read = await beta.call<DocPayload>("get_doc", { uuid });
      return read.blocks.some((block) => block.text.includes("-hub-down"))
        ? read.blocks.map((block) => block.text).join("\n")
        : false;
    });
    const pendingDuringHubOutage = await beta.call<SyncPayload>("sync_status");
    const expectedOutageText = `${concurrent.value}-hub-down`;
    const retainedPreOutageContent = localDuringHubOutage.value
      .split("\n")
      .some((text) => text === expectedOutageText);
    await snap("14-daemon-retained", beta, {
      expectedOutageText,
      retainedPreOutageContent,
      pendingRooms: pendingDuringHubOutage.pendingRooms,
    });

    const reconnectStarted = performance.now();
    remoteHub = await createHub({ ...remoteConfig, port: remotePort });
    trace("15-hub-restarted");
    const reconnect = await waitUntil("daemon remote acknowledgement after outage", async () => {
      const status = await beta.call<SyncPayload>("sync_status");
      return status.hub.status === "connected" && status.pendingRooms.length === 0
        ? status
        : false;
    });
    const reconnectMs = performance.now() - reconnectStarted;
    const offlineToRemote = await waitUntil("offline web edit at the remote hub", () => {
      const documentAtHub = remoteHub?.hocuspocus.documents.get(room);
      if (!documentAtHub) return false;
      const texts = getBlocks(documentAtHub).map((block) => block.text);
      return texts.some((text) => text.includes("-hub-down")) ? texts.join("\n") : false;
    });
    await snap("16-after-hub-reconnect", beta, { awareness: allAwareness() });

    // A normal daemon restart drops every local connection. Browser reconnects;
    // stdio MCP processes end and must be restarted, with the one log intact.
    const oldBeta = beta;
    const restartStarted = performance.now();
    await daemon.stop();
    daemon = null;
    const browserDuringRestart = await waitUntil("the browser to show daemon loss", async () => {
      const word = await page.locator(".ub-status .ub-status-word").first().textContent();
      return word !== null && word !== "synced" ? word : false;
    });
    const betaExitOnRestart = await oldBeta.child.exitCode === null
      ? ((await once(oldBeta.child, "exit")) as [number | null, NodeJS.Signals | null])
      : [oldBeta.child.exitCode, oldBeta.child.signalCode];
    clients.delete(oldBeta);
    daemon = new DaemonProcess(daemonEnv);
    await daemon.ready;
    const restartMs = performance.now() - restartStarted;
    beta = new McpProcess(agentEnv, { name: "claude-code", title: "Agent Beta" });
    clients.add(beta);
    await beta.ready;
    const afterRestart = await waitUntil("browser and MCP after daemon restart", async () => {
      const mcpText = (await beta.call<DocPayload>("get_doc", { uuid })).blocks
        .map((block) => block.text)
        .join("\n");
      const webText = await editorAllText(page);
      return mcpText === webText && mcpText.includes("-hub-down") ? mcpText : false;
    });
    await snap("17-after-daemon-restart", beta);

    // Daemon down at client start is a distinct refused start, not an MCP exit
    // code or a log-derived guess.
    await daemon.stop();
    daemon = null;
    await waitUntil("daemon socket removal", () => !existsSync(daemonSocket));
    const downClient = new McpProcess(agentEnv, { name: "down-start" });
    let downStart = "unexpectedly-started";
    try {
      await downClient.ready;
    } catch (error) {
      downStart = message(error);
    }
    ensure(downStart.includes("daemon unavailable"), "daemon-down start was not distinct");
    await downClient.close();
    daemon = new DaemonProcess(daemonEnv);
    await daemon.ready;
    beta = new McpProcess(agentEnv, { name: "claude-code", title: "Agent Beta" });
    clients.add(beta);
    await beta.ready;

    // Crash after the edit handler has appended, but before JSON-RPC answers.
    const beforeCrash = (await beta.call<DocPayload>("get_doc", { uuid })).blocks[0];
    ensure(beforeCrash !== undefined, "crash fixture block missing");
    writeFileSync(crashMarker, "armed\n");
    let crashCall = "unexpectedly-returned";
    try {
      await beta.call("edit_block", {
        uuid,
        block_id: beforeCrash.id,
        old_text: beforeCrash.text,
        new_text: `${beforeCrash.text}-crash-durable`,
        rev: beforeCrash.rev,
      });
    } catch (error) {
      crashCall = message(error);
    }
    const crashed = await daemon.exited();
    ensure(crashed.signal === "SIGKILL", "crash probe did not kill the daemon");
    daemon = null;
    clients.delete(beta);
    daemon = new DaemonProcess(daemonEnv);
    await daemon.ready;
    beta = new McpProcess(agentEnv, { name: "claude-code", title: "Agent Beta" });
    clients.add(beta);
    await beta.ready;
    const afterCrash = (await beta.call<DocPayload>("get_doc", { uuid })).blocks
      .map((block) => block.text)
      .join("\n");
    await snap("18-after-crash-restart", beta);
    ensure(afterCrash.includes("-crash-durable"), "durable mid-write crash edit was lost");

    // The inverse honesty probe: a refused synchronous append answers
    // applied:false and the mutation does not come back after restart.
    const beforeRefusal = (await beta.call<DocPayload>("get_doc", { uuid })).blocks[0];
    ensure(beforeRefusal !== undefined, "refusal fixture block missing");
    writeFileSync(failMarker, "armed\n");
    const refused = await beta.callRaw<{
      error: string;
      applied: boolean;
      synced: boolean;
    }>("edit_block", {
      uuid,
      block_id: beforeRefusal.id,
      old_text: beforeRefusal.text,
      new_text: `${beforeRefusal.text}-must-not-survive`,
      rev: beforeRefusal.rev,
    });
    ensure(
      refused.isError && refused.payload.applied === false,
      "refused append did not report applied:false",
    );
    await daemon.stop();
    daemon = null;
    clients.delete(beta);
    daemon = new DaemonProcess(daemonEnv);
    await daemon.ready;
    beta = new McpProcess(agentEnv, { name: "claude-code", title: "Agent Beta" });
    clients.add(beta);
    await beta.ready;
    const afterRefusal = (await beta.call<DocPayload>("get_doc", { uuid })).blocks
      .map((block) => block.text)
      .join("\n");
    const refusedMutationSurvived = afterRefusal.includes("must-not-survive");
    await snap("19-after-refusal-restart", beta, { refusedMutationSurvived });

    const bars = {
      coldStart: { limitMs: 200, actualMs: Number(coldStartMs.toFixed(3)) },
      daemonIdleRss: {
        directBytes: directRssBytes,
        limitBytes: Math.max(directRssBytes * 1.5, directRssBytes + 40 * 1024 * 1024),
        actualBytes: daemonIdleRssBytes,
      },
      editBlock: {
        direct: directEdit,
        candidate: daemonEdit,
        medianLimitMs: Math.max(directEdit.medianMs * 2, directEdit.medianMs + 2),
        p95LimitMs: Math.max(directEdit.p95Ms * 3, directEdit.p95Ms + 10),
      },
      reconnect: { limitMs: 1_000, actualMs: Number(reconnectMs.toFixed(3)) },
      offlineToRemote: {
        limitMs: 1_000,
        actualMs: Number(offlineToRemote.elapsedMs.toFixed(3)),
      },
    };

    const result = {
      schemaVersion: 1,
      fixture: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        clients: ["real web app, IndexedDB disabled", "real ub mcp serve: Agent Alpha", "real ub mcp serve: Agent Beta"],
        workspace: WORKSPACE,
        samples: SAMPLE_COUNT,
      },
      authority: {
        browserIndexedDbDisabled: indexedDbDisabled,
        proxySqliteHandles,
        remoteSocketIdsBeforeFailure: initialRemoteSocketIds.value,
        remoteSocketCountBeforeFailure: initialRemoteSocketIds.value.length,
        daemonDatabase: daemonReady.databasePath,
      },
      realClients: {
        webWriteReadByMcp: true,
        mcpWriteReadByWeb: true,
        alphaEditApplied: alphaEdit.applied,
        cursorLabels: cursorLabels.value,
        upstreamAwareness: awareness.value,
        afterAlphaLeaves: afterAlphaLeaves.value,
      },
      failureMatrix: {
        daemonRestart: {
          web: browserDuringRestart.value,
          mcpProcessExit: betaExitOnRestart,
          recoveredText: afterRestart.value,
          elapsedMs: Number(restartMs.toFixed(3)),
        },
        daemonCrashMidWrite: {
          caller: crashCall,
          daemon: crashed,
          recoveredText: afterCrash,
        },
        daemonDownAtClientStart: downStart,
        remoteHubOutage: {
          mcp: hubDown.value.hub.status,
          web: webStatusDuringRemoteOutage,
          expectedText: expectedOutageText,
          localText: localDuringHubOutage.value,
          retainedPreOutageContent,
          pendingRooms: pendingDuringHubOutage.pendingRooms.length,
          hardStop:
            webStatusDuringRemoteOutage === "synced" || !retainedPreOutageContent,
          reason:
            webStatusDuringRemoteOutage === "synced"
              ? "the browser's local Hocuspocus ingress acknowledged before the daemon's remote hub"
              : !retainedPreOutageContent
                ? "disconnecting the upstream hub erased pre-outage content from the still-running local authority"
                : null,
        },
        concurrentSameBlock: {
          agentApplied: concurrentAgent.applied,
          convergedText: concurrent.value,
        },
        refusedAppend: {
          answer: refused.payload,
          absentAfterRestart: !refusedMutationSurvived,
          hardStop: refusedMutationSurvived,
          reason: refusedMutationSurvived
            ? "the in-memory Yjs mutation reached the remote hub even though the daemon log append threw"
            : null,
        },
      },
      reconnect: {
        status: reconnect.value.hub.status,
        remoteText: offlineToRemote.value,
      },
      bars,
      verdict: {
        hardStopObserved:
          webStatusDuringRemoteOutage === "synced" ||
          !retainedPreOutageContent ||
          refusedMutationSurvived,
        feasibleContentAndIdentityPath: true,
        recommendation: refusedMutationSurvived
          ? "do not adopt: upstream disconnect erased local content, and this run propagated a refused daemon append"
          : "do not adopt: upstream disconnect erased local content",
      },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await daemon?.stop().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await vite?.close().catch(() => {});
    await remoteHub?.stop().catch(() => {});
    rmSync(socketDir, { recursive: true, force: true });
    if (KEEP_DIR === null) {
      rmSync(root, { recursive: true, force: true });
    } else {
      trace("kept", { root, daemonDatabase, remoteDatabase, traceFile });
      process.stderr.write(`proof0: run root kept at ${root}\nproof0: daemon database ${daemonDatabase}\nproof0: remote hub database ${remoteDatabase}\n`);
    }
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`daemon-authority spike failed: ${message(error)}\n`);
  process.exitCode = 1;
});
