/**
 * Status geometry beside Contents, with the real capped collaborator cluster.
 *
 * The word fixtures below change only rendered readings, keeping the production
 * slots and marks. They exercise every label without manufacturing transport
 * failures; status-line and serving-status unit tests own state selection.
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createDoc, editor, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";
import { AUTH_REJECTED } from "@uberblick/hub/protocol";
import { STORE_REFUSED, TOKEN_MISSING } from "../src/ui/status-reading.js";

const { harness, openApp } = setupHarness();
const drawerWidths = [375, 390, 430, 744, 932, 1279];
const directReadings = [
  "", "synced", "syncing…", "offline", "update required", "no hub token",
  "not authorized", "edit refused",
];
const localReadings = ["", "saved here", "saving here…", "offline"];
const hubReadings = ["", "synced with hub", "not synced with hub", "not shared with hub"];
const hubReasons = [
  "this machine has no credentials for its hub",
  "sign-in required — run ub auth login for this hub on this machine",
  "no access to this workspace — ask its administrator for membership; this machine will retry with its existing login",
  "this machine cannot read its login — run ub auth status and follow its credential-store recovery",
  "this hub cannot renew the login — ask its operator to configure sign-in",
];
const additionalReadings = [
  { word: "offline", saved: "not saved", detail: null, pending: null },
  { word: "offline", saved: "not saved", detail: null, pending: "1 sync message unacked" },
  { word: "syncing…", saved: null, detail: null, pending: "1 sync message unacked" },
  { word: "update required", saved: null, detail: "this app is older than the hub — update it and reload (app 1, hub 2); this document is not saved", pending: null },
  { word: "no hub token", saved: null, detail: TOKEN_MISSING, pending: null },
  { word: "not authorized", saved: null, detail: `${AUTH_REJECTED}; this document is not saved`, pending: null },
  { word: "edit refused", saved: null, detail: STORE_REFUSED, pending: null },
];

async function settlePane(page: Page): Promise<void> {
  await page.locator(".ub-document-pane").evaluate(async (pane) => {
    // Read style to instantiate the resize transition, then wait for that
    // finite pane animation. Spinner and caret animations are unrelated.
    getComputedStyle(pane).paddingInlineStart;
    await Promise.all(pane.getAnimations().map((animation) => animation.finished));
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
    const notes = [...status.querySelectorAll(".ub-not-saved, .ub-pending, .ub-status-reason, [data-status-layout-detail]")].map((note) => ({ text: note.textContent, rect: box(note) }));
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
  const reason = page.locator(".ub-status-reason");
  const original = await primary.textContent();
  const originalHub = upstream ? null : await hub.textContent();
  const originalReason = upstream ? null : await reason.evaluate((node) => ({
    text: node.textContent,
    className: node.getAttribute("class") ?? "",
    ariaHidden: node.getAttribute("aria-hidden"),
  }));
  const positions: Array<{ status: Awaited<ReturnType<typeof statusGeometry>>["status"]; prose: Awaited<ReturnType<typeof statusGeometry>>["prose"] }> = [];
  try {
    for (const reading of upstream ? directReadings : localReadings) {
      await primary.evaluate((word, text) => { word.textContent = text; }, reading);
      for (const hubReading of upstream ? [""] : hubReadings) {
        if (!upstream) {
          await hub.evaluate((word, text) => { word.textContent = text; }, hubReading);
        }
        for (const hubReason of hubReading === "not shared with hub" ? hubReasons : [null]) {
          if (originalReason !== null) {
            // Reuse the production reason line, including its reserved invisible
            // reading when no cause is shown; only replace its rendered ink.
            await reason.evaluate((node, fixture) => {
              node.textContent = fixture.detail ?? fixture.reserved;
              node.classList.toggle("invisible", fixture.detail === null);
              node.setAttribute("aria-hidden", String(fixture.detail === null));
            }, { detail: hubReason, reserved: originalReason.text });
          }
          const geometry = await statusGeometry(page);
          const label = `${page.viewportSize()?.width}px: ${reading} / ${hubReading} / ${hubReason ?? ""}`;
          expect(geometry.scrollWidth, label).toBe(geometry.clientWidth);
          expect(geometry.problems, label).toEqual([]);
          positions.push({ status: geometry.status, prose: geometry.prose });
        }
      }
    }
  } finally {
    await primary.evaluate((word, text) => { word.textContent = text; }, original);
    if (!upstream) {
      await hub.evaluate((word, text) => { word.textContent = text; }, originalHub);
    }
    if (originalReason !== null) {
      await reason.evaluate((node, saved) => {
        node.textContent = saved.text;
        node.setAttribute("class", saved.className);
        if (saved.ariaHidden === null) node.removeAttribute("aria-hidden");
        else node.setAttribute("aria-hidden", saved.ariaHidden);
      }, originalReason);
    }
  }
  return positions;
}

/**
 * Match StatusLine's supplementary line: pending and not-saved wrap below the
 * readings; a refusal has one fact plus its cause and suppresses presence.
 * This is a layout fixture, never evidence for transport or state selection.
 */
async function checkAdditionalReadings(page: Page, upstream: boolean) {
  const positions: Array<{ status: Awaited<ReturnType<typeof statusGeometry>>["status"]; prose: Awaited<ReturnType<typeof statusGeometry>>["prose"] }> = [];
  for (const fixture of additionalReadings) {
    await page.evaluate(({ reading, direct }) => {
      const sync = document.querySelector<HTMLElement>(".ub-sync-toggle");
      const primary = sync?.querySelector<HTMLElement>(".ub-status-word");
      const row = sync?.parentElement;
      const status = sync?.closest(".ub-status");
      if (sync === null || sync === undefined || primary === null || primary === undefined || row === null || row === undefined || status === null || status === undefined) throw new Error("e2e: missing status fixture row");
      const originals = [...row.childNodes];
      const statusNodes = [...status.childNodes];
      const factNodes = [...sync.childNodes];
      const primaryClass = primary.className;
      const primaryText = primary.textContent;
      const hubWord = sync.querySelector(".ub-status-word--hub");
      const hubText = hubWord?.textContent ?? null;
      const restore = () => {
        primary.className = primaryClass;
        primary.textContent = primaryText;
        if (hubWord !== null) hubWord.textContent = hubText;
        sync.replaceChildren(...factNodes);
        row.replaceChildren(...originals);
        status.replaceChildren(...statusNodes);
      };
      // Store only a synchronous cleanup callback on the page for the next
      // evaluation; no production state or transport is overridden.
      (window as unknown as { restoreStatusLayout?: () => void }).restoreStatusLayout = restore;
      const notes = document.createElement("div");
      notes.className = "ub-status-notes flex min-w-0 flex-wrap items-center gap-2 mt-2";
      const add = (text: string | null, className: string, detail = false) => {
        if (text === null) return;
        const note = document.createElement("span");
        note.className = className;
        note.textContent = text;
        if (detail) note.dataset.statusLayoutDetail = "";
        if (detail) row.insertBefore(note, row.querySelector(".ub-last-updated"));
        else notes.appendChild(note);
      };
      if (reading.word === "syncing…" && !direct) {
        primary.textContent = "saving here…";
        if (hubWord !== null) hubWord.textContent = "not synced with hub";
      } else {
        primary.classList.remove("ub-status-word--saved");
        primary.textContent = reading.word;
        if (factNodes[1] !== undefined) factNodes[1].remove();
      }
      if (reading.detail !== null) row.querySelector(".ub-peers")?.remove();
      add(reading.saved, "ub-muted ub-not-saved");
      add(reading.detail, "ub-muted", true);
      if (reading.pending !== null) {
        const pending = document.createElement("span");
        pending.className = "ub-pending rounded-(--radius-sm) bg-(--status-warning-subtle) text-(--foreground) px-[0.3rem]";
        pending.textContent = reading.pending;
        notes.appendChild(pending);
      }
      if (notes.childNodes.length > 0) status.insertBefore(notes, row.nextSibling);
    }, { reading: fixture, direct: upstream });
    try {
      const geometry = await statusGeometry(page);
      const label = `${page.viewportSize()?.width}px: ${fixture.word} / ${fixture.pending ?? fixture.detail ?? fixture.saved}`;
      expect(geometry.scrollWidth, label).toBe(geometry.clientWidth);
      expect(geometry.problems, label).toEqual([]);
      positions.push({ status: geometry.status, prose: geometry.prose });
    } finally {
      await page.evaluate(() => {
        const fixtureWindow = window as unknown as { restoreStatusLayout?: () => void };
        fixtureWindow.restoreStatusLayout?.();
        delete fixtureWindow.restoreStatusLayout;
      });
    }
  }
  return positions;
}

for (const upstream of [true, false]) {
  test(`Contents leaves every status reading contained and presence stable — ${upstream ? "hub direct" : "ub open"} @webkit`, async ({
    browser, browserName, contextOptions, viewport, hasTouch, isMobile,
    deviceScaleFactor, userAgent,
  }) => {
    // openApp owns fresh contexts; pass the project's device/input explicitly.
    const device = {
      ...contextOptions, viewport, hasTouch, isMobile,
      ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
      ...(userAgent === undefined ? {} : { userAgent }),
    };
    const page = await openApp(browser, "/", { upstream, contextOptions: device });
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

    const widths = browserName === "chromium" ? drawerWidths : [page.viewportSize()?.width ?? 1280];
    const height = page.viewportSize()?.height ?? 800;
    const empty = new Map<number, Awaited<ReturnType<typeof statusGeometry>>>();
    const emptyReadings = new Map<number, Awaited<ReturnType<typeof checkReadings>>>();
    const emptyAdditional = new Map<number, Awaited<ReturnType<typeof checkAdditionalReadings>>>();
    for (const width of widths) {
      if (browserName === "chromium") await page.setViewportSize({ width, height });
      await settlePane(page);
      await expect(page.getByRole("button", { name: "Contents 1" })).toBeVisible();
      empty.set(width, await statusGeometry(page));
      emptyReadings.set(width, await checkReadings(page, upstream));
      emptyAdditional.set(width, await checkAdditionalReadings(page, upstream));
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
        expect(await checkAdditionalReadings(page, upstream), `supplementary readings moved after joining at ${width}px`).toEqual(emptyAdditional.get(width));
        const full = await statusGeometry(page);
        expect(full.status, `status moved after joining at ${width}px`).toEqual(empty.get(width)?.status);
        expect(full.prose, `prose moved after joining at ${width}px`).toEqual(empty.get(width)?.prose);
        expect(full.overlaps).toHaveLength(2);
        for (const circle of full.overlaps) {
          expect(circle.overlap, "circles retain their slight intentional overlap").toBeGreaterThan(0);
          expect(circle.overlap).toBeLessThan(circle.width / 2);
        }
      }
    } finally {
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
      expect(await checkAdditionalReadings(page, upstream), `supplementary readings moved after leaving at ${width}px`).toEqual(emptyAdditional.get(width));
    }
    if (upstream) {
      // Exercise production note placement too: the label fixtures above own
      // geometry, but must not substitute for rendering a real not-saved note.
      await harness().stopHub();
      try {
        await expect(page.locator(".ub-status-word").first()).toHaveText("offline");
        await expect(page.locator(".ub-not-saved")).toHaveText("not saved");
        for (const width of widths) {
          if (browserName === "chromium") await page.setViewportSize({ width, height });
          await settlePane(page);
          const offline = await statusGeometry(page);
          expect(offline.scrollWidth, `offline at ${width}px`).toBe(offline.clientWidth);
          expect(offline.problems, `offline at ${width}px`).toEqual([]);
        }
      } finally {
        await harness().startHub();
      }
    }
  });
}
