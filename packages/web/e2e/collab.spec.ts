/**
 * The collaboration proof points, in a real browser against a real hub.
 *
 * Each one is here because jsdom structurally cannot host it: two live clients
 * on one document, cursor decorations rendered by a browser, and a reload from
 * the serving process's store. Nothing else belongs in this file — Tiptap
 * typing characters, Yjs merging updates and vite serving modules are other
 * people's tests, and the contracts already pinned by `test/` (golden
 * round-trip, block ids, the palette gate) are not re-tested here.
 *
 * Each test owns its documents and shares the file's harness. A failed test
 * gets a fresh worker and harness, so independent proofs still run.
 */

import { expect, test } from "@playwright/test";
import { createDoc, docTitle, editor, openDoc, setupHarness } from "./app-helpers.js";
import type { Page } from "@playwright/test";
import { placeCaret } from "./harness.js";

const { harness, openApp, trackContext } = setupHarness({ app: { readySelector: ".ub-list-head" } });

/**
 * The open document's first block, with remote-cursor widgets stripped.
 *
 * y-prosemirror renders a peer's cursor as a `<span>` *inside* the block —
 * label text and word joiners included — so plain `textContent` would compare
 * the peer's name along with the document's own text.
 */
function blockText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const block = document.querySelector(".ub-editor .ProseMirror > *");
    if (block === null) return null;
    const copy = block.cloneNode(true) as HTMLElement;
    for (const cursor of copy.querySelectorAll(".ProseMirror-yjs-cursor")) {
      cursor.remove();
    }
    return copy.textContent;
  });
}

async function type(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 15 });
}

test("two contexts typing into different ranges of one block converge byte-identically", async ({
  browser,
}) => {
  const title = docTitle("converge");
  const seed = "middle";
  const left = "left-left-left-left-";
  const right = "-right-right-right-right";

  const [a, b] = await Promise.all([openApp(browser), openApp(browser)]);
  await createDoc(a, title, { pin: true });
  await placeCaret(a);
  await type(a, seed);

  await openDoc(b, title);
  await expect.poll(() => blockText(b)).toBe(seed);

  // Different ranges of the same block, at the same time. Yjs pins each side's
  // insertions to where they were made, so the converged string is knowable in
  // advance — which is what makes "no lost keystrokes" an assertion rather than
  // a character count.
  await placeCaret(a, "start");
  await placeCaret(b);
  await Promise.all([type(a, left), type(b, right)]);

  const converged = `${left}${seed}${right}`;
  await expect.poll(() => blockText(a)).toBe(converged);
  await expect.poll(() => blockText(b)).toBe(converged);
});

test("a TL;DR added from the menu and edited inline follows in the other client", { tag: "@webkit" }, async ({
  browser,
  browserName,
}) => {
  const title = docTitle("tldr");
  const a = await openApp(browser, "/", {
    contextOptions: { colorScheme: "light" },
    readySelector: ".ub-body",
  });
  if ((a.viewportSize()?.width ?? 1280) < 1280) {
    await a.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await createDoc(a, title);
  const b = await openApp(browser, new URL(a.url()).pathname, {
    contextOptions: { colorScheme: "dark" },
    readySelector: ".ub-editor .ProseMirror",
  });

  await a.getByRole("button", { name: "Document actions" }).click();
  await a.getByRole("menuitem", { name: "Add TL;DR" }).click();
  const summaryA = a.getByLabel(
    "Write one or two plain-English sentences that help a reader understand this document.",
  );
  await expect(summaryA).toBeFocused();
  await summaryA.fill("A short summary for readers.");
  await a.getByRole("button", { name: "Save", exact: true }).click();

  const calloutA = a.locator(".ub-tldr");
  const calloutB = b.locator(".ub-tldr");
  await expect(calloutA).toContainText("Quick summary");
  await expect(calloutA).toContainText("TL;DR");
  await expect(calloutB).toContainText("A short summary for readers.");

  const summaryB = b.getByLabel(
    "Write one or two plain-English sentences that help a reader understand this document.",
  );
  const inlineB = calloutB.getByRole("button", { name: "Edit TL;DR", exact: true });
  await inlineB.click();
  await expect(summaryB).toBeFocused();
  const caret = await summaryB.evaluate((element: HTMLTextAreaElement) => ({
    start: element.selectionStart,
    end: element.selectionEnd,
    length: element.value.length,
  }));
  expect(caret.start).toBe(caret.end);
  expect(caret.start).toBeGreaterThanOrEqual(0);
  expect(caret.end).toBeLessThanOrEqual(caret.length);
  await summaryB.fill("x".repeat(301));
  await expect(calloutB.locator("#ub-tldr-count")).toBeVisible();
  await expect(calloutB.locator("#ub-tldr-count")).toHaveText("301 / 300 characters");
  await summaryB.press("Enter");
  await expect(calloutB.getByRole("alert")).toHaveText("A TL;DR is at most 300 characters.");
  await expect(summaryB).toHaveValue("x".repeat(301));
  await expect(calloutA.locator(".ub-tldr-body > p")).toHaveText("A short summary for readers.");
  await summaryB.fill("A short summary for readers.");
  await summaryB.press("End");
  await summaryB.press("Shift+Enter");
  await b.keyboard.insertText("A second line.");
  await expect(summaryB).toHaveValue("A short summary for readers.\nA second line.");
  await expect(calloutA.locator(".ub-tldr-body > p")).toHaveText("A short summary for readers.");
  await summaryB.fill("A short summary for readers.");
  // Leaving an unchanged field closes it; a draft must stay local until saved.
  await b.locator(".ub-title").click();
  await expect(summaryB).toHaveCount(0);
  await inlineB.focus();
  await b.keyboard.press("Space");
  await expect(summaryB).toBeFocused();
  await summaryB.fill("Changed in the other tab.");
  await b.locator(".ub-title").click();
  await expect(summaryB).toHaveValue("Changed in the other tab.");
  await expect(calloutA.locator(".ub-tldr-body > p")).toHaveText("A short summary for readers.");
  await summaryB.press("Enter");
  await expect(calloutA).toContainText("Changed in the other tab.");

  // The native inline button keeps keyboard activation and the form's focus.
  // Safari's Option-Tab includes buttons under its default Tab preference.
  const nextControl = browserName === "webkit" ? "Alt+Tab" : "Tab";
  const inlineA = calloutA.getByRole("button", { name: "Edit TL;DR", exact: true });
  await a.locator(".ub-title").focus();
  for (let count = 0; count < 20; count += 1) {
    if (await inlineA.evaluate((element) => document.activeElement === element)) break;
    await a.keyboard.press(nextControl);
  }
  await expect(inlineA).toBeFocused();
  await a.keyboard.press("Enter");
  await expect(summaryA).toBeFocused();
  await summaryA.fill("Saved from the inline form.");
  await a.getByRole("button", { name: "Save", exact: true }).click();
  await expect(calloutB).toContainText("Saved from the inline form.");
  await inlineA.click();
  await a.getByRole("button", { name: "Clear" }).click();
  await expect(calloutA).toHaveCount(0);
  await expect(calloutB).toHaveCount(0);
});

test("tapping a TL;DR focuses its inline field, cancels drafts and clears the shared value", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const title = docTitle("tldr-touch");
  const a = await openApp(browser, "/", {
    readySelector: ".ub-body",
    contextOptions: info.project.name === "chromium"
      ? { hasTouch: true, viewport: { width: 390, height: 844 } }
      : {},
  });
  if ((a.viewportSize()?.width ?? 1280) < 1280) {
    await a.getByRole("button", { name: "Show document list", exact: true }).tap();
  }
  await createDoc(a, title);
  const b = await openApp(browser, new URL(a.url()).pathname, {
    readySelector: ".ub-editor .ProseMirror",
  });
  await a.getByRole("button", { name: "Document actions" }).tap();
  await a.getByRole("menuitem", { name: "Add TL;DR" }).tap();
  const summary = a.getByLabel(
    "Write one or two plain-English sentences that help a reader understand this document.",
  );
  await summary.fill("A summary shared with readers.");
  await a.getByRole("button", { name: "Save", exact: true }).tap();
  const displayed = a.locator(".ub-tldr-body > p");
  const remote = b.locator(".ub-tldr-body > p");
  await expect(remote).toHaveText("A summary shared with readers.");

  await a.getByRole("button", { name: "Edit TL;DR", exact: true }).tap();
  await expect(summary).toBeFocused();
  await summary.fill("A draft cancelled with Escape.");
  await summary.press("Escape");
  await expect(summary).toHaveCount(0);
  await expect(displayed).toHaveText("A summary shared with readers.");
  await expect(remote).toHaveText("A summary shared with readers.");

  await a.getByRole("button", { name: "Edit TL;DR", exact: true }).tap();
  await expect(summary).toBeFocused();
  await summary.fill("A draft cancelled by tapping Cancel.");
  await a.getByRole("button", { name: "Cancel", exact: true }).tap();
  await expect(summary).toHaveCount(0);
  await expect(displayed).toHaveText("A summary shared with readers.");
  await expect(remote).toHaveText("A summary shared with readers.");

  // WebKit can leave pointer-clicked buttons unfocused. Clear still has to
  // receive a tap before an unchanged field's blur dismisses the form.
  await a.getByRole("button", { name: "Edit TL;DR", exact: true }).tap();
  await a.getByRole("button", { name: "Clear", exact: true }).tap();
  await expect(a.locator(".ub-tldr")).toHaveCount(0);
  await expect(b.locator(".ub-tldr")).toHaveCount(0);
});

test("the upstream fact recovers after an acknowledged typing burst", async ({
  browser,
}) => {
  const page = await openApp(browser);
  await createDoc(page, docTitle("calm-upstream"), { pin: true });
  const observer = await openApp(browser, new URL(page.url()).pathname, { upstream: true });
  await expect(editor(observer)).toBeVisible();
  await placeCaret(page);
  const upstream = page.locator(".ub-status-word--hub");
  await expect(upstream).toHaveText("synced with hub");

  const burst = "calm".repeat(60);
  await page.keyboard.type(burst, { delay: 15 });
  // A browser connected directly to the upstream hub seeing the complete burst
  // is the boundary after which the served page's drawn fact must recover.
  await expect.poll(() => blockText(observer)).toBe(burst);
  await expect(upstream).toHaveText("synced with hub");
});

test("a peer's cursor renders in the other context with its name and colour", async ({
  browser,
}) => {
  const title = docTitle("cursor");

  const [a, b] = await Promise.all([openApp(browser), openApp(browser)]);
  await createDoc(a, title, { pin: true });
  await placeCaret(a);
  await type(a, "watch this");

  await openDoc(b, title);
  await expect.poll(() => blockText(b)).toBe("watch this");

  // Awareness only carries a cursor while that editor has focus, so A's caret
  // has to be in the block for there to be anything to render.
  await a.getByTestId("account-menu").click();
  const name = (await a.locator(".ub-user-heading").innerText()).replace(/^Presence name: /, "").trim();
  const color = await a.locator('.ub-swatch[aria-pressed="true"]').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await a.keyboard.press("Escape");
  await placeCaret(a);
  // Only the peer's cursor is ever decorated; a client never renders its own.
  const label = b.locator(".ub-editor .ProseMirror-yjs-cursor > div");
  await expect(label).toHaveText(name);
  await expect(label).toBeVisible();

  // The colour travels in the same awareness payload as the name, and reaches
  // the label only through y-prosemirror's cursor builder.
  await expect(label).toHaveCSS("background-color", color);

  // And when A picks a different presence colour (#74), B's copy of A's cursor
  // follows it live — the choice is an awareness republish, not something that
  // waits for a reconnect. The colour is read back off A's selected swatch, so this
  // asserts the two ends agree rather than pinning a hex.
  await a.getByTestId("account-menu").click();
  // Anything but the one it was dealt, which is random per tab.
  const dealt = await a
    .locator('.ub-swatch[aria-pressed="true"]')
    .getAttribute("aria-label");
  await a
    .getByRole("button", { name: dealt === "teal" ? "violet" : "teal", exact: true })
    .click();
  const chosen = await a.locator('.ub-swatch[aria-pressed="true"]').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(chosen).not.toBe(color);
  // Back into the block: awareness only carries a cursor while the editor has
  // focus, and opening the panel took it.
  await a.keyboard.press("Escape");
  await placeCaret(a);
  await expect(label).toHaveCSS("background-color", chosen);
});

test("a peer joining leaves the status row's height and the prose where they were", async ({
  browser,
}) => {
  // The cluster is the row's tallest child, and a peer arriving is the most
  // ordinary event in a collaborative document: if the row grows to fit the
  // first circle, every block below it drops by that much (#832). #793's
  // proof covers the row's optional *text*; only a real second client puts a
  // 28px control in it.
  const title = docTitle("row-height");
  const [a, b] = await Promise.all([openApp(browser), openApp(browser)]);
  await createDoc(a, title, { pin: true });
  await placeCaret(a);
  await type(a, "still");

  const status = a.locator(".ub-status");
  const firstBlock = editor(a).locator(":scope > *").first();
  const peers = a.locator(".ub-peers > .ub-peer-control");
  // Both sync facts settled, so the reading beside the cluster is not still
  // resolving while the two geometries are read.
  await expect(a.locator(".ub-status-word--saved")).toHaveText("saved here");
  await expect(a.locator(".ub-status-word--hub")).toHaveText("synced with hub");
  const geometry = async () => ({
    row: (await status.boundingBox())?.height,
    prose: (await firstBlock.boundingBox())?.y,
  });
  await expect(peers).toHaveCount(0);
  const alone = await geometry();

  await openDoc(b, title);
  await expect(peers).toHaveCount(1);
  expect(await geometry()).toEqual(alone);
});

test("the open document's last-updated reading follows its stub through status and archive changes", async ({
  browser,
}) => {
  const context = await browser.newContext();
  trackContext(context);
  const page = await context.newPage();
  const title = docTitle("freshness");
  const realNow = Date.now();

  // Install at the real time before loading, so every room authenticates with a
  // valid token. One minute is enough to prove the shared clock repaints this
  // surface without pushing a freshly minted token outside its valid window.
  await page.clock.install({ time: realNow });
  await page.goto(harness().appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
  await createDoc(page, title, { pin: true });

  const reading = page.locator(".ub-last-updated");
  const time = reading.locator("time");
  await page.clock.fastForward(60_000);
  await expect(reading).toContainText("last updated 1 minute ago");
  const firstDateTime = await time.getAttribute("dateTime");
  expect(firstDateTime).not.toBeNull();
  expect(Number.isFinite(Date.parse(firstDateTime ?? ""))).toBe(true);
  await expect(time).toHaveAttribute("title", /.+/);

  const status = page.locator(".ub-status");
  const firstBlock = editor(page).locator(":scope > *").first();
  const words = status.locator(".ub-status-word");
  const wordText = await words.allTextContents();
  const geometry = async () => ({
    status: await status.boundingBox(),
    prose: await firstBlock.boundingBox(),
  });
  const withFreshness = await geometry();
  await page.evaluate(() => {
    for (const word of document.querySelectorAll(".ub-status-word")) {
      word.replaceChildren();
    }
    const updated = document.querySelector<HTMLElement>(".ub-last-updated");
    if (updated !== null) updated.style.display = "none";
  });
  expect(await geometry()).toEqual(withFreshness);
  await words.evaluateAll((elements, text) => {
    elements.forEach((element, index) => {
      element.textContent = text[index] ?? "";
    });
  }, wordText);
  await reading.evaluate((element) => element.style.removeProperty("display"));

  const renamed = `${title} fresh`;
  await page.locator(".ub-title").fill(renamed);
  await expect(reading).toContainText("last updated just now");
  await expect(time).not.toHaveAttribute("dateTime", firstDateTime ?? "");
  const currentDateTime = await time.getAttribute("dateTime");
  expect(currentDateTime).not.toBeNull();

  await page.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Archive document" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Archive document" })
    .click();
  const restore = page.getByRole("button", { name: "Restore" });
  await expect(restore).toBeVisible();
  // Archive completion deliberately transfers focus to the surviving action.
  // That focus may scroll the pane, so it is the settle boundary before the
  // position this test expects the later upstream outage to preserve.
  await expect(restore).toBeFocused();
  await expect(reading).toContainText("last updated just now");
  await expect(time).toHaveAttribute("dateTime", currentDateTime ?? "");

  // `Restore` is painted from this tab's local Y.Doc before its directory
  // update has necessarily completed the local server round trip. A fresh tab
  // seeing the tombstone proves that durable apply and broadcast completed;
  // the upstream can now be stopped without racing the archive itself.
  const archiveObserver = await openApp(browser, new URL(page.url()).pathname);
  await expect(
    archiveObserver.getByRole("button", { name: "Restore" }),
  ).toBeVisible();
  const stablePosition = await reading.boundingBox();
  expect(stablePosition).not.toBeNull();
  const saved = page.locator(".ub-status-word--saved");
  const upstream = page.locator(".ub-status-word--hub");
  await expect(saved).toHaveText("saved here");
  await expect(upstream).toHaveText("synced with hub");

  await harness().stopHub();
  try {
    // The browser remains connected to `ub open`; only its silent upstream
    // replica is offline, so the local durability boundary stays saved while
    // the separately polled upstream fact turns negative.
    await expect(saved).toHaveText("saved here");
    await expect(upstream).toHaveText("not synced with hub");
    await page.locator(".ub-sync-toggle").click();
    const panel = page.getByRole("dialog", { name: "Sync and presence" });
    const fact = (label: string) =>
      panel.getByText(label, { exact: true }).locator("..").locator("dd");
    await expect(fact("Hub")).toHaveText(harness().hubUrl);
    await expect(fact("State")).toHaveText("saved here");
    await expect(fact("Hub state")).toHaveText("not synced with hub");
    await page.locator(".ub-sync-toggle").click();
    await expect(reading).toContainText("last updated just now");
    await expect(time).toHaveAttribute("dateTime", currentDateTime ?? "");
    expect(await reading.boundingBox()).toEqual(stablePosition);
  } finally {
    await harness().startHub();
  }
  await expect(upstream).toHaveText("synced with hub", {
    timeout: 40_000,
  });
  await expect(reading).toContainText("last updated just now");
  await expect(time).toHaveAttribute("dateTime", currentDateTime ?? "");
  expect(await reading.boundingBox()).toEqual(stablePosition);
});

test("a fresh browser hydrates from the ub open store while the upstream is offline", async ({
  browser,
}) => {
  const seeded = await openApp(browser);
  await createDoc(seeded, docTitle("checkpoint"), { pin: true });
  const path = new URL(seeded.url()).pathname;

  await harness().stopHub();
  try {
    // The document and directory come from `ub open`'s store-backed rooms, not
    // from the unavailable upstream.
    const fresh = await openApp(browser, path);
    await expect(editor(fresh)).toBeVisible();
    await expect(fresh.locator(".ub-status-word--saved")).toHaveText("saved here");
    await expect(fresh.locator(".ub-status-word--hub")).toHaveText(
      "not synced with hub",
    );

    // Reload is another store hydration while upstream remains unavailable.
    await fresh.reload();
    await expect(editor(fresh)).toBeVisible();
    await expect(fresh.locator(".ub-status-word--saved")).toHaveText("saved here");
    await expect(fresh.locator(".ub-status-word--hub")).toHaveText(
      "not synced with hub",
    );
  } finally {
    await harness().startHub();
  }
});

test("a multi-author block survives upstream loss and converges back without duplication", async ({
  browser,
}) => {
  const title = docTitle("offline");

  const [a, b] = await Promise.all([openApp(browser), openApp(browser)]);
  await createDoc(a, title, { pin: true });
  await placeCaret(a);
  await type(a, "before");

  await openDoc(b, title);
  await expect.poll(() => blockText(b)).toBe("before");
  // The outage starts from a block with text authored by both clients. The
  // writer must keep both contributions when it adds the offline suffix.
  await placeCaret(b);
  await type(b, "-peer");
  await expect.poll(() => blockText(a)).toBe("before-peer");
  await expect(a.locator(".ub-status-word--hub")).toHaveText("synced with hub");
  await harness().stopHub();
  try {
    await expect(a.locator(".ub-status-word--hub")).toHaveText(
      "not synced with hub",
    );

    // Reload with no upstream. Both rooms hydrate from the process-local store,
    // and the browser still has a real durability boundary to acknowledge it.
    await a.reload();
    await openDoc(a, title);
    await expect.poll(() => blockText(a)).toBe("before-peer");
    await expect(a.locator(".ub-status-word--saved")).toHaveText("saved here");
    await expect(a.locator(".ub-status-word--hub")).toHaveText(
      "not synced with hub",
    );

    await placeCaret(a);
    await type(a, "-offline");
    await expect.poll(() => blockText(b)).toBe("before-peer-offline");

    await harness().startHub();
    // A browser connected directly to the restarted upstream sees the update
    // once the silent replica drains its pending row. Exact text rules out a
    // duplicate replay as well as a missing write.
    const upstream = await openApp(browser, new URL(a.url()).pathname, { upstream: true });
    await expect
      .poll(() => blockText(upstream), { timeout: 40_000 })
      .toBe("before-peer-offline");
  } finally {
    await harness().startHub();
  }
});
