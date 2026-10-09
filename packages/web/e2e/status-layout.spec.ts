/**
 * Status geometry beside Contents, with the real capped collaborator cluster.
 *
 * The word fixtures below change only rendered readings, keeping the production
 * slots and marks. They exercise every label without manufacturing transport
 * failures; status-line and serving-status unit tests own state selection.
 * Real delayed acknowledgements and hub loss prove status transitions preserve
 * the status rule and the prose, including beside the desktop threads rail.
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createDoc, editor, setupHarness } from "./app-helpers.js";
import { keys, placeCaret } from "./harness.js";

const { harness, openApp } = setupHarness();
const layoutWidths = [375, 390, 430, 744, 932, 1279, 1280, 1440];
const directReadings = [
  "", "synced", "syncing…", "offline", "update required", "no hub token",
  "not authorized", "edit refused",
];
const localReadings = ["", "saved here", "saving here…", "offline"];
const hubReadings = ["", "synced with hub", "not synced with hub", "not shared with hub"];

async function expectCompactHeader(page: Page): Promise<void> {
  await expect(page.locator(".ub-status-notes, .ub-status-reason, .ub-status .ub-pending")).toHaveCount(0);
  expect(Math.abs(await page.locator(".ub-status").evaluate((status) => {
    const row = status.firstElementChild;
    if (row === null) throw new Error("e2e: missing compact status row");
    const style = getComputedStyle(status);
    return status.getBoundingClientRect().height - row.getBoundingClientRect().height -
      Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom) -
      Number.parseFloat(style.borderTopWidth) - Number.parseFloat(style.borderBottomWidth);
  })), "the status rule follows only the compact row and its padding").toBeLessThan(0.5);
}

async function expectBacklog(page: Page, pending: boolean): Promise<void> {
  const trigger = page.getByRole("button", { name: /^Sync details/ });
  await trigger.click();
  const backlog = page.locator(".ub-sync-fact").filter({ has: page.locator("dt", { hasText: /^Backlog$/ }) }).locator("dd");
  await expect(backlog).toHaveText(pending ? /^[1-9]\d* sync messages? unacked$/ : "0 sync messages unacked");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Sync and presence", exact: true })).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

async function settlePane(page: Page): Promise<void> {
  await page.locator(".ub-document-pane").evaluate(async (pane) => {
    // Read style to instantiate the resize transition, then wait for that
    // finite pane animation. Crossing xl can cancel and replace a transition;
    // wait for the replacement too. Spinner and caret animations are unrelated.
    while (true) {
      getComputedStyle(pane).paddingInlineStart;
      const animations = pane.getAnimations().filter((animation) =>
        animation.playState === "running" || animation.pending,
      );
      if (animations.length === 0) return;
      await Promise.allSettled(animations.map((animation) => animation.finished));
    }
  });
}

async function statusGeometry(page: Page) {
  return page.evaluate(() => {
    const find = (selector: string): HTMLElement => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) throw new Error(`e2e: missing ${selector}`);
      return node;
    };
    const box = (node: Element) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    const intersects = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
      a.left < b.right - 0.5 && a.right > b.left + 0.5 &&
      a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
    const pane = find(".ub-document-pane");
    const status = find(".ub-status");
    const paneBox = box(pane);
    const peerCluster = status.querySelector(".ub-peers");
    const cluster = peerCluster === null ? null : box(peerCluster);
    const updated = box(find(".ub-last-updated"));
    const notes = [...status.querySelectorAll(".ub-not-saved")]
      .filter((note) => note.getClientRects().length > 0)
      .map((note) => ({ text: note.textContent, rect: box(note) }));
    const facts = [...status.querySelectorAll(".ub-status-word")].map((word) => {
      const range = document.createRange();
      range.selectNodeContents(word);
      return {
        word: word.textContent,
        slot: box(word),
        ink: [...range.getClientRects()].map((rect) => ({
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        })),
      };
    });
    const problems: string[] = [];
    for (const fact of facts) {
      for (const ink of fact.ink) {
        if (ink.left < fact.slot.left - 0.5 || ink.right > fact.slot.right + 0.5) {
          problems.push(`${fact.word}: escapes its reserved slot`);
        }
        if (ink.left < paneBox.left - 0.5 || ink.right > paneBox.right + 0.5) {
          problems.push(`${fact.word}: escapes the document pane`);
        }
        if (cluster !== null && intersects(ink, cluster)) problems.push(`${fact.word}: collides with presence`);
        if (intersects(ink, updated)) problems.push(`${fact.word}: collides with last edit`);
        for (const note of notes) {
          if (intersects(ink, note.rect)) problems.push(`${fact.word}: collides with ${note.text}`);
        }
        for (const other of facts) {
          if (other === fact) continue;
          if (other.ink.some((rect) => intersects(ink, rect))) {
            problems.push(`${fact.word}: collides with ${other.word}`);
          }
        }
      }
    }
    // The last-edit text deliberately truncates; measure its clipping box.
    if (cluster !== null && intersects(updated, cluster)) problems.push("last edit: collides with presence");
    if (cluster !== null && (cluster.left < paneBox.left - 0.5 || cluster.right > paneBox.right + 0.5)) {
      problems.push("presence: escapes the document pane");
    }
    for (const note of notes) {
      if (note.rect.left < paneBox.left - 0.5 || note.rect.right > paneBox.right + 0.5) problems.push(`${note.text}: escapes the pane`);
      if (intersects(note.rect, updated)) problems.push(`${note.text}: collides with last edit`);
      if (cluster !== null && intersects(note.rect, cluster)) problems.push(`${note.text}: collides with presence`);
    }
    const circles = [...status.querySelectorAll(".ub-peers [data-peer-id] .ub-avatar")].map(box);
    const overlaps = circles.slice(1).map((circle, index) => {
      const previous = circles[index];
      if (previous === undefined) throw new Error("e2e: missing preceding circle");
      return {
        overlap: previous.right - circle.left,
        width: circle.right - circle.left,
      };
    });
    return {
      problems,
      clientWidth: pane.clientWidth,
      scrollWidth: pane.scrollWidth,
      status: box(status),
      prose: box(find(".ub-editor")),
      overlaps,
    };
  });
}

/** Exercise layout states, not the transport that selects their wording. */
async function checkReadings(page: Page, upstream: boolean) {
  const primary = page.locator(".ub-status-word").first();
  const hub = page.locator(".ub-status-word--hub");
  const original = await primary.textContent();
  const originalHub = upstream ? null : await hub.textContent();
  const positions: Array<{ status: Awaited<ReturnType<typeof statusGeometry>>["status"]; prose: Awaited<ReturnType<typeof statusGeometry>>["prose"] }> = [];
  try {
    for (const reading of upstream ? directReadings : localReadings) {
      await primary.evaluate((word, text) => { word.textContent = text; }, reading);
      for (const hubReading of upstream ? [""] : hubReadings) {
        if (!upstream) {
          await hub.evaluate((word, text) => { word.textContent = text; }, hubReading);
        }
        const geometry = await statusGeometry(page);
        const label = `${page.viewportSize()?.width}px: ${reading} / ${hubReading}`;
        expect(geometry.scrollWidth, label).toBe(geometry.clientWidth);
        expect(geometry.problems, label).toEqual([]);
        positions.push({ status: geometry.status, prose: geometry.prose });
      }
    }
  } finally {
    await primary.evaluate((word, text) => { word.textContent = text; }, original);
    if (!upstream) {
      await hub.evaluate((word, text) => { word.textContent = text; }, originalHub);
    }
  }
  return positions;
}

for (const upstream of [true, false]) {
  test(`Contents leaves every status reading contained and presence stable — ${upstream ? "hub direct" : "ub open"} @webkit`, async ({
    browser, browserName, contextOptions, viewport, hasTouch, isMobile,
    deviceScaleFactor, userAgent,
  }) => {
    test.setTimeout(90_000);
    // openApp owns fresh contexts; pass the project's device/input explicitly.
    const device = {
      ...contextOptions, viewport, hasTouch, isMobile,
      ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
      ...(userAgent === undefined ? {} : { userAgent }),
    };
    let holdReplies = false;
    const replies: Array<() => void> = [];
    const releaseReplies = () => {
      holdReplies = false;
      for (const send of replies.splice(0)) send();
    };
    const page = await openApp(browser, "/", {
      upstream,
      contextOptions: device,
      beforeNavigate: async (target) => {
        // Delay real server acknowledgements after hydration. Browser writes
        // still reach the serving boundary; no status or markup is replaced.
        await target.routeWebSocket("**", (socket) => {
          const server = socket.connectToServer();
          server.onMessage((message) => {
            if (holdReplies) replies.push(() => socket.send(message));
            else socket.send(message);
          });
        });
      },
    });
    if (await page.getByRole("button", { name: "Show document list", exact: true }).isVisible()) {
      await page.getByRole("button", { name: "Show document list", exact: true }).click();
    }
    await createDoc(page, "Status layout");
    await placeCaret(page);
    await page.keyboard.type("# Overview");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Document prose stays in place.");
    await page.locator(".ub-title").focus();
    await expect(page.getByRole("button", { name: "Contents 1" })).toBeVisible();
    await expect(editor(page).locator("h1")).toHaveText("Overview");
    await expect(page.locator(".ub-last-updated")).toHaveCount(1);
    await expect(page.locator(".ub-status-word").first()).toHaveText(upstream ? "synced" : "saved here");
    if (!upstream) await expect(page.locator(".ub-status-word--hub")).toHaveText("synced with hub");
    await expect(page.locator(".ub-peers [data-peer-id]")).toHaveCount(0);
    const waitingPath = new URL(page.url()).pathname.replace(/[^/]+$/, randomUUID());
    const calmWaiting = await openApp(browser, waitingPath, { upstream, contextOptions: device });
    try {
      await expect(calmWaiting.locator(".ub-waiting-meta")).toBeVisible();
      await expect(calmWaiting.locator(".ub-status-word").first()).toHaveText(upstream ? "synced" : "saved here");
      await expectCompactHeader(calmWaiting);
      await expect(calmWaiting.locator("[data-sonner-toast]")).toHaveCount(0);
    } finally {
      await calmWaiting.context().close();
    }

    const widths = browserName === "chromium" ? layoutWidths : [page.viewportSize()?.width ?? 1280];
    const height = page.viewportSize()?.height ?? 800;
    const empty = new Map<number, Awaited<ReturnType<typeof statusGeometry>>>();
    const emptyReadings = new Map<number, Awaited<ReturnType<typeof checkReadings>>>();
    const queueUpdate = async () => {
      // Peer contexts and the waiting-screen proof have opened other tabs.
      // Restore this tab before using the browser's native caret keys.
      await page.bringToFront();
      // placeCaret proves the first block's edge. Desktop retains the old
      // paragraph selection, so move to the document start before using it.
      if (browserName === "chromium") {
        await editor(page).focus();
        await page.keyboard.press(keys.documentStart);
      }
      await placeCaret(page);
      // Real whitespace update, without another rendered prose line.
      await page.keyboard.type(" ");
      await page.locator(".ub-title").focus();
      await expect(page.locator(".ub-status-word").first()).toHaveText(upstream ? "syncing…" : "saving here…");
      await expectBacklog(page, true);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    };
    const expectStable = async (state: string) => {
      for (const width of widths) {
        if (browserName === "chromium") await page.setViewportSize({ width, height });
        await settlePane(page);
        const geometry = await statusGeometry(page);
        const label = `${state} at ${width}px`;
        await expectCompactHeader(page);
        expect(geometry.scrollWidth, label).toBe(geometry.clientWidth);
        expect(geometry.problems, label).toEqual([]);
        expect(geometry.status, `${label}: status moved`).toEqual(empty.get(width)?.status);
        expect(geometry.prose, `${label}: prose moved`).toEqual(empty.get(width)?.prose);
      }
    };
    for (const width of widths) {
      if (browserName === "chromium") await page.setViewportSize({ width, height });
      await settlePane(page);
      await expect(page.getByRole("button", { name: "Contents 1" })).toBeVisible();
      await expectCompactHeader(page);
      empty.set(width, await statusGeometry(page));
      emptyReadings.set(width, await checkReadings(page, upstream));
    }

    const peers: Page[] = [];
    try {
      for (let index = 0; index < 4; index += 1) {
        peers.push(await openApp(browser, new URL(page.url()).pathname, {
          upstream: true,
          contextOptions: device,
          readySelector: ".ub-editor .ProseMirror",
        }));
      }
      await expect(page.locator(".ub-peers [data-peer-id]")).toHaveCount(3);
      await expect(page.locator(".ub-peer-more")).toHaveText("+1");

      for (const width of widths) {
        if (browserName === "chromium") await page.setViewportSize({ width, height });
        await settlePane(page);
        expect(await checkReadings(page, upstream), `readings moved after joining at ${width}px`).toEqual(emptyReadings.get(width));
        const full = await statusGeometry(page);
        expect(full.status, `status moved after joining at ${width}px`).toEqual(empty.get(width)?.status);
        expect(full.prose, `prose moved after joining at ${width}px`).toEqual(empty.get(width)?.prose);
        expect(full.overlaps).toHaveLength(2);
        for (const circle of full.overlaps) {
          expect(circle.overlap, "circles retain their slight intentional overlap").toBeGreaterThan(0);
          expect(circle.overlap).toBeLessThan(circle.width / 2);
        }
      }
      await expectBacklog(page, false);
      holdReplies = true;
      try {
        await queueUpdate();
        await expect.poll(() => replies.length).toBeGreaterThan(0);
        await expectStable("real unacknowledged update");
      } finally {
        releaseReplies();
      }
      await expect(page.locator(".ub-status-word").first()).toHaveText(upstream ? "synced" : "saved here");
      await expectBacklog(page, false);
      await expectStable("acknowledged update");
    } finally {
      releaseReplies();
      await Promise.all(peers.map((peer) => peer.context().close()));
    }
    await expect(page.locator(".ub-peers [data-peer-id]")).toHaveCount(0);
    await expect(page.locator(".ub-peer-more")).toHaveCount(0);
    for (const width of widths) {
      if (browserName === "chromium") await page.setViewportSize({ width, height });
      await settlePane(page);
      const left = await statusGeometry(page);
      expect(left.status, `status moved after leaving at ${width}px`).toEqual(empty.get(width)?.status);
      expect(left.prose, `prose moved after leaving at ${width}px`).toEqual(empty.get(width)?.prose);
      expect(await checkReadings(page, upstream), `readings moved after leaving at ${width}px`).toEqual(emptyReadings.get(width));
    }
    if (upstream) {
      await expect(page.locator(".ub-not-saved:visible")).toHaveCount(0);
      holdReplies = true;
      await queueUpdate();
      await expectStable("pending update before hub loss");
      await harness().stopHub();
      // The closed transport loses these delayed replies; a new connection
      // must obtain a real acknowledgement through its sync handshake.
      holdReplies = false;
      replies.splice(0);
      try {
        await expect(page.locator(".ub-status-word").first()).toHaveText("offline");
        await expect(page.locator(".ub-not-saved:visible")).toHaveText("not saved");
        await expect(page.locator("[data-sonner-toast][data-type=error]")).toContainText(/changes are not saved/i);
        await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);
        await expectBacklog(page, true);
        await expectStable("real offline / not saved / pending update");
        const waiting = await openApp(browser, new URL(page.url()).pathname, {
          upstream: true,
          contextOptions: device,
        });
        try {
          await expect(waiting.locator(".ub-waiting-meta")).toBeVisible();
          await expect(waiting.locator(".ub-status-word").first()).toHaveText("offline");
          await expect(waiting.locator(".ub-not-saved")).toHaveText("not saved");
          await expect(waiting.locator("[data-sonner-toast][data-type=error]")).toContainText(/changes are not saved/i);
          await expect(waiting.locator("[data-sonner-toast]")).toHaveCount(1);
          await expectCompactHeader(waiting);
          const waitingPeers = waiting.locator(".ub-waiting-meta .ub-peers");
          await expect(waitingPeers).toBeAttached();
          expect(await waitingPeers.evaluate((node) => node.getBoundingClientRect().width), "empty presence does not reserve a gap on the waiting screen").toBe(0);
        } finally {
          await waiting.context().close();
        }
      } finally {
        await harness().startHub();
      }
      await expect(page.locator(".ub-status-word").first()).toHaveText("synced", { timeout: 40_000 });
      await expect(page.locator(".ub-not-saved:visible")).toHaveCount(0);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      await expectBacklog(page, false);
      await expectStable("reconnected / saved");
    }
    if (browserName === "chromium" || (page.viewportSize()?.width ?? 0) >= 1280) {
      const paragraph = page.locator(".ub-editor .ub-paragraph").first();
      await paragraph.click();
      await paragraph.evaluate((node) => {
        const doc = node.ownerDocument;
        const range = doc.createRange();
        range.selectNodeContents(node);
        const selection = doc.getSelection();
        if (selection === null) throw new Error("e2e: paragraph selection is unavailable");
        selection.removeAllRanges();
        selection.addRange(range);
        doc.dispatchEvent(new Event("selectionchange"));
      });
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await page.getByPlaceholder(/Comment as/).fill("Status alongside the threads rail");
      await page.keyboard.press("Enter");
      await expect(page.locator("#ub-rail")).toBeVisible();
      if (browserName === "chromium") await page.setViewportSize({ width: 1280, height });
      await settlePane(page);
      await page.locator(".ub-title").focus();
      await expectBacklog(page, false);
      const baseline = await statusGeometry(page);
      holdReplies = true;
      try {
        await queueUpdate();
        const busy = await statusGeometry(page);
        expect(busy.scrollWidth, "threads rail / real backlog").toBe(busy.clientWidth);
        expect(busy.problems, "threads rail / real backlog").toEqual([]);
        expect(busy.status, "threads rail / real backlog").toEqual(baseline.status);
        expect(busy.prose, "threads rail / real backlog").toEqual(baseline.prose);
      } finally {
        releaseReplies();
      }
      await expect(page.locator(".ub-status-word").first()).toHaveText(upstream ? "synced" : "saved here");
      await expectBacklog(page, false);
      const recovered = await statusGeometry(page);
      expect(recovered.status, "threads rail / ack").toEqual(baseline.status);
      expect(recovered.prose, "threads rail / ack").toEqual(baseline.prose);
      if (upstream) {
        await harness().stopHub();
        try {
          await expect(page.locator(".ub-status-word").first()).toHaveText("offline");
          await expect(page.locator(".ub-not-saved")).toHaveText("not saved");
          await expect(page.locator("[data-sonner-toast][data-type=error]")).toContainText("Changes are not saved.");
          const offline = await statusGeometry(page);
          expect(offline.problems, "threads rail / not saved").toEqual([]);
          expect(offline.status, "threads rail / not saved").toEqual(baseline.status);
          expect(offline.prose, "threads rail / not saved").toEqual(baseline.prose);
        } finally {
          await harness().startHub();
        }
        await expect(page.locator(".ub-status-word").first()).toHaveText("synced", { timeout: 40_000 });
        await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
        const saved = await statusGeometry(page);
        expect(saved.status, "threads rail / reconnected").toEqual(baseline.status);
        expect(saved.prose, "threads rail / reconnected").toEqual(baseline.prose);
      }
    }
  });
}
