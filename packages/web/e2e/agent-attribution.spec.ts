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

import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { placeCaret, startHarness } from "./harness.js";
import type { Harness } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";

test.describe.configure({ mode: "serial" });

/**
 * How long the caret has to stay after the edit for a person to read it.
 *
 * The grace is 30 s (#407) and it starts when the session *leaves*, which is
 * later than the write this is measured from — by however long the child takes
 * to exit and the hub takes to broadcast the departure. Asserting at a full 30 s
 * would therefore be asserting at the instant of expiry, with only that unknown
 * as margin; 25 s is comfortably inside the grace and nowhere near the five
 * seconds this used to be, which had expired twenty seconds earlier.
 */
const READABLE_MS = 25_000;

/**
 * How long an expiry is allowed to take before the test calls it a failure.
 *
 * Longer than the grace itself, for the same reason the wait above is shorter:
 * the clock starts at a departure this test does not get to observe. A timeout
 * equal to the grace would race it and report a caret that outlived its session
 * by half a second as one that never expires.
 */
const EXPIRY_MS = 45_000;

let started: Harness | null = null;
let mcpAgent: McpAgent | null = null;
const contexts: BrowserContext[] = [];

function harness(): Harness {
  if (started === null) {
    throw new Error("e2e: the harness is not running — its bootstrap failed");
  }
  return started;
}

function agent(): McpAgent {
  if (mcpAgent === null) {
    throw new Error("e2e: the MCP agent is not configured");
  }
  return mcpAgent;
}

test.beforeAll(async () => {
  started = await startHarness();
  mcpAgent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-agent-",
  });
});

test.afterEach(async () => {
  // The sessions first: a test that failed mid-session must not leave a real
  // server process running against the harness's hub. `close` is idempotent,
  // so the ordinary path having closed them already costs nothing.
  await mcpAgent?.closeSessions();
  for (const context of contexts.splice(0)) await context.close();
});

test.afterAll(async () => {
  const running = started;
  started = null;
  await mcpAgent?.close();
  mcpAgent = null;
  await running?.stop();
});

async function openApp(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  // This proof is specifically the upstream MCP-awareness path. `ub open`'s
  // local/upstream awareness relay is #753, so keep both participants on the
  // upstream until that separate bridge exists.
  await context.route("**/uberblick-config.json", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hubUrl: harness().hubUrl,
        workspaces: [harness().workspace],
        hubAuthToken: harness().authSecret,
      }),
    });
  });
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
  await placeCaret(page);
  await page.keyboard.type(text, { delay: 15 });
  return uuid;
}

/** What `get_doc` answers with, as far as writing one block needs. */
interface DocPayload {
  blocks: { id: string; text: string; rev: string }[];
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
  const session = agent().open(clientInfo);
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

  // ...and it is still on screen — labelled — twenty-five seconds after the
  // write returned, which is the whole point: a person gets to see who wrote,
  // for as long as a connected agent's cursor would have stayed.
  const remaining = READABLE_MS - (Date.now() - wroteAt);
  if (remaining > 0) await page.waitForTimeout(remaining);
  await expect(label).toHaveText("Uberblick Coordinator Agent");
  await expect(label).toBeVisible();

  // It expires on its own. Nothing has to be clicked, and nothing survives.
  await expect(cursor).toHaveCount(0, { timeout: EXPIRY_MS });

  // 2. No usable title: the client's own name is what a reader gets.
  await writeAndLeave(
    { name: "Codex", title: "   " },
    uuid,
    "watch this — written by a client with nothing but a name",
  );
  await expect(label).toHaveText("Codex");
  await expect(label).toBeVisible();
  await expect(cursor).toHaveCount(0, { timeout: EXPIRY_MS });
});
