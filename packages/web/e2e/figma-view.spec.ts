/** The production node view keeps browser-owned viewers through ordinary shared edits. */
import { devices, expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { FIGMA_PROVIDER, createAnnotation, findBlockElement, roomForDoc } from "@uberblick/schema";
import { wrapToken } from "@uberblick/schema/protocol";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import * as Y from "yjs";
import { closeIfOpen, docTitle, editor, setupHarness } from "./app-helpers.js";
import { renderedText } from "./contrast-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { setNativeSelection } from "./native-selection.js";
import { mockFigmaLookup } from "./figma-fixtures.js";
import { expectMcp } from "./settle.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl, authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-figma-view-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

interface Block { id: string; type: string; text: string; rev: string }
interface StoredDoc {
  uuid: string; blocks: Block[];
  annotations: Array<{ id: string; range: { part?: string; start: number; end: number } | null; comments: Array<{ text: string }> }>;
}
const LINK = "https://www.figma.com/design/k3Lm9QzT2x/Checkout-flow?node-id=12-345";
const CAPTION = "A marked design reference.";
const STUB = '<!doctype html><style>html,body,button{margin:0;width:100%;height:100%}</style><button id="canvas">Synthetic Figma canvas</button><script>window.canvasClicks=0;document.querySelector("button").onclick=()=>window.canvasClicks++;addEventListener("wheel",event=>event.preventDefault(),{passive:false});</script>';

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: Figma writer is missing");
  return agent.open({ name: "figma-view-e2e" });
}

function source(key = "k3Lm9QzT2x", height = 240, title = "Payment, mobile"): string {
  return `url: ${LINK.replace("k3Lm9QzT2x", key)}\ntitle: ${title}\nheight: ${height}\n\n${CAPTION}`;
}

async function create(session: McpSession, blocks = [
  { type: "paragraph", text: "Context before the design." }, { type: "figma", text: source() },
  { type: "paragraph", text: "Context after the design." },
]): Promise<StoredDoc> {
  return session.call<StoredDoc>("create_doc", {
    title: docTitle("Figma browser proof"), description: "Synthetic browser-only Figma viewer proof.", blocks,
  });
}

async function open(browser: Browser, uuid: string, navigations: string[], options: { touch?: boolean; appearance?: "light" | "dark"; offline?: boolean; fullscreen?: boolean } = {}): Promise<Page> {
  const touch = options.touch ?? false;
  return openApp(browser, `/${harness().workspace}/${uuid}`, {
    upstream: true,
    contextOptions: { ...(touch ? devices["iPad (gen 7)"] : { viewport: { width: 1366, height: 1000 }, hasTouch: false, isMobile: false }),
      ...(options.fullscreen ? { isMobile: false } : {}), colorScheme: options.appearance ?? "light" },
    beforeNavigate: async (page) => {
      await mockFigmaLookup(page);
      await page.route("https://embed.figma.com/**", async (route) => {
        navigations.push(route.request().url());
        expect((await route.request().allHeaders()).referer).toBeUndefined();
        await route.fulfill({ contentType: "text/html", body: STUB });
      });
      if (options.offline) await page.addInitScript(() => {
        Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
      });
    },
  });
}

async function unchanged(frame: Locator, identity: Awaited<ReturnType<Locator["elementHandle"]>>, navigations: string[], expected = 1): Promise<void> {
  await expect(frame.locator("iframe")).toHaveCount(1);
  await expect(frame.locator("iframe").contentFrame().locator("#canvas")).toBeAttached();
  await settle(frame);
  expect(identity).not.toBeNull();
  expect(await identity?.evaluate((element) => element.isConnected), JSON.stringify(navigations)).toBe(true);
  expect(navigations).toHaveLength(expected);
}

async function settle(frame: Locator): Promise<void> {
  await frame.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }));
}

async function editBlock(session: McpSession, uuid: string, id: string, change: (before: string) => string): Promise<void> {
  const current = await session.call<StoredDoc>("get_doc", { uuid });
  const block = current.blocks.find((candidate) => candidate.id === id);
  if (block === undefined) throw new Error("e2e: Figma edit target is missing");
  await session.call("edit_block", { uuid, block_id: id, old_text: block.text, new_text: change(block.text), rev: block.rev });
}

async function token(target: Locator, name: string): Promise<string> {
  return target.evaluate((element, variable) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${variable})`;
    element.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);
}

for (const appearance of ["light", "dark"] as const) {
  test(`Figma is one rounded surface with prose caption and neutral active ring — ${appearance}`, { tag: "@webkit" }, async ({ browser }, info) => {
    const created = await create(writer());
    const navigations: string[] = [];
    const page = await open(browser, created.uuid, navigations, { appearance });
    const frame = page.locator(".ub-figma");
    const iframe = frame.locator("iframe");
    await expect(iframe).toHaveAttribute("src", FIGMA_PROVIDER.embedAddress(LINK, appearance));
    await expect(iframe).toHaveAttribute("title", "Payment, mobile");
    for (const [name, value] of Object.entries(FIGMA_PROVIDER.frameAttributes)) await expect(iframe).toHaveAttribute(name, value);
    const attributes = await iframe.evaluate((element) => element.getAttributeNames().sort());
    expect(attributes).toEqual(["allow", "allowfullscreen", "referrerpolicy", "sandbox", "src", "tabindex", "title"]);
    await expect(frame).not.toHaveClass(/ub-block-frame/);
    await expect(frame.locator(".ub-block-caption, .ub-block-label")).toHaveCount(0);
    await expect(frame).toHaveCSS("border-left-width", "0px");
    await expect(frame).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const surface = frame.locator(".ub-figma-viewer");
    await expect(surface).toHaveCSS("overflow", "hidden");
    expect(await surface.evaluate((element) => getComputedStyle(element).borderRadius)).not.toBe("0px");
    const geometry = await surface.evaluate((element) => ({ width: element.getBoundingClientRect().width, column: element.closest(".ProseMirror")?.getBoundingClientRect().width }));
    expect(geometry.width).toBeCloseTo(geometry.column ?? 0, 0);
    const readings = await renderedText(page, ".ub-figma-caption");
    expect(readings.length).toBeGreaterThan(0);
    for (const reading of readings) expect(reading.ratio, JSON.stringify(reading)).toBeGreaterThanOrEqual(4.5);
    const shield = frame.locator(".ub-figma-shield");
    const toolbar = frame.locator(".ub-figure-toolbar");
    await editor(page).locator(":scope > p").first().click();
    await expect(toolbar).toHaveCSS("opacity", "0");
    await shield.hover();
    await expect(toolbar).toHaveCSS("opacity", "1");
    await editor(page).locator(":scope > p").first().hover();
    await expect(toolbar).toHaveCSS("opacity", "0");
    await shield.focus();
    await expect(toolbar).toHaveCSS("opacity", "1");
    await page.keyboard.press("Enter");
    await expect(frame).toHaveAttribute("data-figma-active", "true");
    const ring = await surface.evaluate((element) => getComputedStyle(element).boxShadow);
    expect(ring).toContain(await token(frame, "--ring"));
    expect(ring).toContain("0px 0px 0px 2px");
    expect(ring).not.toContain(await token(frame, "--brand"));
    const action = frame.getByRole("link", { name: "Open in Figma", exact: true });
    await expect(action).toHaveAttribute("href", LINK);
    await expect(action).toHaveAttribute("target", "_blank");
    await expect(action).toHaveAttribute("rel", "noopener noreferrer");
    await expect(action).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(frame.getByRole("button", { name: "Done", exact: true })).toBeVisible();
    await frame.getByRole("button", { name: "Done", exact: true }).click();
    await expect(shield).toBeVisible();
    const path = info.outputPath(`figma-${appearance}.png`);
    await frame.screenshot({ path });
    await info.attach(`figma-${appearance}`, { path, contentType: "image/png" });
    expect(navigations).toHaveLength(1);
  });
}

test("the shield passes wheel scrolling to the document and requires a click before the canvas receives one", async ({ browser }) => {
  const session = writer();
  const created = await create(session, [
    { type: "figma", text: source("shield", 480) },
    ...Array.from({ length: 30 }, (_, index) => ({ type: "paragraph", text: `Page scrolling context ${index}.` })),
  ]);
  const page = await open(browser, created.uuid, []);
  const frame = page.locator(".ub-figma");
  const shield = frame.locator(".ub-figma-shield");
  await expect(shield).toBeVisible();
  const pane = page.locator("section.ub-document-pane");
  const before = await pane.evaluate((element) => element.scrollTop);
  await shield.hover();
  await page.mouse.wheel(0, 120);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
  await pane.evaluate((element) => { element.scrollTop = 0; });
  await shield.click();
  await expect(shield).toBeHidden();
  const canvas = page.frameLocator(".ub-figma iframe").locator("#canvas");
  expect(await canvas.evaluate(() => (window as unknown as { canvasClicks: number }).canvasClicks)).toBe(0);
  await canvas.click();
  expect(await canvas.evaluate(() => (window as unknown as { canvasClicks: number }).canvasClicks)).toBe(1);
  await editor(page).locator(":scope > p").first().click();
  await expect(shield).toBeVisible();
});

test("Done, fullscreen Close, toolbar and Tab leave a safe Figma focus target that cannot edit the document", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const created = await create(session);
  const page = await open(browser, created.uuid, [], { fullscreen: true });
  const frame = page.locator(".ub-figma");
  const preview = frame.getByRole("button", { name: "Interact with Figma preview", exact: true });
  await expect(frame.locator("iframe").contentFrame().locator("#canvas")).toBeAttached();
  const documentBefore = await editor(page).evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.state.doc.toJSON());
  // create_doc names blocks by id and rev; an unchanged rev means unchanged content.
  const storedBefore = created.blocks.map(({ id, rev }) => ({ id, rev }));
  for (const entry of ["Done", "Close", "Toolbar", "Tab"] as const) {
    const focused = entry === "Toolbar" ? frame.getByRole("link", { name: "Open in Figma", exact: true }) : preview;
    await editor(page).locator(":scope > p").first().click();
    await page.keyboard.press("End");
    if (entry === "Done") {
      await frame.locator(".ub-figma-shield").click();
      await frame.getByRole("button", { name: "Done", exact: true }).click();
    } else if (entry === "Close") {
      await frame.getByRole("button", { name: "Expand", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(frame.locator(".ub-figure-viewer-bar")).toBeVisible();
      await frame.getByRole("button", { name: "Close Figma viewer", exact: true }).click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    } else if (entry === "Toolbar") await focused.focus();
    else await page.keyboard.press("Tab");
    await expect(focused, entry).toBeFocused();
    for (const key of ["Backspace", "Delete", "W"]) {
      await page.keyboard.press(key);
      await settle(frame);
      expect(await editor(page).evaluate((element) => (element as HTMLElement & { editor: Editor }).editor.state.doc.toJSON()), `${entry}: ${key}`).toEqual(documentBefore);
      await expect(focused, `${entry}: ${key}`).toBeFocused();
    }
    await expectMcp(() => session.call<StoredDoc>("get_doc", { uuid: created.uuid }), (stored) => {
      expect(stored.blocks.map(({ id, rev }) => ({ id, rev })), entry).toEqual(storedBefore);
    });
  }
});

test("a stored multiline caption renders its line break below the preview", { tag: "@webkit" }, async ({ browser }) => {
  const created = await create(writer(), [{ type: "figma", text: source().replace(CAPTION, "Line one\nLine two") }]);
  const page = await open(browser, created.uuid, []);
  const caption = page.locator(".ub-figma-caption p");
  await expect(caption).toBeVisible();
  expect(await caption.innerText()).toBe("Line one\nLine two");
  const lines = await caption.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
  expect(lines).toBe(2);
});

test("editing a multiline caption preserves stored, Enter and pasted breaks with its marks and comment anchors", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer();
  const created = await create(session, [{ type: "figma", text: source().replace(CAPTION, "**Line one**\n*Line two*") }]);
  const block = created.blocks[0];
  if (block === undefined) throw new Error("e2e: multiline caption block is missing");
  const doc = new Y.Doc();
  const secret = await importRootSecret(harness().authSecret);
  const provider = new HocuspocusProvider({
    url: harness().hubUrl, name: roomForDoc(harness().workspaceUuid, created.uuid), document: doc,
    token: async () => wrapToken(await mintToken(secret, {
      typ: "room", sub: randomUUID(), workspace: harness().workspaceUuid,
      scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    })),
  });
  try {
    await expect.poll(() => findBlockElement(doc, block.id)).not.toBeNull();
    const first = createAnnotation(doc, block.id, 1, 4, "Reader", "First caption line.", { part: "caption" });
    const second = createAnnotation(doc, block.id, 10, 13, "Reader", "Second caption line.", { part: "caption" });
    await expect.poll(async () => (await session.call<StoredDoc>("get_doc", { uuid: created.uuid })).annotations.length).toBe(2);
    const touch = info.project.use.hasTouch === true;
    const page = await open(browser, created.uuid, [], { touch });
    const caption = page.locator(".ub-figma-caption p");
    if (touch) await caption.tap();
    else await caption.click();
    const caret = async (offset: number): Promise<void> => setNativeSelection(caption, () => caption.evaluate((element, offset) => {
      const root = element.closest(".ProseMirror") as HTMLElement & { editor: Editor };
      root.editor.view.focus();
      const position = root.editor.view.posAtDOM(element, 0) + offset;
      const point = root.editor.view.domAtPos(position);
      const range = document.createRange();
      range.setStart(point.node, point.offset);
      range.collapse(true);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return { anchor: position, head: position };
    }, offset));
    const typeAt = async (offset: number, text: string, expected: string): Promise<void> => {
      await caret(offset);
      await page.keyboard.type(text);
      await expect.poll(() => caption.textContent()).toBe(expected);
    };
    await typeAt(0, "First: ", "First: Line one\nLine two");
    await typeAt("First: Line one".length, ".", "First: Line one.\nLine two");
    await typeAt("First: Line one.\n".length, "Second: ", "First: Line one.\nSecond: Line two");
    await typeAt("First: Line one.\nSecond: Line two".length, ".", "First: Line one.\nSecond: Line two.");
    await caret("First: Line one.\nSecond:".length);
    await page.keyboard.press("Enter");
    await page.keyboard.type("New line");
    await expect.poll(() => caption.textContent()).toBe("First: Line one.\nSecond:\nNew line Line two.");
    await editor(page).evaluate((element) => {
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", "\r\nPasted one\r\nPasted two");
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
    });
    await page.keyboard.type("!");
    const plain = "First: Line one.\nSecond:\nNew line\nPasted one\nPasted two! Line two.";
    await expect.poll(() => caption.textContent()).toBe(plain);
    expect((await caption.locator("strong").allTextContents()).join("")).toBe("First: Line one.");
    expect((await caption.locator("em").allTextContents()).join("")).toBe("Line two.");
    for (const thread of [first, second]) await expect(caption.locator(`[data-comment-thread="${thread.id}"]`)).toHaveText("ine");
    await expectMcp(() => session.call<StoredDoc>("get_doc", { uuid: created.uuid }), (stored) => {
      expect(stored.blocks[0]?.text).toBe(source().replace(CAPTION, "**First: Line one.**\nSecond:\nNew line\nPasted one\nPasted two! *Line two.*"));
      for (const [thread, line] of [[first, "Line one"], [second, "Line two"]] as const) {
        expect(stored.annotations.find((annotation) => annotation.id === thread.id)?.range)
          .toEqual(expect.objectContaining({ part: "caption", start: plain.indexOf(line) + 1, end: plain.indexOf(line) + 4 }));
      }
    });
  } finally { provider.destroy(); doc.destroy(); }
});

test("caption, local and remote text, undo, fields and theme preserve both clients' viewers; a changed link reloads once", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const created = await create(session);
  // The default fixture's Figma block is the second one.
  const id = created.blocks[1]?.id;
  if (id === undefined) throw new Error("e2e: Figma fixture has no id");
  const visits: [string[], string[]] = [[], []];
  const page = await open(browser, created.uuid, visits[0]);
  const remote = await open(browser, created.uuid, visits[1]);
  const frames = [page.locator(".ub-figma"), remote.locator(".ub-figma")] as const;
  await expect(frames[0].locator("iframe")).toHaveCount(1);
  await expect(frames[1].locator("iframe")).toHaveCount(1);
  const identities = [await frames[0].locator("iframe").elementHandle(), await frames[1].locator("iframe").elementHandle()] as const;
  const stable = async (): Promise<void> => {
    for (const index of [0, 1] as const) await unchanged(frames[index], identities[index], visits[index]);
  };
  const caption = frames[0].locator(".ub-figma-caption p");
  await caption.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" Local caption.");
  await expect(frames[1].locator(".ub-figma-caption")).toContainText("Local caption.");
  await stable();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(frames[1].locator(".ub-figma-caption")).not.toContainText("Local caption.");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(frames[1].locator(".ub-figma-caption")).toContainText("Local caption.");
  await stable();
  await remote.locator(".ub-figma-caption p").click();
  await remote.keyboard.press("End");
  await remote.keyboard.insertText(" Remote caption.");
  await expect(caption).toContainText("Remote caption.");
  await stable();
  const context = editor(page).locator(":scope > p").first();
  await context.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" Ordinary edit.");
  await expect(editor(remote).locator(":scope > p").first()).toContainText("Ordinary edit.");
  await stable();
  await editBlock(session, created.uuid, id, (text) => text.replace("Payment, mobile", "MCP title").replace("height: 240", "height: 300").replace(CAPTION, "MCP caption."));
  await expect(frames[0].locator("iframe")).toHaveAttribute("title", "MCP title");
  await expect(frames[1].locator(".ub-figma-caption")).toContainText("MCP caption.");
  await stable();
  await frames[0].getByRole("button", { name: "Edit", exact: true }).focus();
  await frames[0].getByRole("button", { name: "Edit", exact: true }).click();
  await expect(frames[0].getByLabel("Figma link", { exact: true })).toBeFocused();
  await expect(frames[0].getByRole("button", { name: "Expand", exact: true })).toBeDisabled();
  await stable();
  await frames[0].getByLabel("Title", { exact: true }).fill("Edited title");
  await frames[0].getByLabel("Height", { exact: true }).fill("360");
  await frames[0].getByRole("button", { name: "Done", exact: true }).first().click();
  await expect(frames[0].locator("iframe")).toHaveAttribute("title", "Edited title");
  await expect(frames[0].locator(".ub-figma-viewer")).toHaveCSS("height", "360px");
  await expect(frames[1].locator("iframe")).toHaveAttribute("title", "Edited title");
  await stable();
  await page.emulateMedia({ colorScheme: "dark" });
  await remote.emulateMedia({ colorScheme: "dark" });
  await stable();
  await expect(frames[0].locator("iframe")).toHaveAttribute("src", /theme=light/);
  await frames[0].getByRole("button", { name: "Edit", exact: true }).focus();
  await frames[0].getByRole("button", { name: "Edit", exact: true }).click();
  await frames[0].getByLabel("Figma link", { exact: true }).fill(LINK.replace("12-345", "12-401"));
  await frames[0].getByRole("button", { name: "Done", exact: true }).first().click();
  for (const index of [0, 1] as const) {
    await expect(frames[index].locator("iframe")).toHaveAttribute("src", /node-id=12-401/);
    await expect.poll(() => visits[index].length).toBe(2);
  }
});

for (const touch of [false, true]) {
  test(`a refused fullscreen request keeps the preview and exposes working fallback actions — ${touch ? "touch" : "pointer"}`, { tag: "@webkit" }, async ({ browser }) => {
    const created = await create(writer());
    const visits: string[] = [];
    const page = await open(browser, created.uuid, visits, { touch, fullscreen: true });
    const frame = page.locator(".ub-figma");
    const identity = await frame.locator("iframe").elementHandle();
    const before = await page.evaluate(() => ({ state: history.state, length: history.length }));
    await frame.evaluate((element) => {
      element.requestFullscreen = () => Promise.reject(new Error("Fullscreen refused"));
    });
    if (touch) {
      await expect(frame.locator(".ub-figure-toolbar")).toBeHidden();
      await frame.locator(".ub-figma-shield").tap();
    } else {
      await frame.getByRole("button", { name: "Expand", exact: true }).focus();
      await frame.getByRole("button", { name: "Expand", exact: true }).click();
    }
    const notice = page.locator("[data-sonner-toast]:not([data-removed=true])");
    await expect(notice).toContainText("Couldn't open fullscreen. Use Open in Figma instead.");
    await expect(notice).toHaveAttribute("data-type", "error");
    const fallback = frame.getByRole("link", { name: "Open in Figma", exact: true });
    await expect(fallback).toBeVisible();
    await page.context().route(LINK, (route) => route.fulfill({ contentType: "text/html", body: "Figma external link." }));
    const opened = page.context().waitForEvent("page");
    if (touch) await fallback.tap();
    else await fallback.click();
    const popup = await opened;
    try { await expect(popup).toHaveURL(LINK); }
    finally { await popup.close(); }
    await page.bringToFront();
    expect(await page.evaluate(() => ({ state: history.state, length: history.length }))).toEqual(before);
    await unchanged(frame, identity, visits);
    const edit = frame.getByRole("button", { name: "Edit", exact: true });
    await expect(edit).toBeVisible();
    if (touch) await edit.tap();
    else await edit.click();
    await expect(frame.getByLabel("Figma link", { exact: true })).toBeFocused();
  });
}

test("fullscreen close, browser exit and Back retain history state, focus and the loaded preview", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const previous = await create(session);
  const created = await create(session);
  const visits: string[] = [];
  const page = await open(browser, previous.uuid, visits, { fullscreen: true });
  await expect(page.frameLocator(".ub-figma iframe").locator("#canvas")).toBeAttached();
  await page.goto(new URL(`/${harness().workspace}/${created.uuid}`, page.url()).href);
  const frame = page.locator(".ub-figma");
  await expect(frame.locator("iframe").contentFrame().locator("#canvas")).toBeAttached();
  await expect(frame.locator("iframe")).toHaveCount(1);
  const identity = await frame.locator("iframe").elementHandle();
  const articleIdentity = await frame.elementHandle();
  await page.evaluate(() => history.replaceState({ ...history.state, figmaTest: "retain document state" }, ""));
  const before = await page.evaluate(() => history.state);
  const navigations = visits.length;
  for (const close of ["browser", "escape", "button", "back"] as const) {
    await frame.getByRole("button", { name: "Expand", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => frame.evaluate((element) => document.fullscreenElement === element)).toBe(true);
    const bar = frame.locator(".ub-figure-viewer-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("Payment, mobile");
    await expect(bar.getByRole("link", { name: "Open in Figma", exact: true })).toHaveAttribute("href", LINK);
    await expect(bar.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
    await unchanged(frame, identity, visits, navigations);
    expect(await articleIdentity?.evaluate((element) => element.isConnected)).toBe(true);
    if (close === "browser") await page.evaluate(() => document.exitFullscreen());
    else if (close === "escape") {
      // WebKit handles Escape before DOM events; headless Chromium needs the API.
      if (browser.browserType().name() === "webkit") await page.keyboard.press("Escape");
      else await page.evaluate(() => document.exitFullscreen());
    } else if (close === "button") await bar.getByRole("button", { name: "Close Figma viewer", exact: true }).click();
    else await page.goBack();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await expect(frame.locator(".ub-figma-shield")).toBeFocused();
    await expect.poll(() => page.evaluate(() => history.state)).toEqual(before);
    await unchanged(frame, identity, visits, navigations);
    expect(await articleIdentity?.evaluate((element) => element.isConnected)).toBe(true);
  }
  await frame.getByRole("button", { name: "Expand", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(frame.locator(".ub-figure-viewer-bar")).toBeVisible();
  await frame.locator(".ub-figure-viewer-bar").getByRole("button", { name: "Edit", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(frame.getByLabel("Figma link", { exact: true })).toBeFocused();
  await expect.poll(() => page.evaluate(() => history.state)).toEqual(before);
  await frame.getByRole("button", { name: "Done", exact: true }).first().click();
  await unchanged(frame, identity, visits, navigations);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/${previous.uuid}$`));
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/${created.uuid}$`));
  await expect(page.locator(".ub-figma iframe")).toHaveCount(1);
});

test("iPad taps open a live fullscreen preview, while placeholders retain reachable actions", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const created = await create(session);
  const visits: string[] = [];
  const page = await open(browser, created.uuid, visits, { touch: true, fullscreen: true });
  const frame = page.locator(".ub-figma");
  const shield = frame.locator(".ub-figma-shield");
  await expect(shield).toBeVisible();
  await expect(frame.locator(".ub-figure-toolbar")).toBeHidden();
  await expect(frame.locator(".ub-figma-resize")).toBeHidden();
  const widths = await frame.evaluate((element) => ({ block: element.getBoundingClientRect().width, column: element.closest(".ProseMirror")?.getBoundingClientRect().width }));
  expect(widths.block).toBeCloseTo(widths.column ?? 0, 0);
  const identity = await frame.locator("iframe").elementHandle();
  await shield.tap();
  await expect.poll(() => frame.evaluate((element) => document.fullscreenElement === element)).toBe(true);
  await expect(shield).toBeHidden();
  await expect(frame).toHaveAttribute("data-figma-active", "true");
  const bar = frame.locator(".ub-figure-viewer-bar");
  await expect(bar).toContainText("Payment, mobile");
  for (const button of await bar.getByRole("button").all()) {
    const bounds = await button.boundingBox();
    expect(bounds?.width).toBeGreaterThanOrEqual(44);
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
  }
  await bar.getByRole("button", { name: "Close Figma viewer", exact: true }).tap();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(frame.locator(".ub-figma-shield")).toBeFocused();
  await expect(shield).toBeVisible();
  await unchanged(frame, identity, visits);
  await page.keyboard.press("Enter");
  await expect.poll(() => frame.evaluate((element) => document.fullscreenElement === element)).toBe(true);
  await expect(frame).toHaveAttribute("data-figma-active", "true");
  await expect(shield).toBeHidden();
  await bar.getByRole("button", { name: "Close Figma viewer", exact: true }).tap();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(frame.locator(".ub-figma-shield")).toBeFocused();
  await expect(shield).toBeVisible();
  await unchanged(frame, identity, visits);

  const offline = await open(browser, created.uuid, [], { touch: true, offline: true });
  const placeholder = offline.locator(".ub-figma");
  await expect(placeholder.locator(".ub-figma-placeholder-title")).toHaveText("Payment, mobile");
  await expect(placeholder.getByRole("button", { name: "Expand", exact: true })).toBeHidden();
  await expect(placeholder.getByRole("link", { name: "Open in Figma", exact: true })).toBeVisible();
  await placeholder.getByRole("button", { name: "Edit", exact: true }).tap();
  await expect(placeholder.getByLabel("Figma link", { exact: true })).toBeFocused();
  await placeholder.getByRole("button", { name: "Done", exact: true }).first().tap();
  await session.call("archive_doc", { uuid: created.uuid });
  await expect(editor(offline)).toHaveAttribute("contenteditable", "false");
  await expect(placeholder.getByRole("button", { name: "Edit", exact: true })).toBeHidden();
  await expect(placeholder.getByRole("link", { name: "Open in Figma", exact: true })).toBeVisible();
});

test("a touch swipe across the inline preview scrolls the document without entering Figma", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "Native swipe sequences use Chromium's browser protocol");
  const created = await create(writer(), [
    { type: "figma", text: source("swipe", 480) },
    ...Array.from({ length: 30 }, (_, index) => ({ type: "paragraph", text: `Page scrolling context ${index}.` })),
  ]);
  const page = await open(browser, created.uuid, [], { touch: true, fullscreen: true });
  const frame = page.locator(".ub-figma");
  const shield = frame.locator(".ub-figma-shield");
  await expect(shield).toBeVisible();
  const bounds = await shield.boundingBox();
  if (bounds === null) throw new Error("e2e: touch preview geometry is missing");
  const pane = page.locator("section.ub-document-pane");
  const before = await pane.evaluate((element) => element.scrollTop);
  const session = await page.context().newCDPSession(page);
  try {
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height * 0.8, id: 1 };
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    for (let step = 1; step <= 10; step += 1) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y - step * 20 }] });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect(frame).toHaveAttribute("data-figma-active", "false");
    await expect(shield).toBeVisible();
  } finally { await session.detach(); }
});

test("the nested document scroller loads at most three nearby viewers and releases distant ones", async ({ browser }) => {
  const created = await create(writer(), [
    ...Array.from({ length: 4 }, (_, index) => ({ type: "figma", text: source(`budget${index}`) })),
    { type: "code", text: Array.from({ length: 100 }, (_, index) => `Separation line ${index + 1}`).join("\n") },
    { type: "figma", text: source("distant") },
  ]);
  const visits: string[] = [];
  const page = await open(browser, created.uuid, visits);
  const frames = page.locator(".ub-figma");
  const groupFrames = page.locator('.ub-figma:has(a[href*="/budget"])');
  await expect(frames).toHaveCount(5);
  await expect(page.locator(".ub-figma iframe")).toHaveCount(3);
  await expect(frames.last().locator("iframe")).toHaveCount(0);
  await expect(frames.last().getByRole("button", { name: "Expand", exact: true })).toBeDisabled();
  for (const iframe of await groupFrames.locator("iframe").all()) await expect(iframe.contentFrame().locator("#canvas")).toBeAttached();
  await settle(frames.first());
  expect(visits.every((url) => !url.includes("/distant/"))).toBe(true);
  const initial = new Set(visits);
  await frames.last().scrollIntoViewIfNeeded();
  await expect(groupFrames.locator("iframe")).toHaveCount(0);
  await expect(frames.last().locator("iframe")).toHaveCount(1);
  await expect(page.locator(".ub-figma iframe")).toHaveCount(1);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await frames.first().scrollIntoViewIfNeeded();
  await expect(frames.last().locator("iframe")).toHaveCount(0);
  await expect(groupFrames.locator("iframe")).toHaveCount(3);
  await expect(page.locator(".ub-figma iframe")).toHaveCount(3);
  await expect.poll(() => [...initial].some((url) => visits.filter((visited) => visited === url).length > 1)).toBe(true);
});

test("offline placeholders and print output keep the title, caption and link without loading", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const created = await create(session);
  const visits: string[] = [];
  const page = await open(browser, created.uuid, visits, { offline: true });
  const frame = page.locator(".ub-figma");
  await expect(frame.locator(".ub-figma-placeholder > span")).toHaveText("The Figma preview needs a connection.");
  await expect(frame.locator(".ub-figma-placeholder-title")).toHaveText("Payment, mobile");
  await expect(frame.locator(".ub-figma-caption")).toHaveText(CAPTION);
  await expect(frame.locator("iframe")).toHaveCount(0);
  expect(visits).toEqual([]);
  await page.emulateMedia({ media: "print" });
  await expect(frame.locator(".ub-figma-print")).toBeVisible();
  await expect(frame.locator(".ub-figma-print")).toContainText(LINK);
  await expect(frame.locator(".ub-figma-print")).toContainText("Payment, mobile");
  await expect(frame.locator(".ub-figma-viewer")).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
    window.dispatchEvent(new Event("online"));
  });
  await expect(frame.locator("iframe")).toHaveCount(1);
  await session.call("archive_doc", { uuid: created.uuid });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(frame.getByRole("button", { name: "Edit", exact: true })).toBeHidden();
  await expect(frame.getByRole("button", { name: "Resize Figma preview", exact: true })).toBeHidden();
  await expect(frame.locator("iframe")).toHaveCount(1);
  const expand = frame.getByRole("button", { name: "Expand", exact: true });
  if (await frame.evaluate((element) => typeof element.requestFullscreen === "function")) {
    await expect(expand).toBeEnabled();
    await expand.focus();
    await expect(frame.locator(".ub-figure-toolbar")).toHaveCSS("opacity", "1");
    await expand.click();
    const bar = frame.locator(".ub-figure-viewer-bar");
    await expect(bar).toBeVisible();
    await expect(bar.getByRole("button", { name: "Edit", exact: true })).toBeHidden();
    await expect(bar.getByRole("link", { name: "Open in Figma", exact: true })).toBeVisible();
    await bar.getByRole("button", { name: "Close Figma viewer", exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  } else await expect(expand).toBeDisabled();
});

test("moving adjacent live viewers and undo or redo reloads each affected viewer at most once on either client", { tag: "@webkit" }, async ({ browser }) => {
  const created = await create(writer(), [{ type: "figma", text: source("moveA") }, { type: "figma", text: source("moveB") }]);
  const visits: [string[], string[]] = [[], []];
  const page = await open(browser, created.uuid, visits[0]);
  const remote = await open(browser, created.uuid, visits[1]);
  for (const client of [page, remote]) await expect(client.locator(".ub-figma iframe")).toHaveCount(2);
  const counts = (): [[number, number], [number, number]] => {
    const count = (urls: string[], key: string): number => urls.filter((url) => url.includes(`/${key}/`)).length;
    return [[count(visits[0], "moveA"), count(visits[0], "moveB")], [count(visits[1], "moveA"), count(visits[1], "moveB")]];
  };
  await expect.poll(counts).toEqual([[1, 1], [1, 1]]);
  const order = (client: Page): Promise<string[]> => client.locator(".ub-figma").evaluateAll((elements) => elements.map((element) => element.id));
  const initial = await order(page);
  let before = counts();
  await editor(page).evaluate((element) => {
    const mounted = element as HTMLElement & { editor: Editor };
    const first = mounted.editor.state.doc.firstChild;
    if (first === null) throw new Error("e2e: first viewer is missing");
    const second = mounted.editor.state.doc.child(1);
    mounted.editor.view.dispatch(mounted.editor.state.tr.delete(0, first.nodeSize).insert(second.nodeSize, first));
  });
  const bounded = async (expectedOrder: string[]): Promise<void> => {
    for (const client of [page, remote]) {
      await expect.poll(() => order(client)).toEqual(expectedOrder);
      await expect(client.locator(".ub-figma iframe")).toHaveCount(2);
      for (const frame of await client.locator(".ub-figma").all()) {
        await expect(frame.locator("iframe").contentFrame().locator("#canvas")).toBeVisible();
        await settle(frame);
      }
    }
    // Navigation is counted per stored viewer identity, not iframe load events.
    const after = counts();
    for (const client of [0, 1] as const) {
      for (const viewer of [0, 1] as const) expect(after[client][viewer] - before[client][viewer]).toBeLessThanOrEqual(1);
    }
    before = after;
  };
  await bounded([...initial].reverse());
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await bounded(initial);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await bounded([...initial].reverse());
});

test("new and existing caption comments stay at their Figma block and MCP reads their caption ranges", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const created = await create(session);
  // The default fixture's Figma block is the second one.
  const block = created.blocks[1];
  if (block === undefined) throw new Error("e2e: caption comment block is missing");
  const doc = new Y.Doc();
  const secret = await importRootSecret(harness().authSecret);
  const provider = new HocuspocusProvider({
    url: harness().hubUrl, name: roomForDoc(harness().workspaceUuid, created.uuid), document: doc,
    token: async () => wrapToken(await mintToken(secret, {
      typ: "room", sub: randomUUID(), workspace: harness().workspaceUuid,
      scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    })),
  });
  try {
    await expect.poll(() => findBlockElement(doc, block.id), { timeout: 20_000 }).not.toBeNull();
    createAnnotation(doc, block.id, 2, 8, "Earlier reader", "Existing caption discussion.", { part: "caption" });
    await expect.poll(async () => (await session.call<StoredDoc>("get_doc", { uuid: created.uuid })).annotations.length).toBe(1);
    const visits: string[] = [];
    const page = await open(browser, created.uuid, visits);
    const frame = page.locator(".ub-figma");
    const caption = frame.locator(".ub-figma-caption");
    const existing = caption.locator("[data-comment-thread]");
    await expect(existing).toHaveText("marked");
    await existing.click();
    const oldCard = page.locator(".ub-thread-card").filter({ hasText: "Existing caption discussion." });
    await expect(oldCard.locator(".ub-thread-ref")).toHaveText("Figma 2");
    await expect(oldCard.locator(".ub-thread-excerpt")).toHaveText("marked");
    await page.setViewportSize({ width: 1280, height: 1000 });
    const geometry = await frame.evaluate((element) => {
      const block = element.getBoundingClientRect();
      const column = element.closest(".ProseMirror")?.getBoundingClientRect();
      return { left: block.left, right: block.right, columnLeft: column?.left, columnRight: column?.right };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.columnLeft ?? 0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.columnRight ?? 0);
    await closeIfOpen(page.getByRole("button", { name: "Close threads", exact: true }), page.locator(".ub-threads-toggle"));
    await caption.locator("p").click();
    await setNativeSelection(caption, () => caption.evaluate((element) => {
      element.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true, pointerId: 1 }));
      const range = document.createRange();
      const tail = element.querySelector("p")?.lastChild;
      if (tail?.nodeType !== globalThis.Node.TEXT_NODE) throw new Error("e2e: unannotated caption tail is missing");
      range.setStart(tail, 1);
      range.setEnd(tail, tail.textContent?.length ?? 0);
      const mounted = element.closest(".ProseMirror") as HTMLElement & { editor: Editor };
      const expected = {
        anchor: mounted.editor.view.posAtDOM(range.startContainer, range.startOffset),
        head: mounted.editor.view.posAtDOM(range.endContainer, range.endOffset),
      };
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return expected;
    }));
    const toolbar = page.getByRole("toolbar", { name: "Text formatting and comment", exact: true });
    await toolbar.getByRole("button", { name: "Comment", exact: true }).click();
    const composer = page.locator('[data-slot="selection-composer"]');
    await expect(composer).toContainText("Figma 2");
    await composer.locator("textarea").fill("New caption discussion.");
    await composer.getByRole("button", { name: "Comment", exact: true }).click();
    const newCard = page.locator(".ub-thread-card").filter({ hasText: "New caption discussion." });
    await expect(newCard.locator(".ub-thread-ref")).toHaveText("Figma 2");
    await expect(newCard.locator(".ub-thread-excerpt")).toHaveText("design reference.");
    await expect.poll(async () => {
      const result = await session.call<StoredDoc>("get_doc", { uuid: created.uuid });
      return result.annotations.map((annotation) => ({ text: annotation.comments[0]?.text, range: annotation.range }));
    }).toEqual(expect.arrayContaining([
      { text: "Existing caption discussion.", range: expect.objectContaining({ part: "caption", start: 2, end: 8 }) },
      { text: "New caption discussion.", range: expect.objectContaining({ part: "caption", start: 9, end: CAPTION.length }) },
    ]));
    await page.reload();
    await expect(page.locator(".ub-figma-caption [data-comment-thread]")).not.toHaveCount(0);
    await closeIfOpen(page.getByRole("button", { name: "Close threads", exact: true }), page.locator(".ub-threads-toggle"));
    await page.locator(".ub-figma-caption [data-comment-thread]").first().click();
    await expect(page.locator(".ub-thread-card").filter({ hasText: "Existing caption discussion." }).locator(".ub-thread-excerpt")).toHaveText("marked");
    await expect(page.locator(".ub-thread-card").filter({ hasText: "New caption discussion." }).locator(".ub-thread-excerpt")).toHaveText("design reference.");
  } finally { provider.destroy(); doc.destroy(); }
});
