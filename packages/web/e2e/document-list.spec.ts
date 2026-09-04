/**
 * The document list in a real browser (#406).
 *
 * One spec, and only for the claims jsdom cannot make: that the workspace's own
 * address is the list — the first screen of a session, in a real bundle beside
 * a real sidebar — that the sidebar's fixed entry navigates a real history to
 * `/<workspace>/all` and finds the same list there, and that what both show is
 * a directory which travelled the hub: the documents were created in another
 * browser context, and nothing told this one about them.
 *
 * The semantic table and keyboard-sort contract need the browser's own
 * accessibility and activation behavior. Everything else — missing-stamp
 * ordering, filter edge cases, the pinned group, the empty-state wording — is
 * pinned in `test/document-list.test.tsx` over shared Y.Docs and is not
 * repeated here. The lifecycle scenario is the browser-only seam: an external
 * writer moves the open header and the directory-backed row without a reload.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { resolveStorage } from "@uberblick/hub";
import { startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

test.describe.configure({ mode: "serial" });

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const UB = join(repoRoot, "packages", "cli", "bin", "ub.mjs");
const GRACEFUL_EXIT_MS = 5_000;

let started: Harness | null = null;
const contexts: BrowserContext[] = [];
const sessions = new Set<McpSession>();
let agentState = "";

function harness(): Harness {
  if (started === null) {
    throw new Error("e2e: the harness is not running — its bootstrap failed");
  }
  return started;
}

function configureAgent(): void {
  const { configDir } = resolveStorage({
    env: { XDG_CONFIG_HOME: join(agentState, "config") },
  });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    `${JSON.stringify({ workspace: harness().workspace, hubUrl: harness().hubUrl }, null, 2)}\n`,
  );
}

test.beforeAll(async () => {
  started = await startHarness();
  agentState = mkdtempSync(join(tmpdir(), "uberblick-e2e-document-list-"));
  configureAgent();
});

test.afterEach(async () => {
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

/** A fresh context: its own IndexedDB, its own history, its own tab. */
async function openApp(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(harness().appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  return page;
}

/** Unique per run: every test in the file shares one workspace. */
function docTitle(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The titles the list shows, top to bottom. */
function listedTitles(page: Page): Locator {
  return page.locator(".ub-docs-title");
}

async function createDoc(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ProseMirror")).toBeVisible();
  await page.locator(".ub-title").fill(title);
}

interface Frame {
  id?: number;
  error?: unknown;
  result?: { content?: { type: string; text?: string }[]; isError?: boolean };
}

/** A real `ub mcp serve` client, kept local because this file needs two calls. */
class McpSession {
  readonly ready: Promise<void>;

  private readonly child: ChildProcess;
  private readonly pending = new Map<number, (message: Frame) => void>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private closing: Promise<void> | null = null;

  constructor() {
    sessions.add(this);
    this.child = spawn(process.execPath, [UB, "mcp", "serve"], {
      cwd: agentState,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        WORKSPACE_ID: harness().workspace,
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
        if (line !== "") {
          try {
            const message = JSON.parse(line) as Frame;
            if (typeof message.id === "number") {
              this.pending.get(message.id)?.(message);
              this.pending.delete(message.id);
            }
          } catch {
            this.stderr += `\nnot a JSON-RPC frame on stdout: ${line}`;
          }
        }
        end = this.buffer.indexOf("\n");
      }
    });
    this.ready = this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "document-list-e2e", version: "0.0.0" },
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

test("the workspace address is the list, and it holds what another browser created", async ({
  browser,
}) => {
  const first = docTitle("zebra");
  const second = docTitle("aardvark");

  const [author, reader] = await Promise.all([openApp(browser), openApp(browser)]);
  await createDoc(author, first);
  await createDoc(author, second);

  // The second browser was told nothing: the directory is a synced document,
  // and the list is that document. `/` resolves to the workspace's own address,
  // which is where a session starts.
  await expect(reader).toHaveURL(new RegExp(`/${harness().workspace}$`));
  // Most recently changed first — the second document was created last.
  await expect(listedTitles(reader)).toHaveText([second, first]);
  const table = reader.getByRole("table");
  const titleHeading = table.getByRole("columnheader", { name: /^Title/ });
  const changedHeading = table.getByRole("columnheader", { name: /^Last changed/ });
  await expect(changedHeading).toHaveAttribute("aria-sort", "descending");
  await expect(titleHeading).not.toHaveAttribute("aria-sort");

  // Native buttons give the two headers the same keyboard and pointer path.
  const titleSort = titleHeading.getByRole("button", { name: "Title" });
  await titleSort.focus();
  await reader.keyboard.press("Enter");
  await expect(titleHeading).toHaveAttribute("aria-sort", "ascending");
  await expect(titleHeading.locator(".ub-docs-sort-arrow")).toHaveText("↑");
  await expect(changedHeading).not.toHaveAttribute("aria-sort");

  await reader.keyboard.press("Space");
  await expect(titleHeading).toHaveAttribute("aria-sort", "descending");
  await expect(listedTitles(reader)).toHaveText([first, second]);

  await changedHeading.getByRole("button", { name: "Last changed" }).click();
  await expect(changedHeading).toHaveAttribute("aria-sort", "descending");
  await expect(listedTitles(reader)).toHaveText([second, first]);
  // The scope is the field's accessible name in a real browser, not a sentence
  // beside it: this filters titles alone, not bodies.
  await expect(
    reader.getByRole("searchbox", { name: /title.*not document text/i }),
  ).toBeVisible();

  // Typing filters what is already here — no request, no room.
  await reader.locator(".ub-docs-search").fill(first);
  await expect(listedTitles(reader)).toHaveText([first]);
  await reader.locator(".ub-docs-search").fill("");

  // The sidebar's fixed entry is the same list at its own address.
  const entry = reader.getByRole("button", { name: "All docs" });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(reader).toHaveURL(new RegExp(`/${harness().workspace}/all$`));
  await expect(listedTitles(reader)).toHaveText([second, first]);
  // Named after its own row, so the two pins are two different controls.
  const pin = reader.getByRole("button", { name: `Pin ${second} to the sidebar` });
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await expect(pin.locator("svg")).toBeVisible();

  // And the address is a link: a fresh browser goes straight there.
  const linked = await openApp(browser);
  await linked.goto(new URL(`/${harness().workspace}/all`, harness().appUrl).href);
  await expect(listedTitles(linked)).toHaveText([second, first]);

  // Opening a row is opening the document.
  await listedTitles(linked).first().click();
  await expect(linked.locator(".ub-title")).toHaveValue(second);
});

test("a new document stores the title shown by the list", async ({ browser }) => {
  const page = await openApp(browser);

  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-title")).toHaveValue("Untitled");

  await page.getByRole("button", { name: "All docs" }).click();
  await page.locator(".ub-docs-search").fill("untitled");
  await expect(listedTitles(page)).toHaveText(["Untitled"]);
});

test("a lifecycle update outside the browser moves the row and both badges", async ({
  browser,
}) => {
  const title = docTitle("roadmap");
  const page = await openApp(browser);
  const agent = new McpSession();
  const created = await agent.call<{ uuid: string }>("create_doc", {
    title,
    description: "A roadmap item created outside the browser.",
    kind: "requirement",
    status: "planned",
  });
  await expect(page.locator(".ub-docs-title", { hasText: title })).toHaveCount(0);
  await page.getByRole("button", { name: "Product", exact: true }).click();
  const row = page.locator(".ub-docs-row", { hasText: title });
  await expect(row.locator(".ub-lifecycle-badge")).toHaveText(
    "Product · planned",
  );

  await row.locator(".ub-docs-open").click();
  await expect(page.locator(".ub-lifecycle-badge")).toHaveText(
    "Product · planned",
  );
  await agent.call("set_status", { uuid: created.uuid, status: "implementing" });
  await expect(page.locator(".ub-lifecycle-badge")).toHaveText(
    "Product · implementing",
  );
  await page.getByRole("button", { name: "All docs" }).click();
  await page.getByRole("button", { name: "Product", exact: true }).click();
  await expect(
    page.locator(".ub-docs-row", { hasText: title }).locator(".ub-lifecycle-badge"),
  ).toHaveText("Product · implementing");
});
