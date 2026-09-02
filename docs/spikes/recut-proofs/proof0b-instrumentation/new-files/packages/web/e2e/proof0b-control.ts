/**
 * Proof 0b CONTROL (instrumented, parameterised): derived from proof0-control.ts.
 *
 * Real in-process hub, real web app connected directly to it, two real
 * `ub mcp serve` processes against it. No daemon, no local ingress. Helpers are
 * copied verbatim from proof0-daemon-spike.ts.
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


/** Production-path control run, instrumented. */
async function main(): Promise<void> {
  const root = KEEP_DIR
    ? mkdtempSync(join(KEEP_DIR, "control-run-"))
    : mkdtempSync(join(tmpdir(), "uberblick-proof0b-control-"));
  traceFile = join(root, "trace.jsonl");
  const disableIndexedDb = process.env.PROOF0_NO_IDB === "1";
  const authors = new Set((process.env.PROOF0B_AUTHORS ?? "web,agents,concurrent").split(",").map((a) => a.trim()).filter(Boolean));
  const outage = process.env.PROOF0B_OUTAGE === "pause" ? "pause" : process.env.PROOF0B_OUTAGE === "none" ? "none" : "stop";
  const settleMs = Number(process.env.PROOF0B_SETTLE_MS ?? "0");
  const noClick = process.env.PROOF0B_NO_CLICK === "1";
  const typeText = process.env.PROOF0B_TYPE_TEXT ?? "-hub-down";
  const caret = process.env.PROOF0B_CARET === "keyboard" ? "keyboard" : process.env.PROOF0B_CARET === "wait" ? "wait" : "click";
  const scenario = { authors: [...authors], outage, settleMs, noClick, typeText, caret, disableIndexedDb };
  trace("start", { root, keep: KEEP_DIR !== null, node: process.version, platform: process.platform, scenario });
  const hubDatabase = join(root, "hub.sqlite");
  const hubLogs: HubLogRecord[] = [];
  let hub: Hub | null = null;
  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  const clients = new Set<McpProcess>();
  const hubConfig: HubConfig = {
    authSecret: SECRET,
    port: 0,
    databasePath: hubDatabase,
    log: (record) => hubLogs.push(record),
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  };
  const directEnv = (name: string): NodeJS.ProcessEnv => {
    const home = join(root, name);
    return {
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      WORKSPACE_ID: WORKSPACE,
      HUB_AUTH_TOKEN: SECRET,
      UBERBLICK_DB: join(home, `${name}.sqlite`),
    };
  };
  const writeConfig = (env: NodeJS.ProcessEnv, hubUrl: string): void => {
    const { configDir } = resolveStorage({ env });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), `${JSON.stringify({ workspace: WORKSPACE, hubUrl })}\n`);
  };

  try {
    hub = await createHub(hubConfig);
    const hubPort = hub.port;
    const hubUrl = `ws://127.0.0.1:${hubPort}`;
    const alphaEnv = directEnv("alpha");
    const betaEnv = directEnv("beta");
    writeConfig(alphaEnv, hubUrl);
    writeConfig(betaEnv, hubUrl);
    const alpha = new McpProcess(alphaEnv, { name: "codex", title: "Agent Alpha" });
    const beta = new McpProcess(betaEnv, { name: "claude-code", title: "Agent Beta" });
    clients.add(alpha);
    clients.add(beta);
    await Promise.all([alpha.ready, beta.ready]);

    const document = await alpha.call<DocPayload>("create_doc", {
      title: "Proof 0b control",
      description: "Production path, instrumented.",
      blocks: [{ type: "paragraph", text: "middle" }],
    });
    const uuid = document.uuid;
    const room = `${WORKSPACE}/${uuid}`;
    await waitUntil("Beta to see the document", async () => {
      try {
        const read = await beta.call<DocPayload>("get_doc", { uuid });
        return read.blocks.length > 0 ? read : false;
      } catch {
        return false;
      }
    });

    const runningVite = await startVite(hubUrl);
    vite = runningVite.server;
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    if (disableIndexedDb) {
      await context.addInitScript(() => {
        Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true });
      });
    }
    const page = await context.newPage();
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.startsWith("P0B ")) {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(text.slice(4)) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        traceLine(`P0B ${JSON.stringify({ t: Date.now(), from: "browser", ...(parsed ?? { raw: text.slice(4, 2000) }) })}`);
        return;
      }
      if (msg.type() === "error" || msg.type() === "warning") {
        trace("browser-console", { type: msg.type(), text: text.slice(0, 500) });
      }
    });
    page.on("pageerror", (error) => trace("browser-pageerror", { text: String(error).slice(0, 500), stack: String((error as { stack?: string }).stack ?? "").slice(0, 2000) }));
    const allAwareness = () => {
      const states = hub?.hocuspocus.documents.get(room)?.awareness.getStates();
      return states
        ? [...states.entries()].map(([clientId, state]) => ({
            clientId,
            name: (state.user as { name?: string } | undefined)?.name ?? null,
            client: state.client ?? null,
          }))
        : null;
    };
    const pmState = async (): Promise<unknown> => {
      try {
        return await page.evaluate(() => (globalThis as { __p0state?: () => unknown }).__p0state?.() ?? null);
      } catch (error) {
        return `error: ${message(error)}`;
      }
    };
    const snap = async (step: string, client: McpProcess | null, extra: Record<string, unknown> = {}): Promise<void> => {
      let mcp: unknown = null;
      if (client !== null) {
        try {
          mcp = (await client.call<DocPayload>("get_doc", { uuid })).blocks.map((block) => ({ id: block.id, text: block.text }));
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
      trace(step, { web, webStatus, mcp, hub: hubRawBlocks(hub, room), pm: await pmState(), ...extra });
    };

    await page.goto(new URL(`/${WORKSPACE}/${uuid}`, runningVite.appUrl).href);
    await page.locator(".ub-editor .ProseMirror").waitFor();
    await waitUntil("the browser to read the document", async () => ((await editorText(page)) === "middle" ? "middle" : false));
    const indexedDbPresent = await page.evaluate(() => typeof indexedDB !== "undefined");
    await snap("01-browser-opened", alpha, { indexedDbPresent });

    if (authors.has("web")) {
      await caretToEnd(page);
      await page.keyboard.type("-web", { delay: 15 });
      await waitUntil("an MCP client to read the web write", async () => {
        const read = await alpha.call<DocPayload>("get_doc", { uuid });
        return read.blocks[0]?.text.endsWith("-web") ? read.blocks[0].text : false;
      });
    }
    await snap("02-web-typed", alpha);

    if (authors.has("agents")) {
      const alphaBlock = (await alpha.call<DocPayload>("get_doc", { uuid })).blocks[0];
      ensure(alphaBlock !== undefined, "agent document has no block");
      await alpha.call<EditPayload>("edit_block", { uuid, block_id: alphaBlock.id, old_text: alphaBlock.text, new_text: `${alphaBlock.text}-alpha`, rev: alphaBlock.rev });
      await waitUntil("Agent Alpha's edit in the web app", async () => ((await editorText(page)).endsWith("-alpha") ? true : false));
      await snap("03-alpha-edited", alpha);
      const betaBlock = await waitUntil("Beta to see Alpha's edit", async () => {
        const block = (await beta.call<DocPayload>("get_doc", { uuid })).blocks[0];
        return block?.text.endsWith("-alpha") ? block : false;
      });
      await beta.call<EditPayload>("edit_block", { uuid, block_id: betaBlock.value.id, old_text: betaBlock.value.text, new_text: `${betaBlock.value.text}-beta`, rev: betaBlock.value.rev });
      await waitUntil("Agent Beta's edit in the web app", async () => ((await editorText(page)).endsWith("-beta") ? true : false));
    }
    await snap("04-beta-edited", beta, { awareness: allAwareness() });

    if (authors.has("concurrent")) {
      const beforeConcurrent = (await beta.call<DocPayload>("get_doc", { uuid })).blocks[0];
      ensure(beforeConcurrent !== undefined, "concurrency block missing");
      await context.setOffline(true);
      await caretToEnd(page);
      await page.keyboard.type("-offline-web", { delay: 5 });
      await beta.call<EditPayload>("edit_block", { uuid, block_id: beforeConcurrent.id, old_text: beforeConcurrent.text, new_text: `agent-${beforeConcurrent.text}`, rev: beforeConcurrent.rev });
      await snap("05-offline-both-edited", beta);
      await context.setOffline(false);
      await waitUntil("the concurrent same-block edits to converge", async () => {
        const webText = await editorText(page);
        const mcpText = (await beta.call<DocPayload>("get_doc", { uuid })).blocks[0]?.text ?? "";
        return webText === mcpText && webText.includes("agent-") && webText.includes("-offline-web") ? webText : false;
      });
    } else if (authors.has("web")) {
      await caretToEnd(page);
      await page.keyboard.type("-offline-web", { delay: 5 });
      await waitUntil("the online web edit to reach Beta", async () => {
        const webText = await editorText(page);
        const mcpText = (await beta.call<DocPayload>("get_doc", { uuid })).blocks[0]?.text ?? "";
        return webText === mcpText && webText.includes("-offline-web") ? webText : false;
      });
    }
    const converged = await waitUntil("web and Beta to agree before the outage", async () => {
      const webText = await editorText(page);
      const mcpText = (await beta.call<DocPayload>("get_doc", { uuid })).blocks[0]?.text ?? "";
      return webText === mcpText && webText !== "" ? webText : false;
    });
    await snap("06-online-converged", beta, { preOutageText: converged.value });

    await alpha.close();
    clients.delete(alpha);
    await snap("07-alpha-left", beta, { awareness: allAwareness() });

    await snap("08-before-outage", beta, { hubUp: true, outage });
    if (outage === "stop") {
      await hub.stop();
      hub = null;
      trace("09-hub-stopped");
      const hubDown = await waitUntil("Beta to report the hub down", async () => {
        const status = await beta.call<SyncPayload>("sync_status");
        return status.hub.status === "hub-down" ? status : false;
      });
      await snap("10-mcp-reports-hub-down", beta, { betaStatus: hubDown.value.hub.status });
      const webStatusDuringOutage = await waitUntil("the browser to notice the hub is gone", async () => {
        const word = await page.locator(".ub-status .ub-status-word").first().textContent();
        return word !== null && word !== "synced" ? word : false;
      });
      await snap("11-before-typing", beta, { webStatusDuringOutage: webStatusDuringOutage.value });
    } else if (outage === "pause") {
      await context.setOffline(true);
      trace("09-network-paused");
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      await snap("11-before-typing", beta, { webStatusDuringOutage: null });
    } else {
      trace("09-no-outage");
      await snap("11-before-typing", beta, { webStatusDuringOutage: null });
    }
    if (settleMs > 0) {
      trace("11b-settling", { settleMs });
      await new Promise((resolveWait) => setTimeout(resolveWait, settleMs));
      await snap("11c-settled", beta);
    }
    // The candidate harness fix. A mouse click is classified by ProseMirror
    // against its own `input.lastClick` (<500 ms, <10 px => double, then
    // triple), independent of the event's native click count, and a triple
    // click selects the whole textblock. Placing the caret by keyboard when
    // the editor already has focus never enters that heuristic; waiting out
    // the window keeps a click a single click.
    if (!noClick) {
      if (caret === "keyboard") {
        // `globalThis.document`: this file has a local `document` (the created doc), which esbuild renames inside the serialised arrow.
        const focused = await page.evaluate(() => globalThis.document.activeElement?.closest(".ProseMirror") != null);
        if (focused) await page.keyboard.press("End");
        else await caretToEnd(page);
        trace("12a-caret-strategy", { caret, focused });
      } else if (caret === "wait") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 550));
        await caretToEnd(page);
        trace("12a-caret-strategy", { caret });
      } else {
        await caretToEnd(page);
      }
    }
    await snap("12-caret-placed", beta, { clicked: !noClick, caret });
    await page.keyboard.type(typeText, { delay: 5 });
    await snap("13-typed", beta);
    const expectedOutageText = `${converged.value}${typeText}`;
    const webDuringOutage = await editorBlocks(page);

    if (outage === "stop") {
      hub = await createHub({ ...hubConfig, port: hubPort });
      trace("15-hub-restarted");
    } else if (outage === "pause") {
      await context.setOffline(false);
      trace("15-network-resumed");
    } else {
      trace("15-no-outage");
    }
    const reconnect = await waitUntil("Beta reconnected with nothing pending", async () => {
      const status = await beta.call<SyncPayload>("sync_status");
      return status.hub.status === "connected" && status.pendingRooms.length === 0 ? status : false;
    });
    const atHub = await waitUntil("the outage edit at the hub", () => {
      const documentAtHub = hub?.hocuspocus.documents.get(room);
      if (!documentAtHub) return false;
      const texts = getBlocks(documentAtHub).map((block) => block.text);
      return texts.some((text) => text.includes(typeText)) ? texts : false;
    });
    const convergedAfter = await waitUntil("browser, Beta and hub to converge after the outage", async () => {
      const mcpText = (await beta.call<DocPayload>("get_doc", { uuid })).blocks.map((block) => block.text).join("\n");
      const webText = await editorAllText(page);
      return mcpText === webText && mcpText.includes(typeText) ? mcpText : false;
    });
    await snap("16-after-reconnect", beta, { awareness: allAwareness() });
    const retainedPreOutageContent = convergedAfter.value.split("\n").some((text) => text === expectedOutageText);

    const gamma = new McpProcess(directEnv("gamma"), { name: "fresh", title: "Agent Gamma" });
    writeConfig(directEnv("gamma"), hubUrl);
    clients.add(gamma);
    await gamma.ready;
    const gammaRead = await waitUntil("a fresh MCP client to hydrate the document", async () => {
      try {
        const read = await gamma.call<DocPayload>("get_doc", { uuid });
        return read.blocks.some((block) => block.text.includes(typeText)) ? read.blocks : false;
      } catch {
        return false;
      }
    });
    await snap("17-fresh-client-hydrated", gamma);

    const finalWeb = await editorBlocks(page);
    const finalMcp = (await beta.call<DocPayload>("get_doc", { uuid })).blocks;
    const finalHub = hubRawBlocks(hub, room) ?? [];
    const result = {
      schemaVersion: 2,
      control: "proof0b instrumented production path",
      scenario,
      node: process.version,
      platform: process.platform,
      indexedDbPresent,
      preOutageText: converged.value,
      outage: {
        expectedText: expectedOutageText,
        webBlocksDuringOutage: webDuringOutage,
        atHubAfterRestart: atHub.value,
        convergedText: convergedAfter.value,
        retainedPreOutageContent,
        reconnectStatus: reconnect.value.hub.status,
      },
      freshClient: gammaRead.value.map((block) => block.text),
      final: {
        web: finalWeb,
        mcp: finalMcp.map((block) => ({ id: block.id, text: block.text })),
        hub: finalHub,
      },
      lossObserved: !retainedPreOutageContent,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await vite?.close().catch(() => {});
    await hub?.stop().catch(() => {});
    if (KEEP_DIR === null) {
      rmSync(root, { recursive: true, force: true });
    } else {
      trace("kept", { root, hubDatabase, traceFile });
      process.stderr.write(`proof0b-control: run root kept at ${root}\n`);
    }
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`proof0b control failed: ${message(error)}\n`);
  process.exitCode = 1;
});
