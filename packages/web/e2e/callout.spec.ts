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

interface StoredDoc { uuid: string; blocks: Array<{ id: string; text: string; rev: string }> }

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
  const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta" : "Control");
  await page.keyboard.press(`${modifier}+a`);
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
  await expect(caption).toHaveCSS("user-select", "none");
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

test("split history draws each caption and keeps callout links keyboard reachable", { tag: "@webkit" }, async ({ browser }) => {
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
  await expect(before.getByRole("note", { name: "Warning", exact: true })).toBeVisible();
  await expect(before.locator(".ub-callout-icon")).toHaveText("🚀");
  await expect(after.getByRole("note", { name: "Caution", exact: true })).toBeVisible();
  await expect(after.locator(".ub-callout-icon.ub-inline-icon svg")).toBeVisible();
  await expect(after.locator(".ub-revision-fields")).toHaveText("Changed: icon, variant");
  await expect(before.locator(".ub-revision-removed")).toHaveText("earlier");
  await expect(after.locator(".ub-revision-added")).toHaveText("later");
  for (const side of [before, after]) {
    const external = side.getByRole("link", { name: "external", exact: true });
    await expect(external).toHaveAttribute("tabindex", "0");
    await external.focus();
    await followExternal(page, () => page.keyboard.press("Enter"));
    await expect(side.getByRole("note")).toBeVisible();
  }
});
