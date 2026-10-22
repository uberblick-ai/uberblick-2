import { devices, expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import type { BlockInput } from "@uberblick/schema";
import { activateControl, docTitle, editor, setupHarness } from "./app-helpers.js";
import { mockFigmaLookup } from "./figma-fixtures.js";
import { placeCaretIn } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = new McpAgent({ workspace: harness().workspace, hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: `uberblick-e2e-emoji-${process.env.UB_AGENTS_RUN ?? "local"}-` });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

interface StoredDoc { uuid: string; blocks: Array<{ id: string; text: string; rev: string }> }

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: emoji writer is missing");
  return agent.open({ name: "emoji-menu-e2e" });
}

async function create(session: McpSession, blocks: BlockInput[]): Promise<StoredDoc> {
  return session.call<StoredDoc>("create_doc", {
    title: docTitle("Emoji menu"), description: "Synthetic emoji picker browser acceptance.", blocks,
  });
}

async function open(browser: Browser, uuid: string, touch = false,
  beforeNavigate?: (page: Page) => Promise<void>): Promise<Page> {
  return openApp(browser, `/${harness().workspace}/${uuid}`, {
    upstream: true,
    contextOptions: touch ? devices["iPad (gen 7)"] : { viewport: { width: 1366, height: 1000 } },
    beforeNavigate: async (page) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await mockFigmaLookup(page);
      await page.route("https://embed.figma.com/**", route => route.fulfill({
        contentType: "text/html", body: "<p>Synthetic Figma canvas</p>",
      }));
      await beforeNavigate?.(page);
    },
  });
}

function menu(page: Page): Locator {
  return page.getByRole("listbox", { name: "Emoji and icons", exact: true });
}

async function paste(page: Page, text: string): Promise<void> {
  await editor(page).evaluate((element, value) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", value);
    element.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData: clipboard, bubbles: true, cancelable: true,
    }));
  }, text);
}

test("real typing ranks names and keywords, keyboard picks replace text, and undo restores the query", async ({ browser }) => {
  const session = writer();
  const created = await create(session, [{ type: "paragraph", text: "Thanks " }]);
  const page = await open(browser, created.uuid);
  const paragraph = editor(page).locator(":scope > p").first();
  await placeCaretIn(paragraph);
  await page.keyboard.type(":smi");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("option")).toHaveCount(8);
  await expect(menu(page).getByRole("option").first()).toHaveAccessibleName("smiley");
  await expect(menu(page).getByRole("option", { name: "smile", exact: true })).toBeVisible();
  await expect(menu(page).getByRole("option", { name: "smirk", exact: true })).toBeVisible();
  await expect(menu(page).getByRole("option", { name: "smiley", exact: true })).toContainText("😃");
  await page.keyboard.press("Enter");
  await expect(paragraph).toHaveText("Thanks 😃");
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(paragraph).toHaveText("Thanks :smi");
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(paragraph).toHaveText("Thanks 😃");
  await expect(menu(page)).toHaveCount(0);

  await page.keyboard.type(" :smi");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(menu(page).getByRole("option", { name: "smile", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(menu(page).getByRole("option", { name: "smiley", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(paragraph).toHaveText("Thanks 😃 😄");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type(" :hap");
  await expect(menu(page).getByRole("option", { name: "smiley", exact: true })).toBeVisible();
  await menu(page).getByRole("option", { name: "smiley", exact: true }).click();
  await expect(paragraph).toHaveText("Thanks 😃 😄 😃");
  await expect.poll(async () => (await session.call<StoredDoc>("get_doc", { uuid: created.uuid })).blocks[0]?.text)
    .toBe("Thanks 😃 😄 😃");
});

test("existing, pasted and remote queries stay closed, and dismissal lasts until a fresh trigger", async ({ browser }) => {
  const session = writer();
  const created = await create(session, [{ type: "paragraph", text: ":smi" }]);
  const page = await open(browser, created.uuid);
  const paragraph = editor(page).locator(":scope > p").first();
  await placeCaretIn(paragraph);
  await expect(menu(page)).toHaveCount(0);
  await paste(page, " :smi :smiley:");
  await expect(paragraph).toHaveText(":smi :smi :smiley:");
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.type(" Meet at 10:30 Note: see below https://example.com :s");
  await expect(menu(page)).toHaveCount(0);

  await page.keyboard.type(" :smi");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.type("l");
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.type(" :smi");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.type(" ");
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.type(":smi");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.type(" :smi");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.type("zzzzzz");
  await expect(menu(page)).toHaveCount(0);

  const before = await session.call<StoredDoc>("get_doc", { uuid: created.uuid });
  const block = before.blocks[0];
  if (block === undefined) throw new Error("e2e: query paragraph is missing");
  await session.call("edit_block", { uuid: created.uuid, block_id: block.id,
    old_text: block.text, new_text: "Peer :smi", rev: block.rev });
  await expect.poll(() => paragraph.evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    for (const cursor of copy.querySelectorAll(".ProseMirror-yjs-cursor")) cursor.remove();
    return copy.textContent;
  })).toBe("Peer :smi");
  await expect(menu(page)).toHaveCount(0);
});

test("typing the closing colon converts known emoji with one undo, while icons, unknown names and paste stay literal", async ({ browser }) => {
  const session = writer();
  const created = await create(session, [{ type: "paragraph", text: "Literal " }]);
  const page = await open(browser, created.uuid);
  const paragraph = editor(page).locator(":scope > p").first();
  await placeCaretIn(paragraph);
  await page.keyboard.type(":smiley:");
  await expect(paragraph).toHaveText("Literal 😃");
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(paragraph).toHaveText("Literal :smiley:");
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.type(" :rocket: :claude: :not-an-emoji: ");
  await paste(page, ":smiley: :rocket:");
  const expected = "Literal :smiley: 🚀 :claude: :not-an-emoji: :smiley: :rocket:";
  await expect(paragraph).toHaveText(expected);
  await expect(paragraph.locator('.ub-inline-icon[data-icon="claude"]')).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
  await expect.poll(async () => (await session.call<StoredDoc>("get_doc", { uuid: created.uuid })).blocks[0]?.text)
    .toBe(expected);
});

test("cold emoji data stays lazy, converts a completed name after further typing, and refuses an edited token", async ({ browser }) => {
  for (const editToken of [false, true]) {
    const created = await create(writer(), [{ type: "paragraph", text: "Start " }]);
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    let page: Page | null = null;
    try {
      page = await open(browser, created.uuid, false, async (loading) => {
        await loading.route("**/assets/gemoji-*.js", async (route) => {
          requests += 1;
          await gate;
          await route.continue();
        });
      });
      const paragraph = editor(page).locator(":scope > p").first();
      await placeCaretIn(paragraph);
      expect(requests).toBe(0);
      await page.keyboard.type(":smiley: ");
      await expect.poll(() => requests).toBe(1);
      await expect(paragraph).toHaveText("Start :smiley: ");
      if (editToken) {
        await page.keyboard.press("ArrowLeft");
        await page.keyboard.press("Backspace");
        await page.keyboard.type("x:");
        await expect(paragraph).toHaveText("Start :smileyx: ");
      }
      release();
      if (editToken) {
        // A live result proves the module evaluated before asserting that the
        // earlier pending conversion declined the now changed literal.
        await placeCaretIn(paragraph);
        await page.keyboard.type(":smi");
        await expect(menu(page)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(paragraph).toHaveText("Start :smileyx: :smi");
      } else {
        await expect(paragraph).toHaveText("Start 😃 ");
        await page.keyboard.type("after");
        await expect(paragraph).toHaveText("Start 😃 after");
      }
    } finally {
      release();
      await page?.unrouteAll({ behavior: "wait" });
    }
  }
});

test("the picker admits every prose surface, including all card parts and Figma captions", async ({ browser }) => {
  const created = await create(writer(), [
    { type: "paragraph", text: "Paragraph " }, { type: "heading", level: 2, text: "Heading " },
    { type: "list-item", text: "List " }, { type: "quote", text: "Quote " },
    { type: "table", text: "| Header |\n| --- |\n| Cell |" },
    { type: "card", text: "label: Label\ntitle: Title\nfooter: Footer\n\nBody" },
    { type: "figma", text: "url: https://www.figma.com/design/emoji123/Fixture\nheight: 240\n\nCaption" },
  ]);
  const page = await open(browser, created.uuid);
  const surfaces = [
    editor(page).locator(":scope > p").first(), page.locator(".ub-heading"), page.locator(".ub-list-item"),
    page.locator(".ub-quote"), page.locator(".ub-table th p"), page.locator(".ub-table td p"),
    ...["label", "title", "body", "footer"].map(part => page.locator(`.ub-card-${part} p`)),
    page.locator(".ub-figma-caption p"),
  ];
  for (const surface of surfaces) {
    await placeCaretIn(surface);
    await page.keyboard.type(" :smi");
    await expect(menu(page)).toBeVisible();
    await menu(page).getByRole("option", { name: "smiley", exact: true }).click();
    await expect(surface).toContainText("😃");
    await expect(menu(page)).toHaveCount(0);
  }
});

test("a table-cell icon pick works by pointer and iPad touch and stores its shortcode", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const session = writer();
  const created = await create(session, [{ type: "table", text: "| Header |\n| --- |\n| Cell |" }]);
  const touch = info.project.use.hasTouch === true;
  const page = await open(browser, created.uuid, touch);
  await page.emulateMedia({ colorScheme: "light" });
  const cell = page.locator(".ub-table td p");
  await placeCaretIn(cell, { touch });
  await page.keyboard.type(" :cla");
  await expect(menu(page)).toBeVisible();
  const option = menu(page).getByRole("option", { name: "Claude", exact: true });
  await expect(option.locator("svg")).toBeVisible();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(option).toBeVisible();
  await expect(option.locator("svg")).toBeVisible();
  await activateControl(option, { touch });
  await expect(menu(page)).toHaveCount(0);
  await expect(cell.locator('.ub-inline-icon[data-icon="claude"]')).toBeVisible();
  await expect(cell).toHaveText("Cell :claude:");
  await expect.poll(async () => (await session.call<StoredDoc>("get_doc", { uuid: created.uuid })).blocks[0]?.text)
    .toBe("| Header |\n| --- |\n| Cell :claude: |");
});

test("inline code and code, terminal and chart source keep typed names literal; archived documents stay read-only", async ({ browser }) => {
  const session = writer();
  const created = await create(session, [
    { type: "paragraph", inline: [{ text: "Code  ", marks: { inlineCode: true } }] },
    { type: "code", text: "Code ", language: "text" }, { type: "terminal", text: "Terminal " },
    { type: "chart", text: '{"version":1,"type":"line","collection":"measurements","x":{"field":"day","type":"category"},"y":[{"field":"value"}]}' },
  ]);
  const page = await open(browser, created.uuid);
  const inline = editor(page).locator(":scope > p code").first();
  await placeCaretIn(inline);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type(":smiley:");
  await expect(inline).toContainText(":smiley:");
  await expect(menu(page)).toHaveCount(0);
  const source = page.locator("pre.ub-code > code");
  await placeCaretIn(source);
  await page.keyboard.type(":smiley:");
  await expect(source).toContainText(":smiley:");
  await expect(menu(page)).toHaveCount(0);
  await page.locator(".ub-terminal-screen").click();
  const terminal = page.locator(".ub-terminal-source");
  await placeCaretIn(terminal);
  await page.keyboard.type(":smiley:");
  await expect(terminal).toContainText(":smiley:");
  await expect(menu(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Open chart source", exact: true }).click();
  const chart = page.locator(".ub-chart-source");
  await placeCaretIn(chart);
  await page.keyboard.type(" :smiley:");
  await expect(chart).toContainText(":smiley:");
  await expect(menu(page)).toHaveCount(0);
  await session.call("archive_doc", { uuid: created.uuid });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(menu(page)).toHaveCount(0);
});
