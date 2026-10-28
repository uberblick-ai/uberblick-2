/** Everyday document targets retain native actions on desktop and iPad. */
import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import { wrapToken } from "@uberblick/schema/protocol";
import { createTagCatalogEntry, seedTagCatalog, settingsRoom } from "@uberblick/schema";
import { devices, expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import * as Y from "yjs";
import { createDoc, setupHarness } from "./app-helpers.js";

const { harness, openApp } = setupHarness();
let catalog: { doc: Y.Doc; provider: HocuspocusProvider } | null = null;

test.beforeAll(async () => {
  const doc = new Y.Doc();
  const secret = await importRootSecret(harness().authSecret);
  const provider = new HocuspocusProvider({
    url: harness().hubUrl,
    name: settingsRoom(harness().workspaceUuid),
    document: doc,
    token: async () => wrapToken(await mintToken(secret, {
      typ: "room", sub: "document-target-proof", workspace: harness().workspaceUuid,
      scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    })),
  });
  catalog = { doc, provider };
  await new Promise<void>((resolve) => provider.on("synced", resolve));
  seedTagCatalog(doc);
  // The five normal examples plus five authored entries earn the search field.
  for (let index = 0; index < 5; index += 1) createTagCatalogEntry(doc, `floor-${index}`);
});

test.afterAll(() => {
  catalog?.provider.destroy();
  catalog?.doc.destroy();
  catalog = null;
});

async function expectFloor(control: Locator, floor: number): Promise<void> {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box?.width, `${await control.getAttribute("aria-label") ?? await control.textContent()} width`).toBeGreaterThanOrEqual(floor);
  expect(box?.height, `${await control.getAttribute("aria-label") ?? await control.textContent()} height`).toBeGreaterThanOrEqual(floor);
}

async function activate(control: Locator, touch: boolean): Promise<void> {
  if (touch) await control.tap();
  else {
    await control.focus();
    await control.press("Enter");
  }
}

async function showSidebar(page: Page, touch: boolean): Promise<void> {
  const show = page.getByRole("button", { name: "Show document list", exact: true });
  if (await show.isVisible()) await activate(show, touch);
  await expect(page.locator(".ub-document-sidebar")).toBeVisible();
}

async function syncDetails(page: Page, touch: boolean): Promise<void> {
  const trigger = page.locator(".ub-status-sync");
  await expectFloor(trigger, touch ? 44 : 24);
  await activate(trigger, touch);
  await expect(page.getByRole("dialog", { name: "Sync details", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Sync details", exact: true })).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

async function exerciseDocumentControls(browser: Browser, touch: boolean): Promise<void> {
  const floor = touch ? 44 : 24;
  const page = await openApp(browser, `/${harness().workspace}/${randomUUID()}`, {
    contextOptions: touch ? devices["iPad Pro 11"] : {
      hasTouch: false, isMobile: false, viewport: { width: 1280, height: 900 },
    },
    beforeNavigate: (target) => target.emulateMedia({ reducedMotion: "reduce" }),
  });
  // Assert the pointer mode itself; a viewport or hasTouch flag alone is insufficient.
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(touch);
  expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(touch);
  await expect(page.locator(".ub-waiting-meta")).toBeVisible();
  await syncDetails(page, touch);

  await page.goto(harness().appUrl);
  await showSidebar(page, touch);
  const prefix = touch ? "Target iPad" : "Target desktop";
  await createDoc(page, `${prefix} Z`);
  await syncDetails(page, touch);

  const picker = page.getByRole("button", { name: "Edit tags", exact: true });
  await expectFloor(picker, floor);
  await expectFloor(page.getByRole("button", { name: "Document actions", exact: true }), floor);
  const chrome = await page.evaluate(() => ({
    statusRow: document.querySelector(".ub-status > div")?.getBoundingClientRect().height,
    metadataRow: document.querySelector(".ub-doc-meta")?.getBoundingClientRect().height,
  }));
  if (!touch) {
    expect(chrome.statusRow, "compact desktop status row").toBe(28);
    expect(chrome.metadataRow, "reserved desktop metadata row").toBe(44);
  }
  const titleBefore = await page.locator(".ub-title").boundingBox();
  await activate(picker, touch);
  const search = page.getByRole("searchbox", { name: "Search tags", exact: true });
  await expect(search).toBeFocused();
  await expectFloor(search, floor);
  if (touch) {
    expect(await search.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  }
  await search.fill("floor-0");
  const tag = page.getByRole("option", { name: "floor-0", exact: true });
  await search.press("ArrowDown");
  await expect(tag).toBeFocused();
  if (touch) await tag.tap();
  else await tag.press("Space");
  await expect(tag).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(picker).toBeFocused();
  await expect(picker).toContainText("floor-0");
  expect(await page.locator(".ub-title").boundingBox()).toEqual(titleBefore);
}

test("document controls retain desktop target floors and keyboard behavior", { tag: "@webkit" }, async ({ browser }, info) => {
  test.skip(info.project.name === "webkit-ipad", "The paired explicit iPad context owns touch coverage.");
  await exerciseDocumentControls(browser, false);
});

test("document controls retain iPad target floors and tap behavior", { tag: "@webkit-touch" }, async ({ browser }) => {
  await exerciseDocumentControls(browser, true);
});
