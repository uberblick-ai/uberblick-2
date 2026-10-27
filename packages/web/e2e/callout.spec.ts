/** Callout captions stay chrome while authored prose keeps native browser behavior. */
import { randomUUID } from "node:crypto";
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { appendBlock, editBlock, findBlockElement, initDoc, snapshotRevision } from "@uberblick/schema";
import * as Y from "yjs";
import { activateControl, docTitle, editor, setupHarness } from "./app-helpers.js";
import { placeCaretIn } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { setPointerSelection } from "./native-selection.js";
import { expectMcp } from "./settle.js";

const { harness, openApp } = setupHarness();
const TARGET = "https://example.invalid/callout";
let agent: McpAgent | null = null;
test.beforeAll(() => {
  agent = new McpAgent({ workspace: harness().workspace, hubUrl: harness().hubUrl,
    authSecret: harness().authSecret, statePrefix: "uberblick-e2e-callout-" });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

interface StoredDoc {
  uuid: string;
  blocks: Array<{ id: string; text: string; rev: string; type: string; variant?: string; icon?: string }>;
}

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: callout writer is missing");
  return agent.open({ name: "callout-e2e" });
}

function contextOptions(touch: boolean) {
  return touch ? devices["iPad (gen 7)"] : { viewport: { width: 1440, height: 1000 } };
}

async function copyText(page: Page): Promise<string> {
  const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta" : "Control");
  await page.keyboard.press(`${modifier}+c`);
  await page.evaluate(() => {
    const target = document.createElement("textarea");
    target.dataset.calloutCopy = "true";
    document.body.append(target);
    target.focus();
  });
  const target = page.locator("textarea[data-callout-copy]");
  await page.keyboard.press(`${modifier}+v`);
  const text = await target.inputValue();
  await target.evaluate(element => element.remove());
  return text;
}

async function selectAll(page: Page, body: Locator, touch: boolean): Promise<string> {
  if (await editor(page).getAttribute("contenteditable") === "true") await placeCaretIn(body, { touch });
  else {
    await editor(page).focus();
    await activateControl(body, { touch });
  }
  // An iPad UA on Linux selects iOS's Ctrl+A caret binding. Use the browser's
  // select-all command here; desktop keeps its physical keyboard shortcut.
  if (touch) await page.evaluate(() => document.execCommand("selectAll"));
  else {
    const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta" : "Control");
    await page.keyboard.press(`${modifier}+a`);
  }
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString() ?? ""))
    .toContain(await body.innerText());
  return page.evaluate(() => document.getSelection()?.toString() ?? "");
}

async function followExternal(page: Page, activate: () => Promise<unknown>): Promise<void> {
  const [popup] = await Promise.all([page.context().waitForEvent("page"), activate()]);
  try {
    await popup.waitForLoadState();
    await expect(popup).toHaveURL(TARGET);
    expect(await popup.evaluate(() => window.opener)).toBeNull();
  } finally {
    await popup.close();
    await page.bringToFront();
  }
}

function variantControl(page: Page): Locator {
  return page.getByRole("button", { name: "Callout variant", exact: true });
}

function variantMenu(page: Page): Locator {
  return page.getByRole("menu", { name: "Callout variant", exact: true });
}

test("slash and the shared gutter create editable callouts without replacing the existing block", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const session = writer();
  const created = await session.call<StoredDoc>("create_doc", {
    title: docTitle("Author a callout"), description: "Callout creation through real editor controls.",
    blocks: [{ type: "paragraph", text: "" }],
  });
  const id = created.blocks[0]?.id;
  if (id === undefined) throw new Error("e2e: starting paragraph is missing");
  const touch = info.project.use.hasTouch === true;
  const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
    upstream: true, contextOptions: contextOptions(touch),
  });
  await placeCaretIn(editor(page).locator(":scope > p"), { touch });
  await page.keyboard.type("/warn");
  const blockMenu = page.getByRole("listbox", { name: "Block types", exact: true });
  await expect(blockMenu.getByRole("option", { name: "Warning", exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  const warning = page.getByRole("note", { name: "Warning", exact: true });
  await expect(warning).toHaveAttribute("id", id);
  await expect(warning.locator(".ub-callout-body")).toHaveText("");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.insertText("First line");
  await expect(warning.locator(".ub-callout-body")).toHaveText("First line");

  if (touch) await placeCaretIn(warning.locator(".ub-callout-body"), { touch });
  else await warning.hover();
  const gutter = page.getByRole("button", { name: "Insert block below", includeHidden: true });
  await expect(gutter).toHaveCSS("opacity", "1");
  await activateControl(gutter, { touch });
  await expect(blockMenu.getByText("Callouts", { exact: true })).toBeVisible();
  for (const name of ["Note", "Tip", "Important", "Warning", "Caution"]) {
    await expect(blockMenu.getByRole("option", { name, exact: true })).toBeVisible();
  }
  await activateControl(blockMenu.getByRole("option", { name: "Tip", exact: true }), { touch });
  await page.keyboard.insertText("Inserted below");
  await expect(editor(page).locator(":scope > .ub-callout")).toHaveCount(2);
  await expect(page.getByRole("note", { name: "Tip", exact: true }).locator(".ub-callout-body")).toHaveText("Inserted below");
  await expectMcp(() => session.call<StoredDoc>("get_doc", { uuid: created.uuid }), stored => {
    expect(stored.blocks.map(block => ({ type: block.type, variant: block.variant, text: block.text })))
      .toEqual([{ type: "callout", variant: "warning", text: "First line" },
        { type: "callout", variant: "tip", text: "Inserted below" }]);
    expect(stored.blocks[0]?.id).toBe(id);
  });
});

test("typing a complete quote marker with Space or Enter makes one undoable empty callout", async ({ browser }) => {
  const session = writer();
  for (const key of ["Space", "Enter"]) {
    const created = await session.call<StoredDoc>("create_doc", {
      title: docTitle(`Typed marker ${key}`), description: "Native marker shortcut and its undo boundary.",
      blocks: [{ type: "quote", text: "" }],
    });
    const id = created.blocks[0]?.id;
    if (id === undefined) throw new Error("e2e: marker quote is missing");
    const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
      upstream: true, contextOptions: contextOptions(false),
    });
    await placeCaretIn(editor(page).locator(":scope > blockquote"));
    await page.keyboard.type("[!tIp]");
    await page.keyboard.press(key);
    const tip = page.getByRole("note", { name: "Tip", exact: true });
    await expect(tip).toHaveAttribute("id", id);
    await expect(tip.locator(".ub-callout-body")).toHaveText("");
    await page.keyboard.press("ControlOrMeta+z");
    const quote = editor(page).locator(":scope > blockquote");
    await expect(quote).toHaveAttribute("id", id);
    await expect.poll(() => quote.textContent()).toBe(key === "Space" ? "[!tIp] " : "[!tIp]");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(tip).toHaveAttribute("id", id);
    await page.keyboard.insertText("Line one");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("Line two");
    await page.keyboard.press("Shift+Enter");
    await expect.poll(() => tip.locator(".ub-callout-body").textContent()).toBe("Line one\nLine two\n");
    await page.keyboard.press("Enter");
    await expect.poll(() => tip.locator(".ub-callout-body").textContent()).toBe("Line one\nLine two");
    await page.keyboard.insertText("Below the callout");
    await expect(editor(page).locator(":scope > p")).toHaveText("Below the callout");
    await placeCaretIn(tip.locator(".ub-callout-body"), { edge: "start" });
    await page.keyboard.press("Backspace");
    await expect.poll(() => editor(page).locator(`:scope > p[id="${id}"]`).textContent()).toBe("Line one\nLine two");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(tip).toHaveAttribute("id", id);
    await expect.poll(() => tip.locator(".ub-callout-body").textContent()).toBe("Line one\nLine two");
  }
});

// Initial keyboard focus in the caption menu is intermittent.
test.fixme("caption menus work with keyboard, pointer and iPad touch, and variant and icon edits sync with separate undo steps", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const session = writer();
  const created = await session.call<StoredDoc>("create_doc", {
    title: docTitle("Callout controls"), description: "Callout caption controls and replicated attributes.",
    blocks: [{ type: "callout", variant: "tip", icon: "🚀", text: "Keep this text." }],
  });
  const touch = info.project.use.hasTouch === true;
  const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
    upstream: true, contextOptions: contextOptions(touch),
  });
  const peer = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
    upstream: true, contextOptions: contextOptions(touch),
  });
  const frame = editor(page).locator(":scope > .ub-callout");
  const peerFrame = editor(peer).locator(":scope > .ub-callout");
  await placeCaretIn(frame.locator(".ub-callout-body"), { touch });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await activateControl(variantControl(page), { touch });
    await expect(variantMenu(page)).toBeInViewport();
    await expect(variantMenu(page).getByRole("menuitem", { name: "Warning", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(variantMenu(page)).toHaveCount(0);
    await expect(editor(page)).toBeFocused();
  }
  await page.keyboard.press("Shift+F10");
  await expect(variantMenu(page)).toBeVisible();
  await expect(variantMenu(page).getByRole("menuitem").first()).toBeFocused();
  if (touch) {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
  } else await page.keyboard.press("w");
  await expect(variantMenu(page).getByRole("menuitem", { name: "Warning", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(frame).toHaveAccessibleName("Warning");
  await expect(peerFrame).toHaveAccessibleName("Warning");
  await expect(peerFrame).toHaveAttribute("data-icon", "🚀");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(frame).toHaveAccessibleName("Tip");
  await expect(peerFrame).toHaveAccessibleName("Tip");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(frame).toHaveAccessibleName("Warning");

  await activateControl(variantControl(page), { touch });
  await activateControl(variantMenu(page).getByRole("menuitem", { name: "Change icon…", exact: true }), { touch });
  const search = page.getByRole("combobox", { name: "Search icons", exact: true });
  const icons = page.getByRole("listbox", { name: "Callout icons", exact: true });
  await expect(search).toBeFocused();
  await expect(search).toBeInViewport();
  if (touch) expect(await search.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  await search.fill("smi");
  await expect(icons.getByRole("option")).toHaveCount(8);
  await expect(icons.getByRole("option", { name: "smiley", exact: true })).toContainText("😃");
  await search.fill("cla");
  const claude = icons.getByRole("option", { name: "Claude", exact: true });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(claude).toBeInViewport();
    await expect(claude.locator("svg")).toBeVisible();
  }
  await activateControl(claude, { touch });
  await expect(editor(page)).toBeFocused();
  await expect(peerFrame).toHaveAttribute("data-icon", ":claude:");
  await expect(peerFrame.locator('.ub-callout-icon[data-icon="claude"] svg')).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(frame).toHaveAccessibleName("Warning");
  await expect(peerFrame).toHaveAttribute("data-icon", "🚀");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(peerFrame).toHaveAttribute("data-icon", ":claude:");

  await activateControl(variantControl(page), { touch });
  await activateControl(variantMenu(page).getByRole("menuitem", { name: "Caution", exact: true }), { touch });
  await expect(peerFrame).toHaveAccessibleName("Caution");
  await expect(peerFrame).toHaveAttribute("data-icon", ":claude:");
  await activateControl(variantControl(page), { touch });
  await activateControl(variantMenu(page).getByRole("menuitem", { name: "Change icon…", exact: true }), { touch });
  await search.fill("smi");
  await page.keyboard.press("Enter");
  await expect(peerFrame).toHaveAttribute("data-icon", "😃");
  await activateControl(variantControl(page), { touch });
  await activateControl(variantMenu(page).getByRole("menuitem", { name: "Change icon…", exact: true }), { touch });
  await activateControl(page.getByRole("button", { name: "Use default icon", exact: true }), { touch });
  await expect(peerFrame).not.toHaveAttribute("data-icon");
  await expect(peerFrame.locator(".ub-callout-icon svg")).toBeVisible();
  await expectMcp(() => session.call<StoredDoc>("get_doc", { uuid: created.uuid }), stored => {
    expect(stored.blocks[0]).toMatchObject({ id: created.blocks[0]?.id, type: "callout", variant: "caution", text: "Keep this text." });
    expect(stored.blocks[0]?.icon).toBeUndefined();
  });
});

test("caption conversions preserve formatted and commented prose, the block id, and one-step undo", async ({ browser }) => {
  const session = writer();
  const created = await session.call<StoredDoc>("create_doc", {
    title: docTitle("Retype a callout"), description: "Comment and mark preservation through label conversions.",
    blocks: [{ type: "callout", variant: "important", inline: [
      { text: "Keep", marks: { bold: true } }, { text: " this passage.", marks: {} },
    ] }],
  });
  const id = created.blocks[0]?.id;
  if (id === undefined) throw new Error("e2e: conversion callout is missing");
  await session.call("annotate", { uuid: created.uuid, block_id: id, start: 0, end: 4, text: "Keep this comment." });
  const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
    upstream: true, contextOptions: contextOptions(false),
  });
  for (const [label, tag] of [["Quote", "blockquote"], ["Paragraph", "p"]] as const) {
    await activateControl(variantControl(page));
    await activateControl(variantMenu(page).getByRole("menuitem", { name: label, exact: true }));
    const converted = editor(page).locator(`:scope > ${tag}`);
    await expect(converted).toHaveAttribute("id", id);
    await expect(converted).toHaveText("Keep this passage.");
    await expect(converted.locator("strong")).toHaveText("Keep");
    await expect(converted.locator("[data-comment-thread]")).toHaveText("Keep");
    await page.keyboard.press("ControlOrMeta+z");
    const callout = page.getByRole("note", { name: "Important", exact: true });
    await expect(callout).toHaveAttribute("id", id);
    await expect(callout.locator("strong")).toHaveText("Keep");
    await expect(callout.locator("[data-comment-thread]")).toHaveText("Keep");
  }
});

test("open emoji and document menus take Enter and Tab before callout line keys", async ({ browser }) => {
  const session = writer();
  const targetTitle = docTitle("CalloutReference").replaceAll(" ", "");
  const target = await session.call<StoredDoc>("create_doc", {
    title: targetTitle, description: "Document reference selected from a callout.",
    blocks: [{ type: "paragraph", text: "Reference target." }],
  });
  const created = await session.call<StoredDoc>("create_doc", {
    title: docTitle("Callout caret menus"), description: "Caret menus retain their keyboard priority.",
    blocks: [{ type: "callout", variant: "note", text: "Thanks " }],
  });
  const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
    upstream: true, contextOptions: contextOptions(false),
  });
  const body = page.getByRole("note", { name: "Note", exact: true }).locator(".ub-callout-body");
  await placeCaretIn(body);
  await page.keyboard.type(":smi");
  await expect(page.getByRole("listbox", { name: "Emoji and icons", exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(body).toHaveText("Thanks 😃");
  await page.keyboard.type(" :claude");
  await expect(page.getByRole("listbox", { name: "Emoji and icons", exact: true })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(body.locator('.ub-inline-icon[data-icon="claude"] svg')).toBeVisible();
  await page.keyboard.type(` @${targetTitle}`);
  const references = page.getByRole("listbox", { name: "People and documents", exact: true });
  await expect(references.getByRole("option", { name: targetTitle, exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(body.locator(`a[data-doc-id="${target.uuid}"]`)).toHaveText(targetTitle);
  await expect(body).toHaveText(`Thanks 😃 :claude: ${targetTitle}`);
  await expect(editor(page).locator(":scope > *")).toHaveCount(1);
});

test("native select-all and copy omit the caption in editable and archived prose", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer();
  const created = await session.call<StoredDoc>("create_doc", {
    title: docTitle("Chrome and prose"), description: "Caption text is excluded from document content.",
    blocks: [{ type: "paragraph", text: "Before prose." },
      { type: "callout", variant: "caution", icon: "🚀", text: "Preserved body." },
      { type: "paragraph", text: "After prose." }],
  });
  const touch = info.project.use.hasTouch === true;
  const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
    upstream: true, contextOptions: contextOptions(touch),
  });
  const frame = page.getByRole("note", { name: "Caution", exact: true });
  const caption = frame.locator(".ub-block-caption");
  expect(await caption.evaluate(element => {
    const style = getComputedStyle(element);
    return style.userSelect || style.getPropertyValue("-webkit-user-select");
  })).toBe("none");
  await expect(caption).toHaveAttribute("contenteditable", "false");
  await expect(frame.locator(".ub-callout-body")).toHaveText("Preserved body.");
  await expectMcp(() => session.call<{ hits: Array<{ uuid: string }> }>("search", { query: "Preserved" }), result => {
    expect(result.hits.some(hit => hit.uuid === created.uuid)).toBe(true);
  });
  const labelSearch = await session.call<{ hits: Array<{ uuid: string }> }>("search", { query: "Caution" });
  expect(labelSearch.hits.some(hit => hit.uuid === created.uuid)).toBe(false);
  for (const archived of [false, true]) {
    if (archived) {
      await session.call("archive_doc", { uuid: created.uuid });
      await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    } else await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await expect(variantControl(page)).toHaveCount(archived ? 0 : 1);
    const selected = await selectAll(page, frame.locator(".ub-callout-body"), touch);
    expect(selected).toContain("Preserved body.");
    expect(selected).not.toMatch(/Caution|🚀/);
    const copied = await copyText(page);
    expect(copied).toContain("Before prose.");
    expect(copied).toContain("Preserved body.");
    expect(copied).toContain("After prose.");
    expect(copied).not.toMatch(/Caution|🚀/);
    if (!archived) expect(copied).toBe("Before prose.\n\nPreserved body.\n\nAfter prose.");
  }
});

test("callout marks, inline icons, links and comments remain usable in editable, archived and disconnected read-only views", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer();
  const target = await session.call<StoredDoc>("create_doc", {
    title: docTitle("Linked destination"), description: "A document link destination.",
    blocks: [{ type: "paragraph", text: "The linked page." }],
  });
  const created = await session.call<StoredDoc>("create_doc", {
    title: docTitle("Linked passage"), description: "Inline behavior inside a callout.",
    blocks: [{ type: "callout", variant: "warning", inline: [
      { text: "Strong", marks: { bold: true } }, { text: " and ", marks: {} },
      { text: ":claude: external", marks: { link: TARGET } }, { text: " or ", marks: {} },
      { text: "related page", marks: { docLink: target.uuid } },
    ] }],
  });
  await session.call("annotate", { uuid: created.uuid, block_id: created.blocks[0]?.id,
    start: 0, end: "Strong".length, text: "Keep this passage in view." });
  const before = await session.call<StoredDoc>("get_doc", { uuid: created.uuid });
  const touch = info.project.use.hasTouch === true;
  const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
    upstream: true, contextOptions: contextOptions(touch),
  });
  await page.context().route("https://example.invalid/**", route => route.fulfill({
    contentType: "text/html", body: "<p>Callout destination</p>",
  }));
  const callout = page.getByRole("note", { name: "Warning", exact: true });
  await expect(callout.locator(".ub-callout-body strong")).toHaveText("Strong");
  await expect(callout.locator("[data-comment-thread]")).toHaveText("Strong");
  const external = callout.getByRole("link", { name: "external", exact: true });
  await expect(external.locator('.ub-inline-icon[data-icon="claude"] svg')).toBeVisible();
  const related = callout.getByRole("link", { name: "related page", exact: true });
  for (const archived of [false, true]) {
    if (archived) {
      await session.call("archive_doc", { uuid: created.uuid });
      await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    } else await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await expect(variantControl(page)).toHaveCount(archived ? 0 : 1);
    await followExternal(page, () => activateControl(external, { touch }));
    if (archived) {
      await external.focus();
      await page.keyboard.press("Tab");
      await expect(related).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(external).toBeFocused();
      await followExternal(page, () => page.keyboard.press("Enter"));
    }
    await activateControl(related, { touch });
    await expect(page).toHaveURL(new RegExp(`/${target.uuid}$`));
    await expect(editor(page)).toContainText("The linked page.");
    await page.goBack();
    await expect(callout).toBeVisible();
  }
  await session.call("restore_doc", { uuid: created.uuid });
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await harness().stopHub();
  try {
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await expect(variantControl(page)).toHaveCount(0);
    await expect(callout).toHaveAccessibleName("Warning");
    await external.focus();
    await page.keyboard.press("Tab");
    await expect(related).toBeFocused();
    await followExternal(page, () => activateControl(external, { touch }));
  } finally { await harness().startHub(); }
  await expectMcp(() => session.call<StoredDoc>("get_doc", { uuid: created.uuid }), stored => {
    expect(stored.blocks).toEqual(before.blocks);
  });
});

// History content and native link activation are intermittent in this journey.
test.fixme("split history draws each caption and keeps callout links keyboard reachable", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const title = docTitle("Compared passages");
  const created = await session.call<StoredDoc>("create_doc", {
    title, description: "Callout history retains its reading behavior.", blocks: [{ type: "paragraph", text: "Live text." }],
  });
  const earlier = randomUUID(), latest = randomUUID();
  const document = new Y.Doc();
  const states: Record<string, string> = {};
  try {
    initDoc(document, { uuid: created.uuid, title });
    const id = appendBlock(document, { type: "callout", variant: "warning", icon: "🚀", inline: [
      { text: "Keep earlier words. ", marks: {} }, { text: "external", marks: { link: TARGET } },
    ] });
    states[earlier] = Buffer.from(snapshotRevision(document).state).toString("base64");
    const block = findBlockElement(document, id);
    if (block === null) throw new Error("e2e: callout history fixture is missing");
    block.setAttribute("variant", "caution");
    block.setAttribute("icon", ":claude:");
    editBlock(document, id, "Keep earlier words. external", "Keep later words. external");
    states[latest] = Buffer.from(snapshotRevision(document).state).toString("base64");
  } finally { document.destroy(); }
  const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
    contextOptions: { viewport: { width: 1440, height: 1000 } },
  });
  await page.route("**/api/revisions?**", async route => {
    const revision = new URL(route.request().url()).searchParams.get("revision");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(revision === null ? {
      revisions: [{ id: latest, author: null, startedAt: 2_000, endedAt: null },
        { id: earlier, author: null, startedAt: 1_000, endedAt: 2_000 }],
    } : { state: states[revision] }) });
  });
  await page.context().route("https://example.invalid/**", route => route.fulfill({
    contentType: "text/html", body: "<p>Historical destination</p>",
  }));
  await activateControl(page.getByRole("group", { name: "Document history", exact: true })
    .getByRole("button", { name: "Previous revision", exact: true }));
  const before = page.locator('.ub-revision-pane .ProseMirror[aria-label="Before this revision"]');
  const after = page.locator('.ub-revision-pane .ProseMirror[aria-label="This revision"]');
  await expect(before.getByRole("button", { name: "Callout variant", exact: true })).toHaveCount(0);
  await expect(after.getByRole("button", { name: "Callout variant", exact: true })).toHaveCount(0);
  await expect(before.getByRole("note", { name: "Warning", exact: true })).toBeVisible();
  await expect(before.locator(".ub-callout-icon")).toHaveText("🚀");
  await expect(after.getByRole("note", { name: "Caution", exact: true })).toBeVisible();
  await expect(after.locator(".ub-callout-icon.ub-inline-icon svg")).toBeVisible();
  await expect(after.locator(".ub-revision-fields")).toHaveText("Changed: icon, variant");
  await expect(before.locator(".ub-revision-removed")).toHaveText("earlier");
  await expect(after.locator(".ub-revision-added")).toHaveText("later");
  for (const [side, prefix] of [[before, "Keep earlier words. "], [after, "Keep later words. "]] as const) {
    const external = side.getByRole("link", { name: "external", exact: true });
    const body = side.locator(".ub-callout-body");
    await setPointerSelection(body, () => body.click({ position: { x: 2, y: 10 } }));
    for (let step = 0; step <= prefix.length; step += 1) await page.keyboard.press("ArrowRight");
    await expect.poll(() => external.evaluate(element => {
      const selection = window.getSelection();
      return selection?.isCollapsed && element.contains(selection.anchorNode);
    })).toBe(true);
    await followExternal(page, () => page.keyboard.press("Enter"));
    await expect(side.getByRole("note")).toBeVisible();
  }
});
