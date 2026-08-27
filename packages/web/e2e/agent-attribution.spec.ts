/**
 * A short-lived MCP session leaves a *named* caret behind (#304).
 *
 * The pieces already pass in isolation — the server publishes a name, the
 * cursor builder renders one, and `collab.spec.ts` proves a long-lived peer's
 * caret. What none of them covers is the real shape of an agent edit: a stdio
 * client initializes, writes one block, reads the response and exits, and its
 * awareness is gone milliseconds later. So this spec runs that exact path —
 * `ub mcp serve` as a child process, speaking JSON-RPC over its own stdio, to
 * the harness's real hub — rather than injecting an awareness state the way a
 * unit test would. A synthetic peer could not fail the way the real one did.
 *
 * Its own file, and its own harness: `collab.spec.ts` is #46's three proof
 * points and says so.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

test.describe.configure({ mode: "serial" });

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The command an MCP client is configured with — the stable line, verbatim. */
const UB = join(repoRoot, "packages", "cli", "bin", "ub.mjs");

/** How long the caret has to stay after the edit for a person to read it. */
const READABLE_MS = 3_000;

/**
 * How long a closed session is given to exit on its own before it is signalled.
 *
 * Closing stdin is what an MCP client does and what this test is about; the
 * signals after it are the test harness refusing to leave a real server
 * process, its database handle and its hub sockets behind.
 */
const GRACEFUL_EXIT_MS = 5_000;

/** Every session this file has started, so cleanup can reap a stray child. */
const sessions = new Set<McpSession>();

let started: Harness | null = null;
let agentState = "";
const contexts: BrowserContext[] = [];

function harness(): Harness {
  if (started === null) {
    throw new Error("e2e: the harness is not running — its bootstrap failed");
  }
  return started;
}

test.beforeAll(async () => {
  started = await startHarness();
  // The agent's own home: never the developer's `~/.config`, whose workspace
  // and hub would silently replace the harness's.
  agentState = mkdtempSync(join(tmpdir(), "uberblick-e2e-agent-"));
});

test.afterEach(async () => {
  // The sessions first: a test that failed mid-session must not leave a real
  // server process running against the harness's hub. `close` is idempotent,
  // so the ordinary path having closed them already costs nothing.
  await Promise.all([...sessions].map((session) => session.close()));
  sessions.clear();
  for (const context of contexts.splice(0)) await context.close();
});

test.afterAll(async () => {
  const running = started;
  started = null;
  await running?.stop();
  if (agentState !== "") rmSync(agentState, { recursive: true, force: true });
});

async function openApp(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(harness().appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  return page;
}

function editor(page: Page) {
  return page.locator(".ub-editor .ProseMirror");
}

/**
 * Create a document, type into it, and answer with its uuid — which the
 * address carries, `/<workspace>/<uuid>`, and which is what an agent works by.
 *
 * The reader's caret is left in the block on purpose. It is where a reader's
 * caret is while an agent writes, and it is what stops the arrival animation
 * from veiling the very text the caret has to be visible in (#121's "the
 * reader wins").
 */
async function createDoc(page: Page, text: string): Promise<string> {
  const before = new URL(page.url()).pathname;
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect.poll(() => new URL(page.url()).pathname).not.toBe(before);
  await expect(editor(page)).toBeVisible();

  const uuid = new URL(page.url()).pathname.split("/")[2] ?? "";
  if (uuid === "") throw new Error("e2e: no document uuid in the address");

  await page
    .locator(".ub-title")
    .fill(`attribution-${Math.random().toString(36).slice(2, 8)}`);
  const block = page.locator(".ub-editor .ProseMirror > *").first();
  const box = await block.boundingBox();
  if (box === null) throw new Error("e2e: the first block has no box to click");
  await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
  await page.keyboard.type(text, { delay: 15 });
  return uuid;
}

/** A JSON-RPC response frame, as much of one as this client reads. */
interface Frame {
  id?: number;
  error?: unknown;
  result?: { content?: { type: string; text?: string }[]; isError?: boolean };
}

/** What `get_doc` answers with, as far as writing one block needs. */
interface DocPayload {
  blocks: { id: string; text: string; rev: string }[];
}

/**
 * A real MCP client: `ub mcp serve` in a child process, newline-delimited
 * JSON-RPC over its stdio.
 *
 * Hand-rolled rather than the MCP SDK's client, which the web package does not
 * depend on and should not gain a dependency on for one test. The protocol used
 * here is four frames wide.
 */
class McpSession {
  /** Resolves once `initialize` has been answered. */
  readonly ready: Promise<void>;

  private readonly child: ChildProcess;
  private readonly pending = new Map<number, (message: Frame) => void>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private closing: Promise<void> | null = null;

  constructor(clientInfo: { name: string; title?: string }) {
    sessions.add(this);
    this.child = spawn(process.execPath, [UB, "mcp", "serve"], {
      // The agent's own directory, so no `uberblick.json` in the checkout can
      // steer it: everything it needs is in the environment below.
      cwd: agentState,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        WORKSPACE_ID: harness().workspace,
        HUB_URL: harness().hubUrl,
        HUB_AUTH_TOKEN: harness().authSecret,
        UBERBLICK_DB: join(agentState, "agent.sqlite"),
        XDG_CONFIG_HOME: join(agentState, "config"),
        XDG_DATA_HOME: join(agentState, "data"),
      },
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let end = this.buffer.indexOf("\n");
      while (end !== -1) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        // stdout is the transport and carries JSON-RPC only, so a line that is
        // not a frame is itself a failure worth seeing.
        if (line !== "") {
          try {
            const message = JSON.parse(line) as Frame;
            if (typeof message.id === "number") {
              this.pending.get(message.id)?.(message);
              this.pending.delete(message.id);
            }
          } catch {
            // Recorded rather than thrown: an exception out of a stream handler
            // takes the worker down instead of failing the test. The pending
            // request times out and reports this with it.
            this.stderr += `\nnot a JSON-RPC frame on stdout: ${line}`;
          }
        }
        end = this.buffer.indexOf("\n");
      }
    });
    this.ready = this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { ...clientInfo, version: "0.0.0" },
    }).then(() => {
      this.notify("notifications/initialized", {});
    });
  }

  private request(method: string, params: unknown): Promise<Frame> {
    const id = this.nextId++;
    return new Promise((settle, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`e2e: ${method} timed out\n${this.stderr}`));
      }, 30_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        settle(message);
      });
      this.child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  private notify(method: string, params: unknown): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** Call a tool and answer with its JSON payload. Throws on a tool error. */
  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.ready;
    const message = await this.request("tools/call", { name, arguments: args });
    const text = message.result?.content?.[0]?.text ?? "null";
    if (message.error !== undefined || message.result?.isError === true) {
      throw new Error(
        `e2e: ${name} failed: ${JSON.stringify(message.error ?? text)}`,
      );
    }
    return JSON.parse(text) as T;
  }

  /**
   * What an MCP client does when it is done: close stdin, and be gone.
   *
   * Idempotent and bounded. A session that is closed twice — the ordinary path
   * and then the cleanup backstop — waits on the same exit, and a server that
   * does not go on its own is signalled rather than left holding a database
   * handle and a hub socket into the next test.
   */
  close(): Promise<void> {
    this.closing ??= new Promise<void>((settle) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        settle();
        return;
      }
      const term = setTimeout(() => this.child.kill("SIGTERM"), GRACEFUL_EXIT_MS);
      const kill = setTimeout(
        () => this.child.kill("SIGKILL"),
        GRACEFUL_EXIT_MS * 2,
      );
      this.child.once("exit", () => {
        clearTimeout(term);
        clearTimeout(kill);
        settle();
      });
      this.child.stdin?.end();
    });
    return this.closing;
  }
}

/**
 * The path the issue is about: initialize, rewrite one block, read the
 * response, exit. Answers with the instant the write returned — everything
 * after it is the grace period being measured.
 */
async function writeAndLeave(
  clientInfo: { name: string; title?: string },
  uuid: string,
  newText: string,
): Promise<number> {
  const session = new McpSession(clientInfo);
  try {
    const doc = await session.call<DocPayload>("get_doc", { uuid });
    const block = doc.blocks[0];
    if (block === undefined) throw new Error("e2e: the document has no blocks");
    await session.call("edit_block", {
      uuid,
      block_id: block.id,
      old_text: block.text,
      new_text: newText,
      rev: block.rev,
    });
    return Date.now();
  } finally {
    // In a `finally`, because a session that failed half way through is still
    // a running server process — and the closing is the very thing under test.
    await session.close();
  }
}

test("a short-lived MCP client's caret stays long enough to be read, labelled and then gone", async ({
  browser,
}) => {
  // Two real server processes start inside this test, each loading TypeScript
  // through tsx; the default per-test budget is for browser work alone.
  test.setTimeout(180_000);

  const page = await openApp(browser);
  const uuid = await createDoc(page, "watch this");

  const cursor = page.locator(".ub-editor .ProseMirror-yjs-cursor");
  const label = cursor.locator("div");

  // 1. The session name wins over the client name.
  const wroteAt = await writeAndLeave(
    { name: "Codex", title: "Uberblick Coordinator Agent" },
    uuid,
    "watch this — written by an agent that has already gone",
  );
  await expect(label).toHaveText("Uberblick Coordinator Agent");
  await expect(label).toBeVisible();

  // Caret and attribution are one thing: the label is painted in the colour the
  // caret is drawn in, straight from the same awareness state.
  const [caretColor, labelColor] = await Promise.all([
    cursor.evaluate((element) => getComputedStyle(element).borderLeftColor),
    label.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(labelColor).toBe(caretColor);

  // The session itself is gone the moment it left — the grace is a decoration
  // in this editor, not presence. Nothing counts it any more...
  await page.locator(".ub-user-card").click();
  await expect(
    page.locator(".ub-panel-fact", { hasText: "MCP connections" }),
  ).toContainText("0");
  await page.keyboard.press("Escape");

  // ...and nothing lists it either. The sync panel's Present now reads the
  // document room's own awareness — the same room the retained caret is drawn
  // in — and says the room is empty while that caret is on screen.
  await page.locator(".ub-sync-toggle").click();
  const presence = page.locator("#ub-sync-panel");
  await expect(presence).toContainText("Nobody else is in this room.");
  await expect(
    presence.getByText("Uberblick Coordinator Agent"),
  ).toHaveCount(0);
  await page.locator(".ub-sync-toggle").click();
  await expect(label).toBeVisible();

  // ...and it is still on screen three seconds after the write returned, which
  // is the whole point: a person gets to see who wrote.
  const remaining = READABLE_MS - (Date.now() - wroteAt);
  if (remaining > 0) await page.waitForTimeout(remaining);
  await expect(label).toHaveText("Uberblick Coordinator Agent");

  // It expires on its own. Nothing has to be clicked, and nothing survives.
  await expect(cursor).toHaveCount(0, { timeout: 30_000 });

  // 2. No usable title: the client's own name is what a reader gets.
  await writeAndLeave(
    { name: "Codex", title: "   " },
    uuid,
    "watch this — written by a client with nothing but a name",
  );
  await expect(label).toHaveText("Codex");
  await expect(label).toBeVisible();
  await expect(cursor).toHaveCount(0, { timeout: 30_000 });
});
