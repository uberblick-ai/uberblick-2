/**
 * A short-lived MCP session leaves its named caret and departed title avatar
 * behind for one grace period.
 *
 * The pieces already pass in isolation — the server publishes a name, the
 * cursor builder renders one, and `collab.spec.ts` proves a long-lived peer's
 * caret. What none of them covers is the real shape of an agent edit: a stdio
 * client initializes, writes one block, reads the response and exits, and its
 * awareness is gone milliseconds later. So this spec runs that exact path —
 * `ub mcp serve` as a child process, speaking JSON-RPC over its own stdio, to
 * the harness's real hub — rather than injecting an awareness state the way a
 * unit test would. A synthetic peer would miss the real shutdown timing.
 *
 * Its own file and harness keep the short-lived MCP path separate from
 * `collab.spec.ts`'s long-lived peer proof.
 */

import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import { AGENT_CURSOR_GRACE_MS } from "../src/editor/collaboration.js";
import { contrast } from "../test/colour.js";
import { createDoc, docTitle, openDoc, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";

// The readable-period proof must fit inside the production grace.
const READABLE_MS = 25_000;
const { harness, openApp } = setupHarness({ app: { upstream: true, readySelector: ".ub-document-sidebar" } });
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
 * The MCP write path: initialize, rewrite one block, read the
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
    await writeBlock(session, uuid, newText);
  } finally {
    // In a `finally`, because a session that failed half way through is still
    // a running server process — and the closing is the very thing under test.
    await session.close();
  }
}

async function writeBlock(session: McpSession, uuid: string, newText: string): Promise<void> {
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
}

for (const settings of [
  { name: "desktop light", colorScheme: "light", touch: false, viewport: { width: 1280, height: 800 } },
  { name: "iPad-sized touch dark", colorScheme: "dark", touch: true, viewport: { width: 820, height: 1180 } },
] as const) {
  test(`a short-lived MCP client's title avatar and caret depart together — ${settings.name}`, async ({ browser }) => {
    let socketCloses = 0;
    const page = await openApp(browser, "/", {
      readySelector: ".ub-pane",
      contextOptions: {
        colorScheme: settings.colorScheme,
        hasTouch: settings.touch,
        viewport: settings.viewport,
      },
      beforeNavigate: async (loading) => {
        loading.on("websocket", (socket) => socket.on("close", () => { socketCloses += 1; }));
        await loading.clock.install();
      },
    });
    const activate = (control: Locator): Promise<void> => settings.touch ? control.tap() : control.click();
    const openSidebar = async (): Promise<void> => {
      if (settings.touch) {
        await activate(page.getByRole("button", { name: "Show document list", exact: true }));
      }
    };
    if (settings.touch) {
      expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    }
    await openSidebar();
    const title = docTitle("attribution");
    const uuid = await createDoc(page, title, { pin: !settings.touch });
    await placeCaret(page);
    await page.keyboard.type("watch this", { delay: 15 });
    // Freeze before departure, so the last millisecond of the shared grace is
    // independent of the real MCP/hub processes and assertion time.
    await page.clock.pauseAt(new Date(Date.now() + 1_000));

    const cursor = page.locator(".ub-editor .ProseMirror-yjs-cursor");
    const label = cursor.locator("div");
    const peer = page.locator(".ub-peers > .ub-peer-control[data-peer-id]");
    const avatar = peer.locator(".ub-avatar");
    const facts = await page.context().newPage();
    try {
      await facts.goto(new URL(`/${harness().workspace}/settings`, harness().appUrl).href);
      await expect(facts.getByRole("heading", { level: 1, name: "General", exact: true })).toBeVisible();
      await facts.getByRole("button", { name: "Connection details", exact: true }).click();
      await page.bringToFront();

      // A usable session title wins; otherwise the client's own name is retained.
      for (const session of [
        { title: "Uberblick Coordinator Agent", name: "Uberblick Coordinator Agent" },
        { title: "   ", name: "Codex" },
      ]) {
        await writeAndLeave(
          { name: "Codex", title: session.title },
          uuid,
          `watch this — written by ${session.name}, who has already gone`,
        );
        await expect(peer).toHaveCount(1);
        await expect(peer).toHaveAccessibleName(new RegExp(`^${session.name} · agent.* · left$`));
        // y-prosemirror batches awareness decorations through a zero-delay
        // timer. Drain that ordinary editor work without unfreezing the grace.
        await page.clock.runFor(1);
        await expect(label).toHaveText(session.name);
        await expect(label).toBeVisible();
        await expect(peer).not.toHaveAccessibleName(/active|editing/);
        await expect(avatar).toBeVisible();

        // The caret label keeps its original session colour.
        const [caretColor, labelColor] = await Promise.all([
          cursor.evaluate((element) => getComputedStyle(element).borderLeftColor),
          label.evaluate((element) => getComputedStyle(element).backgroundColor),
        ]);
        expect(labelColor).toBe(caretColor);

        // A departure is visibly different without hover, including on a tablet.
        // The full-strength initial retains the rendered text contrast floor.
        await page.mouse.move(0, 0);
        const paint = await avatar.evaluate((circle) => {
          const style = getComputedStyle(circle);
          let opacity = 1;
          for (let node: Element | null = circle; node !== null; node = node.parentElement) {
            opacity *= Number(getComputedStyle(node).opacity);
          }
          const button = circle.closest("button");
          if (button === null) throw new Error("e2e: an avatar has no labelled control");
          return {
            borderStyle: style.borderLeftStyle,
            ink: style.color,
            ground: getComputedStyle(button).backgroundColor,
            opacity,
          };
        });
        expect(paint.borderStyle).toBe("dashed");
        expect(paint.opacity).toBe(1);
        expect(contrast(paint.ink, paint.ground)).toBeGreaterThanOrEqual(4.5);

        // Presentation retains the departure; connection facts read real awareness.
        await expect(facts.locator("[data-settings-facts] > div", { hasText: "MCP connections" })).toContainText("0");
        await openSidebar();
        if (settings.touch) {
          await activate(page.getByRole("button", { name: "Close document list", exact: true }));
        }
        await activate(page.locator(".ub-sync-toggle"));
        const presence = page.getByRole("dialog", { name: "Sync and presence" });
        await expect(presence).toContainText("Nobody else is in this room.");
        await expect(presence.getByText(session.name, { exact: true })).toHaveCount(0);
        await activate(page.locator(".ub-sync-toggle"));
        await expect(label).toBeVisible();
        await expect(avatar).toBeVisible();

        // Run every intermediate callback, including provider heartbeats: a
        // reconnect cannot stand in for the presentation expiring on its own.
        await page.clock.runFor(READABLE_MS - 1);
        await expect(label).toHaveText(session.name);
        await expect(label).toBeVisible();
        await expect(avatar).toBeVisible();
        await page.clock.runFor(AGENT_CURSOR_GRACE_MS - READABLE_MS - 1);
        await expect(label).toBeVisible();
        await expect(avatar).toBeVisible();
        // Expiry queues the same decoration refresh: cross the deadline and
        // drain its next event-loop turn as well.
        await page.clock.runFor(2);
        await expect(cursor).toHaveCount(0);
        await expect(peer).toHaveCount(0);
        expect(socketCloses).toBe(0);
      }

      if (!settings.touch) {
        await writeAndLeave({ name: "Codex" }, uuid, "a retained departure that must not survive navigation");
        await expect(peer).toHaveAccessibleName(/^Codex · agent.* · left$/);
        await page.clock.runFor(1);
        await expect(label).toHaveText("Codex");
        await expect(avatar).toBeVisible();
        // Navigate inside the mounted app; reopening before expiry must not
        // resurrect a departure from the room's earlier visit.
        await page.getByRole("button", { name: "All documents", exact: true }).click();
        await expect(page.locator(".ub-docs")).toBeVisible();
        await expect(cursor).toHaveCount(0);
        await expect(peer).toHaveCount(0);
        await openDoc(page, title);
        await expect(cursor).toHaveCount(0);
        await expect(peer).toHaveCount(0);
        expect(socketCloses).toBe(0);
      }
    } finally { await facts.close(); }
  });

  test(`reconnected agent sessions keep one title avatar and their latest departed caret — ${settings.name}`, async ({ browser }) => {
    const page = await openApp(browser, "/", {
      readySelector: ".ub-pane",
      contextOptions: {
        colorScheme: settings.colorScheme,
        hasTouch: settings.touch,
        viewport: settings.viewport,
      },
      beforeNavigate: async (loading) => {
        await loading.clock.install();
      },
    });
    if (settings.touch) {
      await page.getByRole("button", { name: "Show document list", exact: true }).tap();
    }
    const uuid = await createDoc(page, docTitle("session-attribution"));
    await placeCaret(page);
    await page.keyboard.type("session attribution", { delay: 15 });
    await page.clock.pauseAt(new Date(Date.now() + 1_000));

    const peers = page.locator(".ub-peers > .ub-peer-control[data-peer-id]");
    const cursor = page.locator(".ub-editor .ProseMirror-yjs-cursor");
    const firstId = "reconnect-run";
    const otherId = "separate-run";
    const firstPeer = peers.and(page.getByRole("button", {
      name: /^Codex · agent · reconnect-run(?: ·|$)/,
    }));
    const first = agent().open({ name: "Codex" }, firstId);
    expect(await first.call<{ session: string }>("sync_status", {})).toMatchObject({ session: firstId });
    await writeBlock(first, uuid, "first connection");
    await expect(firstPeer).toHaveCount(1);
    await page.clock.runFor(1);
    await expect(cursor).toHaveCount(1);

    // The same display name remains a different session, with its own caret.
    const other = agent().open({ name: "Codex" }, otherId);
    await writeBlock(other, uuid, "a different same-named session");
    await expect(peers).toHaveCount(2);
    await page.clock.runFor(1);
    await expect(cursor).toHaveCount(2);
    const originalOrder = await peers.evaluateAll((controls) => controls.map((control) => control.getAttribute("data-peer-id")));
    await firstPeer.evaluate((control: HTMLElement) => { control.dataset.reconnectProbe = "original-control"; });
    await firstPeer.focus();
    await expect(firstPeer).toBeFocused();
    await first.close();
    await expect(firstPeer).toHaveAccessibleName("Codex · agent · reconnect-run · left");
    await page.clock.runFor(1);
    await expect(cursor).toHaveCount(2);
    await page.clock.runFor(10_000);

    // Reading republishes presence without a caret, so the previous departure
    // remains visible while the session's one avatar becomes live again.
    const reconnect = agent().open({ name: "Codex" }, firstId);
    await reconnect.call("get_doc", { uuid });
    await expect(firstPeer).toHaveAccessibleName("Codex · agent · reconnect-run");
    await expect(firstPeer.locator(".ub-avatar-departed")).toHaveCount(0);
    await expect(peers).toHaveCount(2);
    await expect(firstPeer).toHaveAttribute("data-reconnect-probe", "original-control");
    await expect(firstPeer).toBeFocused();
    await expect.poll(() => peers.evaluateAll((controls) => controls.map((control) => control.getAttribute("data-peer-id")))).toEqual(originalOrder);
    await page.clock.runFor(1);
    await expect(cursor).toHaveCount(2);

    await writeBlock(reconnect, uuid, "newer connection replaces the departed caret");
    await expect(firstPeer).toHaveAccessibleName("Codex · agent · reconnect-run · editing block 1");
    await page.clock.runFor(1);
    await expect(cursor).toHaveCount(2);

    // Concurrent connections keep separate live carets under their one avatar.
    const concurrent = agent().open({ name: "Codex" }, firstId);
    await writeBlock(concurrent, uuid, "two live connections in one session");
    await expect(peers).toHaveCount(2);
    await expect.poll(async () => {
      await page.clock.runFor(1);
      return cursor.count();
    }).toBe(3);
    await reconnect.close();
    // A grouped avatar stays live, so its unchanged label cannot signal that
    // the close reached awareness. Drain cursor work until that change arrives.
    await expect.poll(async () => {
      await page.clock.runFor(1);
      return cursor.count();
    }).toBe(2);
    await expect(firstPeer).not.toHaveAccessibleName(/left$/);
    await concurrent.close();
    await expect(firstPeer).toHaveAccessibleName("Codex · agent · reconnect-run · left");
    await expect(firstPeer.locator(".ub-avatar-departed")).toBeVisible();
    await other.close();
    await expect(peers).toHaveCount(2);
    await expect(peers.and(page.getByRole("button", {
      name: "Codex · agent · separate-run · left", exact: true,
    }))).toHaveCount(1);
    await page.clock.runFor(1);
    await expect(cursor).toHaveCount(2);

    // Expiry follows the latest departure, beyond the first connection's
    // original deadline, and both same-named sessions remain independently drawn.
    await page.clock.runFor(AGENT_CURSOR_GRACE_MS - 2);
    await expect(cursor).toHaveCount(2);
    await expect(peers).toHaveCount(2);
    await page.clock.runFor(2);
    await expect(cursor).toHaveCount(0);
    await expect(peers).toHaveCount(0);
  });
}
