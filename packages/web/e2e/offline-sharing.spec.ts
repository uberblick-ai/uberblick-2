import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import * as Y from "yjs";
import { createDoc, docTitle, editor, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";
import { legacyDecisionPeer } from "./legacy-decision-peer.js";
import { installPageTimers } from "./page-timers.js";
import {
  expectOfflineHubText, expectUpstreamHub, proveDocumentPageArrival, waitForAcknowledged,
} from "./settle.js";

const { harness, openApp } = setupHarness({ app: { readySelector: ".ub-document-sidebar", beforeNavigate: installPageTimers } });

type CapturedUpdates = { stop: () => number[][] };

async function documentText(page: Page): Promise<string | null> {
  return editor(page).evaluate(element => {
    const copy = element.cloneNode(true) as HTMLElement;
    for (const cursor of copy.querySelectorAll(".ProseMirror-yjs-cursor")) cursor.remove();
    return copy.textContent;
  });
}

test("offline admission proof rejects premature sharing hidden by held observer delivery", async ({ browser }) => {
  const page = await openApp(browser);
  const uuid = await createDoc(page, docTitle("offline-admission"));
  const baseline = "before restart";
  const edited = `${baseline}; saved locally`;
  await placeCaret(page);
  await page.keyboard.insertText(baseline);
  await waitForAcknowledged(page, { path: "upstream" });

  let hold = false;
  const replies: (() => void)[] = [];
  const observer = await openApp(browser, new URL(page.url()).pathname, {
    upstream: true,
    beforeNavigate: async opening => {
      await installPageTimers(opening);
      await opening.routeWebSocket(/.*/, socket => {
        const server = socket.connectToServer();
        server.onMessage(message => {
          const forward = (): void => { socket.send(message); };
          if (hold) replies.push(forward);
          else forward();
        });
      });
    },
  });
  await expect.poll(() => documentText(observer)).toBe(baseline);
  const peer = await legacyDecisionPeer(harness(), uuid);
  const room = `${harness().workspaceUuid}/${uuid}`;
  const history = harness().observeHubText(room);
  try {
    await harness().restartOpen({ authenticated: false });
    await waitForAcknowledged(page, { path: "relay" });
    await expect(page.locator(".ub-status")).toHaveAttribute("data-upstream-sync", "offline");
    await placeCaret(page);
    await editor(page).evaluate(element => {
      type SharedDoc = {
        on(event: "update", listener: (update: Uint8Array, origin: unknown, doc: unknown, transaction: { local: boolean }) => void): void;
        off(event: "update", listener: (update: Uint8Array, origin: unknown, doc: unknown, transaction: { local: boolean }) => void): void;
      };
      type EditorState = { plugins: { key: string; getState(state: EditorState): { doc: SharedDoc } }[] };
      const root = element as HTMLElement & { editor: { state: EditorState } };
      const state = root.editor.state;
      const doc = state.plugins.find(plugin => plugin.key.startsWith("y-sync"))?.getState(state).doc;
      if (doc === undefined) throw new Error("e2e: local-update capture needs the mounted y-sync document");
      const updates: number[][] = [];
      const capture = (update: Uint8Array, _origin: unknown, _doc: unknown, transaction: { local: boolean }): void => {
        if (transaction.local) updates.push([...update]);
      };
      doc.on("update", capture);
      (window as unknown as { offlineUpdates: CapturedUpdates }).offlineUpdates = {
        stop: () => { doc.off("update", capture); return updates; },
      };
    });
    hold = true;
    await page.keyboard.insertText("; saved locally");
    await waitForAcknowledged(page, { path: "relay" });
    const updates = await page.evaluate(() => (window as unknown as { offlineUpdates: CapturedUpdates }).offlineUpdates.stop());
    expect(updates.length).toBeGreaterThan(0);

    // Replay the actor's exact CRDT identities to model erroneous forwarding.
    // Legitimate authenticated catch-up will then be an idempotent replay.
    for (const update of updates) Y.applyUpdate(peer.doc, Uint8Array.from(update));
    await expectUpstreamHub(() => { expect(harness().hubText(room)).toBe(edited); });
    await expect.poll(() => replies.length).toBeGreaterThan(0);
    await expect(page.locator(".ub-status")).toHaveAttribute("data-upstream-sync", "offline");

    await harness().restartOpen({ authenticated: true });
    hold = false;
    for (const forward of replies.splice(0)) forward();
    await expect.poll(() => documentText(observer)).toBe(edited);
    await proveDocumentPageArrival(page, observer, { path: "upstream" });
    expect(() => expectOfflineHubText(history, baseline)).toThrow(/local-only edits reached the upstream hub/);
  } finally {
    history.stop();
    peer.close();
  }
});
