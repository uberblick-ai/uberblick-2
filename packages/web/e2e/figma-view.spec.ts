/** The production node view keeps browser-owned viewers through ordinary shared edits. */
import { devices, expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { FIGMA_PROVIDER, createAnnotation, roomForDoc } from "@uberblick/schema";
import { wrapToken } from "@uberblick/schema/protocol";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import * as Y from "yjs";
import { closeIfOpen, docTitle, editor, setupHarness } from "./app-helpers.js";
import { renderedText } from "./contrast-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { setNativeSelection } from "./native-selection.js";
import { mockFigmaLookup } from "./figma-fixtures.js";

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
  const touch = options.touch ?? browser.browserType().name() === "webkit";
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
  test(`Figma uses the shared teal frame, AA caption and neutral active ring — ${appearance}`, { tag: "@webkit" }, async ({ browser }, info) => {
    const created = await create(writer());
    const navigations: string[] = [];
    const page = await open(browser, created.uuid, navigations, { appearance, touch: info.project.use.hasTouch === true });
    const frame = page.locator(".ub-figma");
    const iframe = frame.locator("iframe");
    await expect(iframe).toHaveAttribute("src", FIGMA_PROVIDER.embedAddress(LINK, appearance));
    await expect(iframe).toHaveAttribute("title", "Payment, mobile");
    for (const [name, value] of Object.entries(FIGMA_PROVIDER.frameAttributes)) await expect(iframe).toHaveAttribute(name, value);
    const attributes = await iframe.evaluate((element) => element.getAttributeNames().sort());
    expect(attributes).toEqual(["allow", "allowfullscreen", "referrerpolicy", "sandbox", "src", "title"]);
    await expect(frame).toHaveClass(/ub-block-frame/);
    const painted = await frame.evaluate((element) => ({ bar: getComputedStyle(element).borderLeftColor, tint: getComputedStyle(element).backgroundColor }));
    expect(painted.bar).toBe(await token(frame, "--block-teal-bar"));
    expect(painted.tint).toBe(await token(frame, "--block-teal-tint"));
    const readings = await renderedText(page, ".ub-figma > .ub-block-caption");
    expect(readings.length).toBeGreaterThan(0);
    for (const reading of readings) expect(reading.ratio, JSON.stringify(reading)).toBeGreaterThanOrEqual(4.5);
    const shield = frame.locator(".ub-figma-shield");
    await shield.focus();
    await page.keyboard.press("Enter");
    await expect(frame).toHaveAttribute("data-figma-active", "true");
    const ring = await frame.evaluate((element) => getComputedStyle(element).boxShadow);
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

test("caption, local and remote text, undo, fields and theme preserve both clients' viewers; a changed link reloads once", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const created = await create(session);
  const id = created.blocks.find((block) => block.type === "figma")?.id;
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
  await expect(frames[0].locator(".ub-block-label")).toContainText("MCP title");
  await expect(frames[1].locator(".ub-figma-caption")).toContainText("MCP caption.");
  await stable();
  await frames[0].getByRole("button", { name: "Edit", exact: true }).click();
  await expect(frames[0].getByLabel("Figma link", { exact: true })).toBeFocused();
  await expect(frames[0].getByRole("button", { name: "Expand", exact: true })).toBeDisabled();
  await stable();
  await frames[0].getByLabel("Title", { exact: true }).fill("Edited title");
  await frames[0].getByLabel("Height", { exact: true }).fill("360");
  await frames[0].getByRole("button", { name: "Done", exact: true }).first().click();
  await expect(frames[0].locator(".ub-block-label")).toContainText("Edited title");
  await expect(frames[0].locator(".ub-figma-viewer")).toHaveCSS("height", "360px");
  await expect(frames[1].locator(".ub-block-label")).toContainText("Edited title");
  await stable();
  await page.emulateMedia({ colorScheme: "dark" });
  await remote.emulateMedia({ colorScheme: "dark" });
  await stable();
  await expect(frames[0].locator("iframe")).toHaveAttribute("src", /theme=light/);
  await frames[0].getByRole("button", { name: "Edit", exact: true }).click();
  await frames[0].getByLabel("Figma link", { exact: true }).fill(LINK.replace("12-345", "12-401"));
  await frames[0].getByRole("button", { name: "Done", exact: true }).first().click();
  for (const index of [0, 1] as const) {
    await expect(frames[index].locator("iframe")).toHaveAttribute("src", /node-id=12-401/);
    await expect.poll(() => visits[index].length).toBe(2);
  }
});

test("Expand enters browser fullscreen with the same iframe and browser exit preserves it", { tag: "@webkit" }, async ({ browser }) => {
  const created = await create(writer());
  const visits: string[] = [];
  // Playwright mobile WebKit hides both fullscreen entry methods. Keep iPad's
  // viewport, user agent and touch input while enabling its browser fullscreen API.
  const page = await open(browser, created.uuid, visits, { fullscreen: true });
  const frame = page.locator(".ub-figma");
  const iframe = frame.locator("iframe");
  await expect(iframe).toHaveCount(1);
  const identity = await iframe.elementHandle();
  const articleIdentity = await frame.elementHandle();
  await frame.getByRole("button", { name: "Expand", exact: true }).click();
  await expect.poll(() => frame.evaluate((element) => document.fullscreenElement === element)).toBe(true);
  await unchanged(frame, identity, visits);
  expect(await articleIdentity?.evaluate((element) => element.isConnected)).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await unchanged(frame, identity, visits);
  expect(await articleIdentity?.evaluate((element) => element.isConnected)).toBe(true);
  await frame.getByRole("button", { name: "Expand", exact: true }).click();
  await expect.poll(() => frame.evaluate((element) => document.fullscreenElement === element)).toBe(true);
  // Headless Chromium delivers trusted Escape to a bare fullscreen article
  // without exiting. WebKit handles that browser action before DOM key events.
  if (browser.browserType().name() === "webkit") await page.keyboard.press("Escape");
  else await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await unchanged(frame, identity, visits);
});

test("a refused fullscreen request keeps the preview and names Open in Figma as the next step", { tag: "@webkit" }, async ({ browser }) => {
  const created = await create(writer());
  const visits: string[] = [];
  const page = await open(browser, created.uuid, visits, { fullscreen: true });
  const frame = page.locator(".ub-figma");
  const identity = await frame.locator("iframe").elementHandle();
  await frame.evaluate((element) => {
    element.requestFullscreen = () => Promise.reject(new Error("Fullscreen refused"));
  });
  await frame.getByRole("button", { name: "Expand", exact: true }).click();
  const notice = page.locator("[data-sonner-toast]:not([data-removed=true])");
  await expect(notice).toContainText("Couldn't open fullscreen. Use Open in Figma instead.");
  await expect(notice).toHaveAttribute("data-type", "error");
  await expect(frame.getByRole("link", { name: "Open in Figma", exact: true })).toBeVisible();
  await unchanged(frame, identity, visits);
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
  await expect(frame.locator(".ub-block-label")).toContainText("Payment, mobile");
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
  if (await frame.evaluate((element) => typeof element.requestFullscreen === "function")) await expect(expand).toBeEnabled();
  else await expect(expand).toBeDisabled();
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

test.fixme("new and existing caption comments stay at their Figma block and MCP reads their caption ranges", {
  tag: "@webkit",
  annotation: { type: "issue", description: "https://github.com/uberblick-ai/uberblick-2/issues/1835" },
}, async ({ browser }) => {
  const session = writer();
  const created = await create(session);
  const block = created.blocks.find((candidate) => candidate.type === "figma");
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
    await new Promise<void>((resolve) => provider.on("synced", resolve));
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
