import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Browser, CDPSession, Locator, Page } from "@playwright/test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import { wrapToken } from "@uberblick/schema/protocol";
import { getBlocksFragment, roomForDoc } from "@uberblick/schema";
import * as Y from "yjs";
import { activateControl, docTitle, editor, setupHarness } from "./app-helpers.js";
import { placeCaretIn } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
const LINK = "https://figma.com/design/editing123/File-name?node-id=2-3&t=tracking";
const NORMALIZED = "https://www.figma.com/design/editing123/File-name?node-id=2-3";

interface StoredDoc { uuid: string; blocks: Array<{ id: string; type: string; text: string; rev: string }> }

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl, authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-figma-editing-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

async function fixture(browser: Browser, figma = false, touch = false): Promise<{
  page: Page; writer: McpSession; uuid: string; block: Locator;
}> {
  if (agent === null) throw new Error("e2e: MCP agent unavailable");
  const writer = agent.open({ name: "figma-editing-e2e" });
  const created = await writer.call<StoredDoc>("create_doc", {
    title: docTitle("Figma editing"), description: "Figma creation and height gestures.",
    blocks: [figma ? { type: "figma", text: `url: ${LINK}\ntitle: Initial title\nheight: 300\n\nCaption words.` }
      : { type: "paragraph", text: "" }],
  });
  const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
    upstream: true,
    contextOptions: { viewport: { width: touch ? 810 : 1440, height: 1400 }, ...(touch ? { hasTouch: true } : {}) },
    beforeNavigate: async (target) => {
      await target.route("https://embed.figma.com/**", (route) => route.fulfill({
        contentType: "text/html", body: "<html><body>Figma viewer stub</body></html>",
      }));
    },
  });
  await expect(editor(page)).toBeVisible();
  const block = page.locator(".ub-figma");
  if (figma) await expect(block.locator("iframe")).toHaveCount(1);
  return { page, writer, uuid: created.uuid, block };
}

async function stored(writer: McpSession, uuid: string): Promise<StoredDoc> {
  return writer.call<StoredDoc>("get_doc", { uuid });
}

async function paste(page: Page, text: string): Promise<void> {
  await editor(page).evaluate((element, value) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", value);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, text);
}

test("menu drafts keep field navigation local until Done and return focus to the editor", { tag: "@webkit" }, async ({ browser }, info) => {
  const { page, writer, uuid, block } = await fixture(browser, false, info.project.use.hasTouch === true);
  await placeCaretIn(editor(page).locator(":scope > p"), { touch: info.project.use.hasTouch === true });
  await page.keyboard.type("/figma");
  await page.keyboard.press("Enter");
  let field = page.getByRole("textbox", { name: "Figma link", exact: true });
  await expect(field).toBeFocused();
  await expect(block).toHaveAttribute("data-figma-draft", "true");
  expect((await stored(writer, uuid)).blocks.map((item) => item.type)).toEqual(["paragraph"]);
  await activateControl(page.getByRole("textbox", { name: "Title", exact: true }));
  await page.keyboard.type("Title first");
  await activateControl(field);
  await expect(block.getByRole("alert")).toHaveCount(0);
  await field.fill("https://figma.com/deck/refused");
  await activateControl(page.getByRole("textbox", { name: "Title", exact: true }));
  await expect(block.getByRole("alert")).toHaveCount(0);
  expect((await stored(writer, uuid)).blocks.map((item) => item.type)).toEqual(["paragraph"]);
  await activateControl(block.getByRole("button", { name: "Done", exact: true }));
  await expect(block).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  expect((await stored(writer, uuid)).blocks.map((item) => item.type)).toEqual(["paragraph"]);

  await placeCaretIn(editor(page).locator(":scope > p"), { touch: info.project.use.hasTouch === true });
  await page.keyboard.type("/figma");
  await page.keyboard.press("Enter");
  field = page.getByRole("textbox", { name: "Figma link", exact: true });
  await expect(field).toBeFocused();
  await field.fill(LINK);
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  if (info.project.use.hasTouch === true) await activateControl(title);
  else await field.press("Tab");
  await expect(title).toBeFocused();
  await page.keyboard.type("Typed title");
  const height = page.getByRole("textbox", { name: "Height", exact: true });
  if (info.project.use.hasTouch === true) await activateControl(height);
  else await title.press("Tab");
  await expect(height).toBeFocused();
  await page.keyboard.type("600");
  await expect(block).toHaveAttribute("data-figma-draft", "true");
  expect((await stored(writer, uuid)).blocks.map((item) => item.type)).toEqual(["paragraph"]);
  await activateControl(block.getByRole("button", { name: "Done", exact: true }));
  await expect(block).not.toHaveAttribute("data-figma-draft", "true");
  await expect(editor(page)).toBeFocused();
  await expect(block.locator("iframe")).toHaveCount(1);
  await expect.poll(async () => (await stored(writer, uuid)).blocks[0]?.text).toBe(`url: ${NORMALIZED}\ntitle: Typed title\nheight: 600\n\n`);
});

test("bare accepted paste converts with a link undo step, while inline and refused links stay links", { tag: "@webkit" }, async ({ browser }, info) => {
  const { page, writer, uuid, block } = await fixture(browser, false, info.project.use.hasTouch === true);
  const paragraph = editor(page).locator(":scope > p");
  await placeCaretIn(paragraph, { touch: info.project.use.hasTouch === true });
  await paste(page, LINK);
  await expect(block.locator("iframe")).toHaveCount(1);
  await expect.poll(async () => (await stored(writer, uuid)).blocks[0]?.type).toBe("figma");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(block).toHaveCount(0);
  await expect(paragraph.locator("a")).toHaveText(LINK);
  await expect.poll(async () => (await stored(writer, uuid)).blocks[0]?.type).toBe("paragraph");

  await page.keyboard.press("ControlOrMeta+z");
  await expect(paragraph).toHaveText("");
  await placeCaretIn(paragraph, { touch: info.project.use.hasTouch === true });
  await page.keyboard.type("Inside text: ");
  await paste(page, LINK);
  await expect(block).toHaveCount(0);
  await expect(paragraph.locator("a")).toHaveText(LINK);
  await placeCaretIn(paragraph, { touch: info.project.use.hasTouch === true });
  await page.keyboard.press("Enter");
  await expect(editor(page).locator(":scope > p")).toHaveCount(2);
  const refusedParagraph = editor(page).locator(":scope > p").last();
  await expect(refusedParagraph).toHaveText("");
  await paste(page, "https://figma.com/deck/refused");
  await expect(block).toHaveCount(0);
  await expect(refusedParagraph.locator("a")).toHaveText("https://figma.com/deck/refused");
});

test("Edit validates fields and keeps the same hidden viewer through title and height changes", { tag: "@webkit" }, async ({ browser }, info) => {
  const { writer, uuid, block } = await fixture(browser, true, info.project.use.hasTouch === true);
  await block.locator("iframe").evaluate((frame) => { frame.dataset.identity = "existing-viewer"; });
  const before = (await stored(writer, uuid)).blocks[0];
  if (before === undefined) throw new Error("e2e: stored Figma block missing");
  await activateControl(block.getByRole("button", { name: "Edit", exact: true }));
  const link = block.getByRole("textbox", { name: "Figma link", exact: true });
  const title = block.getByRole("textbox", { name: "Title", exact: true });
  const height = block.getByRole("textbox", { name: "Height", exact: true });
  await expect(link).toBeFocused();
  await expect(block.locator("iframe")).toBeHidden();
  await link.fill("https://figma.com/deck/refused");
  await activateControl(title);
  await expect(block.getByRole("alert")).toContainText("Figma links must use /design/");
  expect((await stored(writer, uuid)).blocks[0]?.rev).toBe(before.rev);
  await link.fill(NORMALIZED);
  await activateControl(title);
  await title.fill("Changed title");
  await activateControl(height);
  await expect.poll(async () => (await stored(writer, uuid)).blocks[0]?.text).toContain("title: Changed title");
  await height.fill("239");
  await activateControl(title);
  await expect(block.getByRole("alert")).toHaveText("Height must be a whole number of pixels from 240 to 960");
  expect((await stored(writer, uuid)).blocks[0]?.text).toContain("height: 300");
  await height.fill("");
  await activateControl(title);
  await expect.poll(async () => (await stored(writer, uuid)).blocks[0]?.text).not.toContain("height:");
  await title.fill("");
  await activateControl(block.getByRole("button", { name: "Done", exact: true }));
  await expect(link).toHaveCount(0);
  await expect(block.locator("iframe")).toBeVisible();
  await expect(block.locator("iframe")).toHaveAttribute("data-identity", "existing-viewer");
  await expect(block.locator(".ub-figma-viewer")).toHaveCSS("height", "480px");
  await expect.poll(async () => (await stored(writer, uuid)).blocks[0]?.text).not.toContain("title:");
});

async function watchHeight(uuid: string): Promise<{ values: string[]; close: () => void }> {
  const doc = new Y.Doc();
  const secret = await importRootSecret(harness().authSecret);
  const provider = new HocuspocusProvider({
    url: harness().hubUrl, name: roomForDoc(harness().workspaceUuid, uuid), document: doc,
    token: async () => wrapToken(await mintToken(secret, {
      typ: "room", sub: randomUUID(), workspace: harness().workspaceUuid,
      scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    })),
  });
  try {
    await new Promise<void>((resolve) => provider.on("synced", resolve));
    const block = getBlocksFragment(doc).get(0);
    if (!(block instanceof Y.XmlElement)) throw new Error("e2e: Figma block missing");
    const values: string[] = [];
    block.observe((event) => { if (event.attributesChanged.has("height")) values.push(block.getAttribute("height") ?? ""); });
    return { values, close: () => { provider.destroy(); doc.destroy(); } };
  } catch (error) { provider.destroy(); doc.destroy(); throw error; }
}

async function point(handle: Locator): Promise<{ x: number; y: number }> {
  await handle.scrollIntoViewIfNeeded();
  const bounds = await handle.boundingBox();
  if (bounds === null) throw new Error("e2e: Figma handle has no geometry");
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

async function mouseDrag(page: Page, handle: Locator, delta: number, cancel = false): Promise<void> {
  const start = await point(handle);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + delta, { steps: 10 });
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}

test("mouse height drags keep their preview through peer edits, commit once, clamp bounds, and Escape stores nothing", async ({ browser }) => {
  const { page, writer, uuid, block } = await fixture(browser, true);
  const watch = await watchHeight(uuid);
  try {
    const handle = block.locator(".ub-figma-resize");
    const initial = (await stored(writer, uuid)).blocks[0];
    if (initial === undefined) throw new Error("e2e: stored Figma block missing");
    const start = await point(handle);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y + 80, { steps: 10 });
    const viewer = block.locator(".ub-figma-viewer");
    await expect.poll(() => viewer.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(300);
    await writer.call("edit_block", {
      uuid, block_id: initial.id, old_text: initial.text,
      new_text: initial.text.replace("Caption words.", "A peer edited this caption."), rev: initial.rev,
    });
    await expect(block.locator(".ub-figma-caption")).toContainText("A peer edited this caption.");
    await expect.poll(() => viewer.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(300);
    expect(watch.values).toEqual([]);
    await page.mouse.up();
    await expect.poll(() => watch.values).toEqual(["380"]);
    await expect(block.locator(".ub-figma-viewer")).toHaveCSS("height", "380px");
    await mouseDrag(page, handle, 50, true);
    await expect(block.locator(".ub-figma-viewer")).toHaveCSS("height", "380px");
    expect(watch.values).toEqual(["380"]);
    await mouseDrag(page, handle, 1100);
    await expect.poll(() => watch.values).toEqual(["380", "960"]);
    await mouseDrag(page, handle, -1100);
    await expect.poll(() => watch.values).toEqual(["380", "960", "240"]);
    await expect(block.locator(".ub-figma-viewer")).toHaveCSS("height", "240px");
  } finally { watch.close(); }
});

async function touchDrag(session: CDPSession, handle: Locator, delta: number, cancel = false): Promise<void> {
  const start = await point(handle);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1 }] });
  for (let step = 1; step <= 10; step += 1) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x, y: start.y + delta * step / 10, id: 1 }] });
  }
  await session.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
}

test("iPad touch height drags commit once and browser cancellation restores stored height", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "Native touch sequences use Chromium's browser protocol");
  const { page, uuid, block } = await fixture(browser, true, true);
  const watch = await watchHeight(uuid);
  const session = await page.context().newCDPSession(page);
  try {
    const handle = block.locator(".ub-figma-resize");
    await touchDrag(session, handle, 100);
    await expect.poll(() => watch.values).toEqual(["400"]);
    await touchDrag(session, handle, 80, true);
    await expect(block.locator(".ub-figma-viewer")).toHaveCSS("height", "400px");
    expect(watch.values).toEqual(["400"]);
    await touchDrag(session, handle, 1100);
    await expect.poll(() => watch.values).toEqual(["400", "960"]);
    await touchDrag(session, handle, -1100);
    await expect.poll(() => watch.values).toEqual(["400", "960", "240"]);
  } finally {
    try { await session.detach(); } finally { watch.close(); }
  }
});
