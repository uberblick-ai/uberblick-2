import { devices, expect, test } from "@playwright/test";
import type { Browser, Locator, Page, TestInfo } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { activateControl, docTitle, editor, setupHarness } from "./app-helpers.js";
import { placeCaretIn } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl, authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-divider-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

type SeedBlock = { type: "paragraph" | "divider"; text?: string };

async function fixture(browser: Browser, info: TestInfo, blocks: SeedBlock[]): Promise<Page> {
  if (agent === null) throw new Error("e2e: the MCP agent is not configured");
  const writer = agent.open({ name: "divider-input-e2e" });
  const created = await writer.call<{ uuid: string }>("create_doc", {
    title: docTitle("Divider input"), description: "Native divider input and selection.", blocks,
  });
  const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
    upstream: true,
    contextOptions: { ...(info.project.use.hasTouch === true ? devices["iPad (gen 7)"] : {}) },
  });
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  return page;
}

function blocks(page: Page): Locator { return editor(page).locator(":scope > *"); }
function dividers(page: Page): Locator { return editor(page).locator(":scope > .ub-divider"); }

async function blockTypes(page: Page): Promise<string[]> {
  return editor(page).evaluate(element => (element as HTMLElement & { editor: Editor })
    .editor.getJSON().content?.map(node => node.type) ?? []);
}

async function caretBlock(page: Page): Promise<{ type: string; text: string }> {
  return editor(page).evaluate(element => {
    const { selection } = (element as HTMLElement & { editor: Editor }).editor.state;
    return { type: selection.$head.parent.type.name, text: selection.$head.parent.textContent };
  });
}

test("typing three hyphens creates a divider, moves the caret below and has two undo steps", { tag: "@webkit" }, async ({ browser }, info) => {
  const page = await fixture(browser, info, [{ type: "paragraph", text: "" }]);
  await placeCaretIn(blocks(page).first());
  await page.keyboard.type("---");
  await expect(dividers(page)).toHaveCount(1);
  await expect.poll(() => blockTypes(page)).toEqual(["divider", "paragraph"]);
  await expect.poll(() => caretBlock(page)).toEqual({ type: "paragraph", text: "" });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(blocks(page)).toHaveText(["---"]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(blocks(page)).toHaveText([""]);
});

test("slash and gutter picks create a following paragraph with the caret and undo together", async ({ browser }, info) => {
  const page = await fixture(browser, info, [{ type: "paragraph", text: "Above" }, { type: "paragraph", text: "" }]);
  await placeCaretIn(blocks(page).last());
  await page.keyboard.type("/divider");
  await page.getByRole("option", { name: "Divider", exact: true }).click();
  await expect.poll(() => blockTypes(page)).toEqual(["paragraph", "divider", "paragraph"]);
  await expect.poll(() => caretBlock(page)).toEqual({ type: "paragraph", text: "" });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(blocks(page)).toHaveText(["Above", "/divider"]);

  await blocks(page).first().hover();
  await page.getByRole("button", { name: "Insert block below", exact: true }).click();
  await page.getByRole("option", { name: "Divider", exact: true }).click();
  await expect.poll(() => blockTypes(page)).toEqual(["paragraph", "divider", "paragraph", "paragraph"]);
  await expect(blocks(page)).toHaveText(["Above", "", "", "/divider"]);
  await expect.poll(() => caretBlock(page)).toEqual({ type: "paragraph", text: "" });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(blocks(page)).toHaveText(["Above", "/divider"]);
});

for (const key of ["Backspace", "Delete"] as const) {
  test(`${key} beside a divider follows native deletion and undo for nonempty and empty paragraphs`, { tag: "@webkit" }, async ({ browser }, info) => {
    const after = key === "Backspace";
    for (const text of ["Keep these words", ""]) {
      const paragraph: SeedBlock = { type: "paragraph", text };
      const divider: SeedBlock = { type: "divider" };
      const page = await fixture(browser, info, after ? [divider, paragraph] : [paragraph, divider]);
      await placeCaretIn(editor(page).locator(":scope > p"), { edge: after ? "start" : "end" });
      await page.keyboard.press(key);
      if (text !== "") {
        await expect.poll(() => blockTypes(page)).toEqual(["paragraph"]);
        await expect.poll(() => caretBlock(page)).toEqual({ type: "paragraph", text });
      } else {
        await expect.poll(() => blockTypes(page)).toEqual(["divider"]);
        await expect(dividers(page)).toHaveClass(/ProseMirror-selectednode/);
      }
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => blockTypes(page)).toEqual(after ? ["divider", "paragraph"] : ["paragraph", "divider"]);
      await expect(editor(page).locator(":scope > p")).toHaveText(text);
      await page.close();
    }
  });
}

test("a divider is a frameless separator in both appearances, and pointer or touch selection cannot comment", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const page = await fixture(browser, info, [
    { type: "paragraph", text: "Above" }, { type: "divider" }, { type: "paragraph", text: "Below" },
  ]);
  const divider = dividers(page);
  await page.evaluate(async () => { await document.fonts.ready; });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const geometry = await divider.evaluate(element => {
      const line = element.querySelector("hr");
      if (line === null) throw new Error("e2e: divider has no semantic separator");
      const surface = element.getBoundingClientRect();
      const stroke = line.getBoundingClientRect();
      const previous = element.previousElementSibling?.getBoundingClientRect();
      const next = element.nextElementSibling?.getBoundingClientRect();
      const style = getComputedStyle(element);
      const lineStyle = getComputedStyle(line);
      const probe = element.ownerDocument.createElement("span");
      probe.style.borderTop = "1px solid var(--border)";
      element.append(probe);
      const borderColor = getComputedStyle(probe).borderTopColor;
      probe.remove();
      return { width: surface.width, height: surface.height, lineWidthInPixels: stroke.width,
        top: surface.top, bottom: surface.bottom, previousBottom: previous?.bottom, nextTop: next?.top, borderColor,
        lineColor: lineStyle.borderTopColor, lineWidth: lineStyle.borderTopWidth,
        frameBorder: style.borderWidth, frameBackground: style.backgroundColor };
    });
    expect(geometry.lineWidthInPixels).toBeCloseTo(geometry.width, 0);
    expect(geometry.lineWidth).toBe("1px");
    expect(geometry.lineColor).toBe(geometry.borderColor);
    expect(geometry.frameBorder).toBe("0px");
    expect(geometry.frameBackground).toBe("rgba(0, 0, 0, 0)");
    expect(geometry.previousBottom).toBeLessThan(geometry.top);
    expect(geometry.nextTop).toBeGreaterThan(geometry.bottom);
    if (info.project.use.hasTouch === true) expect(geometry.height).toBeGreaterThanOrEqual(44);
    await expect(divider.getByRole("separator")).toHaveCount(1);
  }
  await activateControl(divider);
  await expect(divider).toHaveClass(/ProseMirror-selectednode/);
  await expect(divider).not.toHaveCSS("box-shadow", "none");
  await expect(page.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await expect(dividers(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(dividers(page)).toHaveCount(1);
});

test("arrow keys pass dividers and create paragraphs before, between and after adjacent edge dividers", { tag: "@webkit" }, async ({ browser }, info) => {
  const page = await fixture(browser, info, [{ type: "divider" }, { type: "divider" }]);
  await activateControl(dividers(page).first());
  await expect(dividers(page).first()).toHaveClass(/ProseMirror-selectednode/);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("Before");
  await expect.poll(() => blockTypes(page)).toEqual(["paragraph", "divider", "divider"]);
  await expect(blocks(page).first()).toHaveText("Before");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("Between");
  await expect.poll(() => blockTypes(page)).toEqual(["paragraph", "divider", "paragraph", "divider"]);
  await expect(blocks(page).nth(2)).toHaveText("Between");
  await activateControl(dividers(page).last());
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("After");
  await expect.poll(() => blockTypes(page)).toEqual(["paragraph", "divider", "paragraph", "divider", "paragraph"]);
  await expect(blocks(page).last()).toHaveText("After");
  await placeCaretIn(blocks(page).last(), { edge: "start" });
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("!");
  await expect(blocks(page).nth(2)).toHaveText("Between!");
});

test("native clipboard keeps a selection that includes a divider", { tag: "@webkit" }, async ({ browser }, info) => {
  const page = await fixture(browser, info, [
    { type: "paragraph", text: "Above" }, { type: "divider" }, { type: "paragraph", text: "Below" },
  ]);
  await placeCaretIn(blocks(page).first());
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("Backspace");
  await expect(dividers(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(() => blockTypes(page)).toEqual(["paragraph", "divider", "paragraph"]);
  await expect(blocks(page)).toHaveText(["Above", "", "Below"]);
});

test("plain clipboard converts only a hyphen line after a blank line", async ({ browser }, info) => {
  const page = await fixture(browser, info, [{ type: "paragraph", text: "" }]);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async () => navigator.clipboard.writeText("First\n\n---\n\nSecond\n---\nThird"));
  await placeCaretIn(blocks(page).first());
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(() => blockTypes(page)).toEqual(["paragraph", "divider", "paragraph", "paragraph", "paragraph"]);
  await expect(blocks(page)).toHaveText(["First", "", "Second", "---", "Third"]);
});
