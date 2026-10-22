import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { appendBlock, applyDocData, initDoc, snapshotRevision } from "@uberblick/schema";
import type { RevisionEntry } from "@uberblick/schema";
import * as Y from "yjs";
import { activateControl, createDoc, docTitle, editor, setupHarness } from "./app-helpers.js";

function history(page: Page): Locator {
  return page.getByRole("group", { name: "Document history", exact: true });
}

function historicalEditor(page: Page): Locator {
  return page.locator(".ub-revision-pane .ProseMirror");
}

async function newDocument(page: Page, title: string): Promise<string> {
  if (!await page.getByRole("button", { name: "+ New page", exact: true }).isVisible()) {
    await activateControl(page.getByRole("button", { name: "Show document list", exact: true }));
  }
  return await createDoc(page, title);
}

async function selectPositions(view: Locator, from: number, to = from): Promise<void> {
  await view.evaluate((element, selection) => {
    const mounted = element as HTMLElement & { editor: Editor };
    mounted.editor.view.focus();
    mounted.editor.commands.setTextSelection(selection);
  }, { from, to });
  await view.page().keyboard.press("Shift");
  await expect.poll(() => view.evaluate((element, selection) => {
    const mounted = element as HTMLElement & { editor: Editor };
    return mounted.editor.state.selection.from === selection.from && mounted.editor.state.selection.to === selection.to &&
      mounted.contains(document.activeElement);
  }, { from, to })).toBe(true);
}

async function archiveAndRestore(page: Page, title: string): Promise<void> {
  await activateControl(page.getByRole("button", { name: "Document actions", exact: true }));
  await activateControl(page.getByRole("menuitem", { name: "Archive document", exact: true }));
  const dialog = page.getByRole("alertdialog", { name: `Archive “${title}”?` });
  await activateControl(dialog.getByRole("button", { name: "Archive", exact: true }));
  const restore = page.getByRole("button", { name: "Restore", exact: true });
  await expect(restore).toBeVisible();
  await activateControl(restore);
  await expect(restore).toHaveCount(0);
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
}

function savedState(uuid: string, title: string, text: string): string {
  const document = new Y.Doc();
  try {
    initDoc(document, { uuid, title });
    appendBlock(document, { type: "paragraph", text });
    return Buffer.from(snapshotRevision(document).state).toString("base64");
  } finally {
    document.destroy();
  }
}

async function serveHistory(page: Page, revisions: RevisionEntry[], states: Record<string, string>): Promise<void> {
  await page.route("**/api/revisions?**", async route => {
    const revision = new URL(route.request().url()).searchParams.get("revision");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(revision === null ? { revisions } : { state: states[revision] }),
    });
  });
}

function dataHistory(uuid: string, title: string): Record<string, string> {
  const document = new Y.Doc();
  const directory = new Y.Doc();
  try {
    initDoc(document, { uuid, title });
    appendBlock(document, { type: "chart", text: JSON.stringify({
      version: 1, type: "table", collection: "measurements", title: "Historical measurements",
      columns: [{ field: "day", label: "Day" }, { field: "latency", label: "Latency", format: "number", unit: "ms" }],
    }) });
    appendBlock(document, { type: "chart", text: JSON.stringify({
      version: 1, type: "line", collection: "measurements", title: "Historical latency",
      x: { field: "day", type: "date", label: "Day" },
      y: [{ field: "latency", label: "Latency", unit: "ms" }],
    }) });
    const update = (first: number, last: number): void => {
      applyDocData(document, directory, [{ collection: "measurements", schema: { version: 1, schema: { type: "object" } }, replaceRecords: [
        { id: "a", value: { day: "2026-10-20", latency: first } },
        { id: "b", value: { day: "2026-10-21", latency: last } },
      ] }]);
    };
    update(10, 20);
    const earlier = Buffer.from(snapshotRevision(document).state).toString("base64");
    update(90, 100);
    return { earlier, latest: Buffer.from(snapshotRevision(document).state).toString("base64") };
  } finally {
    document.destroy();
    directory.destroy();
  }
}

test.describe("document history through ub open", () => {
  const { harness, openApp } = setupHarness({ accessRole: "admin" });

  test("real hub revisions navigate, keep removed text selectable and isolate the live editor", { tag: "@webkit" }, async ({ browser, browserName }, info) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    await page.emulateMedia({ colorScheme: browserName === "webkit" ? "dark" : "light" });
    const title = docTitle("Selectable revision changes");
    const uuid = await newDocument(page, title);
    const room = `${harness().workspaceUuid}/${uuid}`;
    const live = page.locator(".ub-document-pane:not(.ub-revision-pane) .ub-editor .ProseMirror");
    await activateControl(live);
    await page.keyboard.type("The amber fox stays.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("A removed paragraph.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("A surviving paragraph.");
    await expect.poll(() => harness().hubText(room)).toContain("A surviving paragraph.");

    // Archiving closes the actual hub's authored stretch without a fake clock.
    await archiveAndRestore(page, title);
    await selectPositions(live, 5, 10);
    await page.keyboard.type("blue");
    const deleted = await live.evaluate(element => {
      const doc = (element as HTMLElement & { editor: Editor }).editor.state.doc;
      const start = doc.child(0).nodeSize;
      return { from: start, to: start + doc.child(1).nodeSize };
    });
    await selectPositions(live, deleted.from, deleted.to);
    await page.keyboard.press("Backspace");
    await expect(live.locator(":scope > p")).toHaveText(["The blue fox stays.", "A surviving paragraph."]);
    await expect.poll(() => harness().hubText(room)).not.toContain("A removed paragraph.");

    const path = new URL(page.url()).pathname;
    const peer = await openApp(browser, path, { readySelector: ".ub-editor .ProseMirror" });
    await expect(editor(peer)).toContainText("The blue fox stays.");
    await activateControl(history(page).getByRole("button", { name: "Refresh history", exact: true }));
    await activateControl(history(page).getByRole("button", { name: "Back", exact: true }));
    const view = historicalEditor(page);
    await expect(view).toHaveAttribute("contenteditable", "false");
    await expect(history(page)).toContainText("browser-person");
    await expect(history(page)).toContainText(/from /);
    await expect(page).toHaveURL(new URL(path, harness().appUrl).href);
    await expect(view.locator('[data-revision-change="added"]')).toContainText("blue");
    const removed = view.locator('[data-revision-change="removed"]').filter({ hasText: "amber" });
    await expect(removed).toHaveText("amber");
    await expect(view).toContainText("A removed paragraph.");
    await expect(view.locator('[data-revision-change="removed"]').filter({ hasText: "A removed paragraph." })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (browserName === "webkit") {
      for (const name of ["Back", "Forward", "Back to now"]) {
        const box = await history(page).getByRole("button", { name, exact: true }).boundingBox();
        if (box === null) throw new Error(`history control ${name} has no touch target`);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
      }
    }
    const screenshotName = browserName === "webkit" ? "revision-ipad-dark" : "revision-desktop-light";
    const screenshot = info.outputPath(`${screenshotName}.png`);
    await page.screenshot({ path: screenshot });
    await info.attach(screenshotName, { path: screenshot, contentType: "image/png" });

    const copied = await removed.evaluate(element => {
      const root = element.closest(".ProseMirror") as HTMLElement & { editor: Editor };
      const text = element.firstChild;
      if (text === null) throw new Error("removed content has no text node");
      const from = root.editor.view.posAtDOM(text, 0);
      root.editor.commands.setTextSelection({ from, to: from + (element.textContent?.length ?? 0) });
      const clipboard = new DataTransfer();
      root.dispatchEvent(new ClipboardEvent("copy", { clipboardData: clipboard, bubbles: true, cancelable: true }));
      return { text: clipboard.getData("text/plain"), html: clipboard.getData("text/html") };
    });
    expect(copied.text).toBe("amber");
    expect(copied.html).not.toMatch(/ub-revision-|data-revision-change|<s[\s>]/);
    await expect(page.locator('[data-slot="selection-composer"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Document actions", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Insert block below", includeHidden: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Threads", exact: true })).toHaveCount(0);
    await expect(view.locator("[data-comment-thread]")).toHaveCount(0);

    const before = await view.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.getJSON());
    await activateControl(removed);
    await page.keyboard.type("typed mutation");
    await page.keyboard.press("ControlOrMeta+b");
    await view.evaluate(element => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", "pasted or dropped mutation");
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
      element.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
      const mounted = element as HTMLElement & { editor: Editor };
      mounted.editor.view.dispatch(mounted.editor.state.tr.insertText("command mutation", 1));
    });
    expect(await view.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.getJSON())).toEqual(before);
    await expect(editor(peer)).toContainText("The blue fox stays.");
    await expect(editor(peer)).not.toContainText("mutation");

    await activateControl(history(page).getByRole("button", { name: "Back", exact: true }));
    await expect(view).toContainText("The amber fox stays.");
    await expect(view.locator("[data-revision-change]")).toHaveCount(0);
    await expect(history(page).getByRole("button", { name: "Back", exact: true })).toBeDisabled();
    await activateControl(history(page).getByRole("button", { name: "Forward", exact: true }));
    await expect(view.locator('[data-revision-change="added"]')).toContainText("blue");

    await selectPositions(editor(peer), 1);
    await peer.keyboard.type("Live collaborator: ");
    await expect(editor(peer)).toContainText("Live collaborator: The blue fox stays.");
    await expect(view).not.toContainText("Live collaborator:");
    await activateControl(history(page).getByRole("button", { name: "Back to now", exact: true }));
    await expect(historicalEditor(page)).toHaveCount(0);
    await expect(live).toHaveAttribute("contenteditable", "true");
    await expect.poll(() => live.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.state.doc.textContent))
      .toContain("Live collaborator: The blue fox stays.");
    await expect(live.locator("[data-revision-change]")).toHaveCount(0);
    await expect.poll(() => harness().hubText(room)).toContain("Live collaborator: The blue fox stays.");
    await selectPositions(live, await live.evaluate(element => (element as HTMLElement & { editor: Editor }).editor.state.doc.content.size - 1));
    await live.evaluate((element, copied) => {
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", copied.text);
      clipboard.setData("text/html", copied.html);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
    }, copied);
    await expect(live).toContainText("amber");
    await expect(editor(peer)).toContainText("amber");
    await expect(live.locator("s, del, strike, [data-revision-change]")).toHaveCount(0);
    await expect(editor(peer).locator("s, del, strike, [data-revision-change]")).toHaveCount(0);
    await expect.poll(() => harness().hubText(room)).toContain("amber");
    await page.reload();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await expect(historicalEditor(page)).toHaveCount(0);
    await expect(editor(page).locator("[data-revision-change]")).toHaveCount(0);
  });

  test("keyboard history navigation retains control focus and moves to an available control at either boundary", { tag: "@webkit" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const title = docTitle("Keyboard revision navigation");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 3_000, endedAt: null },
      { id: "middle", author: null, startedAt: 2_000, endedAt: 3_000 },
      { id: "earliest", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], {
      latest: savedState(uuid, title, "Latest content."),
      middle: savedState(uuid, title, "Middle content."),
      earliest: savedState(uuid, title, "Earliest content."),
    });
    await activateControl(history(page).getByRole("button", { name: "Refresh history", exact: true }));
    const back = history(page).getByRole("button", { name: "Back", exact: true });
    const forward = history(page).getByRole("button", { name: "Forward", exact: true });
    await expect(back).toBeEnabled();
    await back.focus();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toContainText("Latest content.");
    await expect(back).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toContainText("Middle content.");
    await expect(back).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toHaveText("Earliest content.");
    await expect(back).toBeDisabled();
    await expect(forward).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toContainText("Middle content.");
    await expect(forward).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toContainText("Latest content.");
    await expect(forward).toBeDisabled();
    await expect(back).toBeFocused();
    await history(page).getByRole("button", { name: "Back to now", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toHaveCount(0);
    await expect(back).toBeFocused();
  });

  test("opening history preserves unsent comment and reply drafts", { tag: "@webkit" }, async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const title = docTitle("Retained discussion drafts");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [{ id: "earlier", author: null, startedAt: 1_000, endedAt: null }], {
      earlier: savedState(uuid, title, "Historical text without comments."),
    });
    await activateControl(history(page).getByRole("button", { name: "Refresh history", exact: true }));
    await activateControl(editor(page));
    await page.keyboard.type("First comment target. Another comment target.");
    await selectPositions(editor(page), 1, 6);
    await activateControl(page.getByRole("button", { name: "Comment", exact: true }));
    await page.getByPlaceholder(/Comment as/).fill("A saved comment.");
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "Threads", exact: true });
    await expect(page.getByRole("region", { name: "Threads", exact: true })).toContainText("A saved comment.");
    await activateControl(page.getByRole("button", { name: "Reply", exact: true }));
    await page.getByPlaceholder("Reply…").fill("An unsent reply.");
    if (await sheet.isVisible()) await activateControl(sheet.getByRole("button", { name: "Close threads", exact: true }));
    await selectPositions(editor(page), 23, 30);
    await activateControl(page.getByRole("button", { name: "Comment", exact: true }));
    const comment = page.getByPlaceholder(/Comment as/);
    await comment.fill("An unsent comment.");
    await history(page).getByRole("button", { name: "Back", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(historicalEditor(page)).toHaveText("Historical text without comments.");
    await expect(comment).toBeHidden();
    await expect(page.getByRole("region", { name: "Threads", exact: true })).toHaveCount(0);
    await expect(sheet).toBeHidden();
    await activateControl(history(page).getByRole("button", { name: "Back to now", exact: true }));
    await expect(comment).toHaveValue("An unsent comment.");
    await expect(comment).toBeVisible();
    await activateControl(page.locator('[data-slot="selection-composer"]').getByRole("button", { name: "Cancel", exact: true }));
    const toggle = page.locator(".ub-threads-toggle");
    if (await toggle.isVisible()) await activateControl(toggle);
    await expect(page.getByPlaceholder("Reply…")).toHaveValue("An unsent reply.");
  });

  test("returning to now preserves an offline draft and history labels expose unknown attribution", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const title = docTitle("Offline current draft");
    const uuid = await newDocument(page, title);
    const room = `${harness().workspaceUuid}/${uuid}`;
    await activateControl(editor(page));
    await page.keyboard.type("Shared current content.");
    await expect.poll(() => harness().hubText(room)).toBe("Shared current content.");
    await serveHistory(page, [
      { id: "agent", author: { githubUsername: "Ben", surface: { kind: "mcp", name: "Claude Code" } }, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: null, endedAt: 1_000 },
    ], {
      agent: savedState(uuid, title, "Earlier agent content."),
      earlier: savedState(uuid, title, "Earlier content."),
    });
    await activateControl(history(page).getByRole("button", { name: "Refresh history", exact: true }));
    await expect(history(page).getByRole("button", { name: "Back", exact: true })).toBeEnabled();
    await harness().stopHub();
    try {
      await selectPositions(editor(page), 1);
      await page.keyboard.type("Unsynced draft: ");
      await expect(editor(page)).toContainText("Unsynced draft: Shared current content.");
      await activateControl(history(page).getByRole("button", { name: "Back", exact: true }));
      await expect(history(page)).toContainText("Ben via Claude Code, from ");
      await activateControl(history(page).getByRole("button", { name: "Back", exact: true }));
      await expect(historicalEditor(page)).toHaveText("Earlier content.");
      await expect(history(page)).toContainText("Unknown author, unknown start to ");
      await activateControl(history(page).getByRole("button", { name: "Back to now", exact: true }));
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      await expect(editor(page)).toContainText("Unsynced draft: Shared current content.");
    } finally {
      await harness().startHub();
    }
    await expect.poll(() => harness().hubText(room)).toBe("Unsynced draft: Shared current content.");
  });

  test("empty history is stated explicitly", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    await newDocument(page, docTitle("No revisions"));
    await serveHistory(page, [], {});
    await activateControl(history(page).getByRole("button", { name: "Refresh history", exact: true }));
    await expect(history(page)).toContainText(/no revisions/i);
    await expect(history(page).getByRole("button", { name: "Back", exact: true })).toBeDisabled();
    await expect(historicalEditor(page)).toHaveCount(0);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  });

  test("a data-only revision draws its own chart and generated-table numbers", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    const title = docTitle("Historical data projections");
    const uuid = await newDocument(page, title);
    await serveHistory(page, [
      { id: "latest", author: null, startedAt: 2_000, endedAt: null },
      { id: "earlier", author: null, startedAt: 1_000, endedAt: 2_000 },
    ], dataHistory(uuid, title));
    await activateControl(history(page).getByRole("button", { name: "Refresh history", exact: true }));
    await activateControl(history(page).getByRole("button", { name: "Back", exact: true }));
    const view = historicalEditor(page);
    const table = view.getByRole("table", { name: "Historical measurements", exact: true });
    await expect(table.locator("tbody tr")).toHaveText(["2026-10-2090 ms", "2026-10-21100 ms"]);
    await expect(view.locator(".ub-revision-fields")).toHaveText(["Data changed: measurements", "Data changed: measurements"]);
    const chart = view.locator(".ub-chart").filter({ has: page.getByRole("img", { name: "Historical latency", exact: true }) });
    await expect(chart).toHaveAttribute("data-draw-state", "success");
    await expect(chart.locator(".ub-chart-description")).toContainText("Latest values: Latency: 100 ms.");
    await activateControl(history(page).getByRole("button", { name: "Back", exact: true }));
    await expect(table.locator("tbody tr")).toHaveText(["2026-10-2010 ms", "2026-10-2120 ms"]);
    await expect(chart).toHaveAttribute("data-draw-state", "success");
    await expect(chart.locator(".ub-chart-description")).toContainText("Latest values: Latency: 20 ms.");
    await expect(view.locator(".ub-revision-fields")).toHaveCount(0);
    await activateControl(history(page).getByRole("button", { name: "Back to now", exact: true }));
    await expect(editor(page).locator(".ub-chart")).toHaveCount(0);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  });

  for (const [reason, message] of [
    ["unreachable", "History is unavailable: the hub cannot be reached."],
    ["sign-in-required", "History is unavailable: sign in to the hub on this computer."],
    ["forbidden", "History is unavailable: the hub refused access."],
    ["unsupported", "History is unavailable: this hub does not serve revisions."],
  ] as const) {
    test(`unavailable history explains ${reason} and can be refreshed`, async ({ browser }) => {
      const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
      await page.route("**/api/revisions?**", route => route.fulfill({
        status: 503, contentType: "application/json", body: JSON.stringify({ error: "history_unavailable", reason }),
      }));
      await newDocument(page, docTitle(`Unavailable ${reason}`));
      await expect(history(page).getByRole("status")).toHaveText(message);
      await expect(historicalEditor(page)).toHaveCount(0);
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      await page.unroute("**/api/revisions?**");
      await serveHistory(page, [], {});
      await activateControl(history(page).getByRole("button", { name: "Refresh history", exact: true }));
      await expect(history(page).getByRole("status")).toHaveText("No revisions yet");
    });
  }
});

test.describe("local-only document history", () => {
  const { openApp } = setupHarness({ accessRole: "admin", localWorkspace: true });

  test("a local-only workspace shows no time-travel control", async ({ browser }) => {
    const page = await openApp(browser, "/", { readySelector: ".ub-pane" });
    await newDocument(page, docTitle("Local document"));
    await expect(history(page)).toHaveCount(0);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  });
});
