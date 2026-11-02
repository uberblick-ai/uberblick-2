/** Ablauf playback: ablauf's own controls mounted on demand under a host-themed drawing. */
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { activateControl, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { expectMcp, waitForDocumentDraw } from "./settle.js";
import { contrast } from "../test/colour.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl, authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-ablauf-playback-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: Ablauf playback MCP agent is not configured");
  return agent.open({ name: "ablauf-playback-e2e" });
}

const FLOW = 'flow v0\ncolumns main\npill draft tone=agent "Draft"\nbox check tone=system "Check draft"\nend done tone=done "Done"\n\ndraft --> check\ncheck --> done : Accepted';
const PLAYED = `${FLOW}\n\nplay "Happy path"\n  tempo 10s\n  step draft actor="Author" "Writes a draft"\n  step check actor="Reviewer" "Checks it"\n  step done\n\nplay "Quick"\n  step draft\n  step check`;
const SINGLE = `${FLOW.replace('"Draft"', '"Other draft"')}\n\nplay\n  step draft 10s actor="Author" "Takes a while"\n  step check`;

interface Block { id: string; type: string; language?: string; text: string; rev: string }

async function codeBlocks(session: McpSession, uuid: string): Promise<Block[]> {
  const doc = await session.call<{ blocks: Block[] }>("get_doc", { uuid });
  return doc.blocks.filter(block => block.type === "code");
}

async function editSource(session: McpSession, uuid: string, index: number, text: string): Promise<void> {
  const block = (await codeBlocks(session, uuid))[index];
  if (block === undefined) throw new Error("e2e: Ablauf code block is missing");
  await session.call("edit_block", { uuid, block_id: block.id, rev: block.rev, old_text: block.text, new_text: text });
}

function blocks(page: Page): Locator { return page.locator(".ub-ablauf"); }
function svg(block: Locator): Locator { return block.locator(".ub-ablauf-drawing svg"); }
function play(block: Locator): Locator { return block.locator(".ub-ablauf-play"); }
function controls(block: Locator): Locator { return block.locator(".ab-playback"); }
function toggle(block: Locator): Locator { return controls(block).locator(".abp-toggle"); }

async function hasClass(locator: Locator, name: string): Promise<boolean> {
  return locator.evaluate((element, className) => element.classList.contains(className), name);
}

test("Play mounts ablauf's controls on demand, blocks play independently and source edits remount them", async ({ browser }) => {
  const session = writer();
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title: "Played Ablauf", description: "Two playable flows around a static one.",
    blocks: [PLAYED, FLOW, SINGLE].map(text => ({ type: "code", language: "ablauf", text })),
  });
  const errors: string[] = [];
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: async page => { page.on("pageerror", error => errors.push(error.message)); },
  });
  await waitForDocumentDraw(page, session, uuid, { index: "all" });
  const [first, plain, third] = [blocks(page).nth(0), blocks(page).nth(1), blocks(page).nth(2)];
  await expect(play(first)).toBeAttached();
  await expect(play(third)).toBeAttached();
  await expect(play(plain)).toBeHidden();
  await expect(play(plain)).toHaveAttribute("hidden", "");
  await expect(page.locator(".ab-playback")).toHaveCount(0);
  for (const block of [first, plain, third]) expect(await hasClass(svg(block), "ab-in-progress")).toBe(false);

  await svg(first).hover();
  await expect(play(first)).toBeVisible();
  await play(first).click();
  await expect(controls(first).getByRole("tab")).toHaveText(["Happy path", "Quick"]);
  await expect(toggle(first)).toHaveText("Pause");
  await expect(play(first)).toHaveText("Stop");
  await expect(play(first)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => hasClass(svg(first), "ab-playing")).toBe(true);
  await expect(controls(first).locator(".abp-caption")).toHaveText("Writes a draft");
  expect(await hasClass(svg(third), "ab-in-progress")).toBe(false);

  await svg(third).hover();
  await play(third).click();
  await expect(toggle(third)).toHaveText("Pause");
  await expect(controls(third).getByRole("tab")).toHaveCount(0);
  await activateControl(toggle(first));
  await expect(toggle(first)).toHaveText("Play");
  await expect.poll(() => hasClass(svg(first), "ab-playing")).toBe(false);
  expect(await hasClass(svg(third), "ab-playing")).toBe(true);

  const edited = PLAYED.replace('"Draft"', '"First draft"');
  await editSource(session, uuid, 0, edited);
  await waitForDocumentDraw(page, session, uuid, { index: 0, source: edited });
  await expect(svg(first)).toContainText("First draft");
  await expect(controls(first)).toHaveCount(1);
  await expect(toggle(first)).toHaveText("Play");
  expect(await hasClass(svg(first), "ab-in-progress")).toBe(false);
  await activateControl(toggle(first));
  await expect.poll(() => hasClass(svg(first), "ab-playing")).toBe(true);
  expect(await hasClass(svg(third), "ab-playing")).toBe(true);

  const misspelled = `${edited}\n  step nowhere`;
  await editSource(session, uuid, 0, misspelled);
  await waitForDocumentDraw(page, session, uuid, { index: 0, source: misspelled });
  const line = misspelled.split("\n").length;
  await expect(first.locator(".ub-ablauf-diagnostics")).toContainText(`Line ${line}: error: unknown playback target \`nowhere\``);
  await expect(controls(first)).toHaveCount(1);

  await editSource(session, uuid, 0, FLOW);
  await waitForDocumentDraw(page, session, uuid, { index: 0, source: FLOW });
  await expect(controls(first)).toHaveCount(0);
  await expect(play(first)).toBeHidden();
  expect(await hasClass(svg(first), "ab-in-progress")).toBe(false);

  await svg(third).hover();
  await play(third).click();
  await expect(controls(third)).toHaveCount(0);
  await expect(play(third)).toHaveText("Play");
  expect(await hasClass(svg(third), "ab-in-progress")).toBe(false);
  expect(await svg(third).locator("[data-ab-part].ab-current, [data-ab-part].ab-played").count()).toBe(0);

  // Playing never touches the stored block: reads and export keep the exact source.
  await expectMcp(async () => {
    expect((await codeBlocks(session, uuid)).map(block => [block.language, block.text])).toEqual([
      ["ablauf", FLOW], ["ablauf", FLOW], ["ablauf", SINGLE],
    ]);
    const exported = await session.call<{ markdown: string }>("export_markdown", { uuid, frontmatter: false });
    expect(exported.markdown).toContain(`\`\`\`ablauf\n${SINGLE}\n\`\`\``);
  });
  expect(errors).toEqual([]);
});

for (const appearance of ["light", "dark"] as const) {
  test(`read-only iPad playback follows the pinned ${appearance} palette over the opposite system preference`, { tag: "@webkit-touch" }, async ({ browser }) => {
    const session = writer();
    const { uuid } = await session.call<{ uuid: string }>("create_doc", {
      title: `Read-only played Ablauf (${appearance})`, description: "A playable flow in an archived document.",
      blocks: [{ type: "code", language: "ablauf", text: PLAYED }],
    });
    await session.call("archive_doc", { uuid });
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      contextOptions: { ...devices["iPad Pro 11"], viewport: { width: 1024, height: 768 }, colorScheme: appearance === "light" ? "dark" : "light" },
      beforeNavigate: async page => {
        await page.addInitScript(theme => { localStorage.setItem("uberblick.settings.v1", JSON.stringify({ appearance: theme })); }, appearance);
      },
    });
    await waitForDocumentDraw(page, session, uuid, { source: PLAYED });
    await expect(page.locator("html")).toHaveAttribute("data-theme", appearance);
    await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
    const block = blocks(page).first();
    const touchPlay = block.getByRole("button", { name: "Play ablauf diagram", exact: true });
    await expect(touchPlay).toBeVisible();
    const bounds = await touchPlay.boundingBox();
    if (bounds === null) throw new Error("e2e: touch Play is missing");
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    await touchPlay.tap();
    await expect(toggle(block)).toHaveText("Pause");
    await expect(touchPlay).toBeHidden();
    await expect(page.getByRole("dialog", { name: "Ablauf diagram", exact: true })).toHaveCount(0);
    await activateControl(toggle(block));
    await expect(controls(block).locator(".abp-actor")).toHaveText("Author");

    const paint = await block.evaluate(element => {
      const probe = document.createElement("span");
      probe.style.color = "var(--ab-play)";
      probe.style.backgroundColor = "var(--ab-bg)";
      element.append(probe);
      const host = getComputedStyle(probe);
      const expected = { play: host.color, ground: host.backgroundColor };
      probe.remove();
      const root = element.querySelector(".ub-ablauf-playback")?.shadowRoot?.querySelector(".ab-playback");
      const actor = root?.querySelector(".abp-actor");
      const caption = root?.querySelector(".abp-caption");
      const tab = root?.querySelector('[role="tab"][aria-selected="true"]');
      if (!root || !actor || !caption || !tab) throw new Error("e2e: playback controls are missing");
      return {
        ...expected, scheme: getComputedStyle(root).colorScheme, actor: getComputedStyle(actor).color,
        tab: getComputedStyle(tab).color, caption: getComputedStyle(caption).color,
        page: getComputedStyle(document.body).backgroundColor,
      };
    });
    expect(paint.scheme).toContain(appearance);
    expect(paint.actor).toBe(paint.play);
    expect(paint.tab).toBe(paint.play);
    expect(contrast(paint.actor, paint.ground)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(paint.caption, paint.ground)).toBeGreaterThanOrEqual(4.5);
    await expect(svg(block).locator("[data-ab-part].ab-current")).not.toHaveCount(0);
  });
}
