import { devices, expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { BlockInput } from "@uberblick/schema";
import { join } from "node:path";
import { activateControl, docTitle, editor, setupHarness } from "./app-helpers.js";
import { mockFigmaLookup } from "./figma-fixtures.js";
import { placeCaret, placeCaretIn } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { setNativeSelection } from "./native-selection.js";

const { harness, openApp } = setupHarness();
const NAMES = ["claude", "codex", "github"];
const SOURCE = ":claude: :codex: :github:";
const TARGET = "https://example.invalid/inline-icon";
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = new McpAgent({ workspace: harness().workspace, hubUrl: harness().hubUrl,
    authSecret: harness().authSecret, statePrefix: "uberblick-e2e-inline-icons-" });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: inline-icon writer is missing");
  return agent.open({ name: "inline-icons-e2e" });
}

interface StoredDoc { uuid: string; blocks: Array<{ id: string; text: string; rev: string }> }

async function create(session: McpSession, blocks: BlockInput[]): Promise<StoredDoc> {
  return session.call<StoredDoc>("create_doc", {
    title: docTitle("Inline icons"), description: "Synthetic inline icon browser acceptance.", blocks,
  });
}

async function open(browser: Browser, uuid: string, touch: boolean): Promise<Page> {
  return openApp(browser, `/${harness().workspace}/${uuid}`, {
    upstream: true,
    contextOptions: touch ? devices["iPad (gen 7)"] : { viewport: { width: 1366, height: 1000 } },
    beforeNavigate: async (page) => {
      await mockFigmaLookup(page);
      await page.route("https://embed.figma.com/**", (route) => route.fulfill({
        contentType: "text/html", body: "<p>Synthetic Figma canvas</p>",
      }));
    },
  });
}

async function selectSource(target: Locator, from: number, to: number): Promise<void> {
  await setNativeSelection(target, () => target.evaluate((element, offsets) => {
    const root = element.closest(".ProseMirror") as HTMLElement & { editor: Editor };
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest(".ub-inline-icon, .ProseMirror-yjs-cursor") === null
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    const point = (offset: number): [Text, number] => {
      for (const text of texts) {
        if (offset <= text.length) return [text, offset];
        offset -= text.length;
      }
      throw new Error("e2e: icon selection is outside stored text");
    };
    const start = point(offsets.from);
    const end = point(offsets.to);
    const range = document.createRange();
    range.setStart(...start);
    range.setEnd(...end);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return { anchor: root.editor.view.posAtDOM(...start), head: root.editor.view.posAtDOM(...end) };
  }, { from, to }));
}

test("all prose surfaces render the curated marks at their text size and colour in both appearances", { tag: "@webkit" }, async ({ browser }, info) => {
  const created = await create(writer(), [
    { type: "paragraph", text: SOURCE },
    { type: "heading", level: 2, text: SOURCE },
    { type: "list-item", text: SOURCE },
    { type: "quote", text: SOURCE },
    { type: "table", text: `| ${SOURCE} |\n| --- |\n| ${SOURCE} |` },
    { type: "card", text: `label: ${SOURCE}\ntitle: ${SOURCE}\nfooter: ${SOURCE}\n\n${SOURCE}` },
    { type: "figma", text: `url: https://www.figma.com/design/icon123/Fixture\nheight: 240\n\n${SOURCE}` },
  ]);
  const page = await open(browser, created.uuid, info.project.use.hasTouch === true);
  const surfaces = [
    editor(page).locator(":scope > p").first(), page.locator(".ub-heading"), page.locator(".ub-list-item"),
    page.locator(".ub-quote"), page.locator(".ub-table th p"), page.locator(".ub-table td p"),
    ...["label", "title", "body", "footer"].map(part => page.locator(`.ub-card-${part} p`)),
    page.locator(".ub-figma-caption p"),
  ];
  for (const appearance of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: appearance });
    for (const surface of surfaces) {
      await expect(surface.locator(".ub-inline-icon")).toHaveCount(3);
      await expect(surface.locator(".ub-inline-icon-text")).toHaveText(NAMES.map(name => `:${name}:`));
      for (const name of NAMES) {
        const icon = surface.locator(`.ub-inline-icon[data-icon="${name}"]`);
        await expect(icon).toBeVisible();
        await expect(icon.locator("svg")).toHaveCount(1);
        const paint = await icon.evaluate((element) => {
          const parent = element.parentElement;
          const svg = element.querySelector("svg");
          if (parent === null || svg === null) throw new Error("e2e: icon has no surrounding text or SVG");
          return { ink: getComputedStyle(svg).color, textInk: getComputedStyle(parent).color,
            height: svg.getBoundingClientRect().height, fontSize: Number.parseFloat(getComputedStyle(parent).fontSize) };
        });
        expect(paint.ink).toBe(paint.textInk);
        expect(paint.height).toBeCloseTo(paint.fontSize, 0);
      }
    }
    if (process.env.UB_AGENTS_SCRATCH !== undefined) {
      await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH,
        `inline-icons-${info.project.name}-${appearance}.png`), fullPage: true });
    }
  }
});

test("closing colon renders immediately, strict interior editing reveals source and copying preserves it", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer();
  const created = await create(session, [{ type: "paragraph", text: "before " }]);
  const page = await open(browser, created.uuid, info.project.use.hasTouch === true);
  await placeCaret(page);
  await page.keyboard.type(":claude");
  await expect(page.locator(".ub-inline-icon")).toHaveCount(0);
  await page.keyboard.type(":");
  const icon = page.locator('.ub-inline-icon[data-icon="claude"]');
  await expect(icon).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(icon).toHaveCount(0);
  await expect(editor(page)).toHaveText("before :claude:");
  await page.keyboard.press("ArrowRight");
  await expect(icon).toBeVisible();
  await placeCaret(page, "start");
  for (let index = 0; index < "before ".length; index += 1) await page.keyboard.press("ArrowRight");
  await expect(icon).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(icon).toHaveCount(0);
  await editor(page).evaluate(element => (element as HTMLElement).blur());
  await expect(icon).toBeVisible();
  await placeCaret(page);
  const paragraph = editor(page).locator(":scope > p").first();
  await selectSource(paragraph, "before ".length, "before :claude:".length);
  await expect(icon).toHaveCount(0);
  await editor(page).evaluate(element => (element as HTMLElement).blur());
  await expect(icon).toBeVisible();
  const copied = await editor(page).evaluate((element) => {
    const clipboard = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { clipboardData: clipboard, bubbles: true, cancelable: true }));
    return { text: clipboard.getData("text/plain"), html: clipboard.getData("text/html") };
  });
  expect(copied.text).toBe(":claude:");
  expect(copied.html).toContain(":claude:");
  expect(copied.html).not.toContain("ub-inline-icon");
  expect(copied.html).not.toContain("<svg");
  await expect.poll(async () => (await session.call<StoredDoc>("get_doc", { uuid: created.uuid })).blocks[0]?.text)
    .toBe("before :claude:");
  await session.call("archive_doc", { uuid: created.uuid });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(icon).toBeVisible();
});

test("icons keep link activation and comment highlights while accessible names omit decorative source", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer();
  const label = ":claude: Discuss with Claude";
  const created = await create(session, [
    { type: "paragraph", inline: [{ text: label, marks: { link: TARGET } }] },
    { type: "paragraph", inline: [{ text: ":codex:", marks: { link: `${TARGET}/codex` } }] },
    { type: "paragraph", text: ":github:" },
  ]);
  await session.call("annotate", { uuid: created.uuid, block_id: created.blocks[0]?.id,
    start: 2, end: 6, text: "Comment on part of an icon source." });
  const page = await open(browser, created.uuid, info.project.use.hasTouch === true);
  const link = page.getByRole("link", { name: "Discuss with Claude", exact: true });
  const icon = link.locator('.ub-inline-icon[data-icon="claude"]');
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  await expect.poll(() => link.locator(".ub-inline-icon-text").evaluateAll(elements =>
    elements.length > 0 && elements.every(element => element.getAttribute("aria-hidden") === "true"))).toBe(true);
  await expect(page.getByRole("link", { name: "Codex", exact: true })).toBeVisible();
  await expect(editor(page).getByRole("img", { name: "GitHub", exact: true })).toBeVisible();
  expect(await link.ariaSnapshot()).not.toContain(":claude:");
  await expect(icon.locator("xpath=ancestor::a[1]")).toHaveAttribute("href", TARGET);
  for (const appearance of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: appearance });
    await expect.poll(() => icon.evaluate((element) => {
      const comment = element.closest("[data-comment-thread]");
      return comment !== null && getComputedStyle(comment).backgroundColor !== "rgba(0, 0, 0, 0)";
    })).toBe(true);
  }
  await page.context().route("https://example.invalid/**", route => route.fulfill({
    contentType: "text/html", body: "<p>Inline icon destination</p>",
  }));
  for (const readOnly of [false, true]) {
    if (readOnly) {
      await session.call("archive_doc", { uuid: created.uuid });
      await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    }
    const popupPromise = page.context().waitForEvent("page");
    await activateControl(icon);
    const popup = await popupPromise;
    await popup.waitForLoadState();
    await expect(popup).toHaveURL(TARGET);
    await popup.close();
    await page.bringToFront();
  }
});

test("card buttons render icons, edit their literal labels and activate from the mark", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer();
  const destination = "claude://code/new?prompt=Icon%20proof";
  const created = await create(session, [{ type: "card", text:
    `title: Action icons\nbutton: [:claude: Discuss with Claude](${destination}) blue\nbutton: [:codex:](codex://new)\nbutton: [:rocket: Unknown](https://example.invalid/unknown)\n\nAction body.` }]);
  const page = await open(browser, created.uuid, info.project.use.hasTouch === true);
  const card = page.locator(".ub-card");
  const action = card.getByRole("button", { name: "Discuss with Claude", exact: true });
  const icon = action.locator('.ub-inline-icon[data-icon="claude"]');
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  await expect(card.getByRole("button", { name: "Codex", exact: true }).locator(".ub-inline-icon")).toBeVisible();
  await expect(card.getByRole("button", { name: ":rocket: Unknown", exact: true })).toHaveText(":rocket: Unknown");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const paint = await action.evaluate((element) => {
      const icon = element.querySelector(".ub-inline-icon");
      if (icon === null) throw new Error("e2e: card action has no icon");
      return { icon: getComputedStyle(icon).color, text: getComputedStyle(element).color };
    });
    expect(paint.icon).toBe(paint.text);
  }
  await placeCaretIn(card.locator(".ub-card-title p"), { touch: info.project.use.hasTouch === true });
  await activateControl(card.getByRole("button", { name: "Edit buttons", exact: true }));
  const field = page.getByLabel("Button text", { exact: true });
  await expect(field).toHaveValue(":claude: Discuss with Claude");
  await field.fill(":github: Discuss with Claude");
  await activateControl(page.getByRole("button", { name: "Save button", exact: true }));
  const github = action.locator('.ub-inline-icon[data-icon="github"]');
  await expect(github).toBeVisible();
  await expect(action).toHaveAccessibleName("Discuss with Claude");
  await page.evaluate(() => {
    const capture = window as unknown as Window & { iconDestinations: string[] };
    capture.iconDestinations = [];
    document.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest("a[data-card-button-navigation]") : null;
      if (link === null) return;
      event.preventDefault();
      capture.iconDestinations.push(link.getAttribute("href") ?? "");
    }, true);
  });
  await activateControl(github);
  await expect.poll(() => page.evaluate(() => (window as unknown as Window & { iconDestinations: string[] }).iconDestinations)).toEqual([destination]);
  await expect.poll(async () => (await session.call<StoredDoc>("get_doc", { uuid: created.uuid })).blocks[0]?.text)
    .toContain(`button: [:github: Discuss with Claude](${destination}) blue`);
});
