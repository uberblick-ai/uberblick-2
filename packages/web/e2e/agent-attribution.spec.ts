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
import { AGENT_CURSOR_GRACE_MS } from "../src/editor/collaboration.js";
import { createDoc, docTitle, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";

// Keep the original readable-period proof inside the unchanged production grace.
const READABLE_MS = 25_000;
const { harness, openApp } = setupHarness({ app: { upstream: true, readySelector: ".ub-list-head" } });
let mcpAgent: McpAgent | null = null;

function agent(): McpAgent {
  if (mcpAgent === null) {
    throw new Error("e2e: the MCP agent is not configured");
  }
  return mcpAgent;
}

test.beforeAll(async () => {
  mcpAgent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-agent-",
  });
});

test.afterEach(async () => {
  // A test that failed mid-session must close its real server processes too.
  // `close` is idempotent, including after the ordinary departure path.
  await mcpAgent?.closeSessions();
});

test.afterAll(async () => {
  await mcpAgent?.close();
  mcpAgent = null;
});

/** What `get_doc` answers with, as far as writing one block needs. */
interface DocPayload {
  blocks: { id: string; text: string; rev: string }[];
}

/**
 * The path the issue is about: initialize, rewrite one block, read the
 * response, exit. The browser observes the real departure before its own clock
 * advances; the MCP process and hub stay on real time.
 */
async function writeAndLeave(
  clientInfo: { name: string; title?: string },
  uuid: string,
  newText: string,
): Promise<void> {
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
  } finally {
    // In a `finally`, because a session that failed half way through is still
    // a running server process — and the closing is the very thing under test.
    await session.close();
  }
}

test("a short-lived MCP client's caret stays long enough to be read, labelled and then gone", async ({
  browser,
}) => {
  let socketCloses = 0;
  const page = await openApp(browser, "/", {
    beforeNavigate: async (loading) => {
      loading.on("websocket", (socket) => socket.on("close", () => { socketCloses += 1; }));
      await loading.clock.install();
    },
  });
  const uuid = await createDoc(page, docTitle("attribution"));
  await placeCaret(page);
  await page.keyboard.type("watch this", { delay: 15 });

  const cursor = page.locator(".ub-editor .ProseMirror-yjs-cursor");
  const label = cursor.locator("div");

  // 1. The session name wins over the client name.
  await writeAndLeave(
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

  // The bundle's production timer runs under the page clock. Keep every
  // intermediate timer callback (including provider heartbeats) running, so a
  // reconnect cannot stand in for the caret expiring on its own.
  await page.clock.runFor(READABLE_MS);
  await expect(label).toHaveText("Uberblick Coordinator Agent");
  await expect(label).toBeVisible();

  await page.clock.runFor(AGENT_CURSOR_GRACE_MS - READABLE_MS + 1);
  await expect(cursor).toHaveCount(0);
  expect(socketCloses).toBe(0);

  // 2. No usable title: the client's own name is what a reader gets.
  await writeAndLeave(
    { name: "Codex", title: "   " },
    uuid,
    "watch this — written by a client with nothing but a name",
  );
  await expect(label).toHaveText("Codex");
  await expect(label).toBeVisible();
  // Also observe this session's actual departure, then defend the same
  // labelled retention and automatic expiry for the client-name fallback.
  await page.locator(".ub-user-card").click();
  await expect(page.locator(".ub-panel-fact", { hasText: "MCP connections" })).toContainText("0");
  await page.keyboard.press("Escape");
  await page.locator(".ub-sync-toggle").click();
  await expect(presence).toContainText("Nobody else is in this room.");
  await expect(presence.getByText("Codex", { exact: true })).toHaveCount(0);
  await page.locator(".ub-sync-toggle").click();
  await expect(label).toBeVisible();
  await page.clock.runFor(READABLE_MS);
  await expect(label).toHaveText("Codex");
  await expect(label).toBeVisible();
  await page.clock.runFor(AGENT_CURSOR_GRACE_MS - READABLE_MS + 1);
  await expect(cursor).toHaveCount(0);
  expect(socketCloses).toBe(0);
});
