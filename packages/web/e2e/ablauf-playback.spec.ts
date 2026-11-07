/** Ablauf's controls are always present; the reader alone starts playback. */
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
// Keep the current step stable while the reader operates the other drawing's controls.
const PLAYED = `${FLOW}\n\nplay "Happy path"\n  tempo 60s\n  step draft actor="Author" "Writes a draft"\n  step check actor="Reviewer" "Checks it"\n  step done\n\nplay "Quick"\n  step draft\n  step check`;
const SINGLE = `${FLOW.replace('"Draft"', '"Other draft"')}\n\nplay\n  step draft 60s actor="Author" "Takes a while"\n  step check`;
const SEQUENCE = 'sequence v0\nparticipant A "Author"\nparticipant H "Hub"\nA --> H: Send draft\nH -.-> A: Accepted\n\nplay "Submit"\n  tempo 1s\n  step 1 actor="Author" "Sends a draft"\n  step 2 "Receives approval"';

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
function controls(block: Locator): Locator { return block.locator(".ab-playback"); }
function toggle(block: Locator): Locator { return controls(block).locator(".abp-toggle"); }

async function hasClass(locator: Locator, name: string): Promise<boolean> {
  return locator.evaluate((element, className) => element.classList.contains(className), name);
}

async function expectStatic(block: Locator): Promise<void> {
  await expect(svg(block)).not.toHaveClass(/\bab-(playing|in-progress)\b/);
  await expect(svg(block).locator("[data-ab-part].ab-current, [data-ab-part].ab-played")).toHaveCount(0);
  await expect.poll(() => svg(block).locator("[data-ab-part]").evaluateAll(parts =>
    parts.every(part => getComputedStyle(part).opacity === "1"))).toBe(true);
}

/** Cross a real viewport observation and paint before checking that scrolling left a drawing static. */
async function waitForInView(block: Locator): Promise<void> {
  await svg(block).evaluate(element => new Promise<void>(resolve => {
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
    });
    observer.observe(element);
  }));
}

test("Tall playable drawings use side captions when the column permits and below captions when narrowed", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title: "Ablauf caption layout", description: "Native captions adapt to the reading column.",
    blocks: [{ type: "code", language: "ablauf", text: PLAYED }],
  });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    contextOptions: { viewport: { width: 1440, height: 1000 }, hasTouch: false, isMobile: false },
  });
  await waitForDocumentDraw(page, session, uuid, { source: PLAYED });
  await page.evaluate(() => document.fonts.ready);
  const block = blocks(page).first();
  await expect(controls(block)).toHaveClass(/\babp-side\b/);
  await expect(controls(block).locator(".abp-list .abp-remark").first()).toHaveText("Writes a draft");
  const beside = await controls(block).evaluate(root => {
    const figure = root.querySelector("svg");
    const caption = root.querySelector(".abp-list .abp-remark");
    if (figure === null || caption === null) throw new Error("e2e: side caption probes missing");
    return { gap: caption.getBoundingClientRect().left - figure.getBoundingClientRect().right,
      width: figure.getBoundingClientRect().width, natural: Number(figure.getAttribute("width")) };
  });
  expect(beside.gap).toBeGreaterThan(0);
  expect(beside.width).toBeCloseTo(beside.natural, 0);
  await page.addStyleTag({ content: ".ub-column { max-width: 480px; }" });
  await expect(controls(block)).toHaveClass(/\babp-below\b/);
  await expect(controls(block).locator(".abp-step")).toBeVisible();
  await expect.poll(() => controls(block).evaluate(root => {
    const figure = root.querySelector("svg");
    const caption = root.querySelector(".abp-step");
    if (figure === null || caption === null) throw new Error("e2e: below caption probes missing");
    return caption.getBoundingClientRect().top - figure.getBoundingClientRect().bottom;
  })).toBeGreaterThanOrEqual(0);
  await expectStatic(block);
});

test("A shrunken playable drawing shows the zoom cursor only where clicking opens the viewer", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const source = PLAYED.replace('"Draft"', `"${"Wide draft ".repeat(14)}"`);
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title: "Ablauf playback cursor", description: "Captions do not offer to expand the drawing.",
    blocks: [{ type: "code", language: "ablauf", text: source }],
  });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    contextOptions: { viewport: { width: 1440, height: 1000 }, hasTouch: false, isMobile: false },
  });
  await waitForDocumentDraw(page, session, uuid, { source });
  const block = blocks(page).first();
  await expect(controls(block)).toBeVisible();
  await controls(block).getByRole("button", { name: "Next", exact: true }).click();
  await expect(svg(block)).toHaveCSS("cursor", "zoom-in");
  for (const selector of [".abp-caption", ".abp-actor", ".abp-counter", ".abp-panel"]) {
    await expect(controls(block).locator(selector)).not.toHaveCSS("cursor", "zoom-in");
  }
  await controls(block).locator(".abp-caption").click();
  await expect(block.locator(".ab-viewer")).toHaveCount(0);
  await svg(block).click();
  await expect(block.locator(".ab-viewer")).toBeVisible();
  await expect(block.locator(".abv-canvas")).toHaveCSS("cursor", "grab");
  await expect(block.locator(".abv-canvas svg")).not.toHaveCSS("cursor", "zoom-in");
});

test("Playable drawings show idle controls, play independently and rebind without losing focus after source edits", async ({ browser }) => {
  const session = writer();
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title: "Played Ablauf", description: "Two playable flows around a static one.",
    blocks: [PLAYED, FLOW, SINGLE].map(text => ({ type: "code", language: "ablauf", text })),
  });
  const errors: string[] = [];
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    // Tall enough that all three drawings are in view at once.
    contextOptions: { viewport: { width: 1280, height: 1400 } },
    beforeNavigate: async page => {
      page.on("pageerror", error => errors.push(error.message));
    },
  });
  await waitForDocumentDraw(page, session, uuid, { index: "all" });
  const [first, plain, third] = [blocks(page).nth(0), blocks(page).nth(1), blocks(page).nth(2)];
  await expect(controls(plain)).toHaveCount(0);
  await expect(first.locator(".ub-figure-toolbar button")).toHaveText(["Source", "Expand"]);
  await expect(page.locator(".ub-ablauf-play, .ub-ablauf-touch-play")).toHaveCount(0);
  for (const block of [first, third]) {
    await waitForInView(block);
    await expect(controls(block)).toBeVisible();
    await expectStatic(block);
    await expect(toggle(block)).toHaveText("Play");
  }

  // An idle edit leaves the existing mount whole and waiting for the reader.
  const mounted = await controls(first).elementHandle();
  const mountedToggle = await toggle(first).elementHandle();
  const idleEdit = PLAYED.replace('"Draft"', '"Edited draft"');
  await editSource(session, uuid, 0, idleEdit);
  await waitForDocumentDraw(page, session, uuid, { index: 0, source: idleEdit });
  await expect(svg(first)).toContainText("Edited draft");
  await expectStatic(first);
  expect(await controls(first).evaluate((element, original) => element === original, mounted)).toBe(true);

  await toggle(first).click();
  await expect(toggle(first)).toHaveText("Pause");
  await expectStatic(third);
  await toggle(third).click();
  for (const block of [first, third]) {
    await expect(toggle(block)).toHaveText("Pause");
    await expect.poll(() => hasClass(svg(block), "ab-playing")).toBe(true);
    await expect(svg(block)).toHaveClass(/\bab-in-progress\b/);
    await expect(svg(block).locator("[data-ab-part].ab-current")).not.toHaveCount(0);
  }
  await expect(controls(first).getByRole("tab")).toHaveText(["Happy path", "Quick"]);
  await expect(controls(first).locator(".abp-caption")).toHaveText("Writes a draft");
  await expect(controls(third).getByRole("tab")).toHaveCount(0);
  await expect(controls(plain)).toHaveCount(0);
  expect(await hasClass(svg(plain), "ab-in-progress")).toBe(false);

  await activateControl(toggle(third));
  await expect(toggle(third)).toHaveText("Play");
  await expect(controls(third).locator(".abp-caption")).toHaveText("Takes a while");
  expect(await hasClass(svg(first), "ab-playing")).toBe(true);

  // Expand carries the live player into ablauf's viewer, then back to the block.
  await svg(first).hover();
  await first.getByRole("button", { name: "Expand ablauf diagram", exact: true }).click();
  const viewer = first.locator(".ab-viewer");
  await expect(viewer).toBeVisible();
  await expect(toggle(first)).toHaveText("Pause");
  await expect(controls(first).locator(".abp-caption")).toHaveText("Writes a draft");
  expect(await controls(first).evaluate((element, original) => element === original, mounted)).toBe(true);
  await viewer.getByRole("button", { name: "Close", exact: true }).click();
  await expect(viewer).toHaveCount(0);
  await expect(toggle(first)).toHaveText("Pause");

  // A collaborator edit interrupts playback without replacing focused controls.
  await toggle(first).focus();
  await expect(toggle(first)).toBeFocused();
  const edited = PLAYED.replace('"Draft"', '"First draft"');
  await editSource(session, uuid, 0, edited);
  await waitForDocumentDraw(page, session, uuid, { index: 0, source: edited });
  await expect(svg(first)).toContainText("First draft");
  await expect(controls(first)).toHaveCount(1);
  await expect(toggle(first)).toHaveText("Play");
  await expectStatic(first);
  await expect(toggle(first)).toBeFocused();
  expect(await controls(first).evaluate((element, original) => element === original, mounted)).toBe(true);
  expect(await toggle(first).evaluate((element, original) => element === original, mountedToggle)).toBe(true);
  await activateControl(toggle(first));
  await expect.poll(() => hasClass(svg(first), "ab-playing")).toBe(true);
  await expect(toggle(third)).toHaveText("Play");
  await expect(controls(third).locator(".abp-caption")).toHaveText("Takes a while");

  await toggle(first).click();
  await expect(toggle(first)).toHaveText("Play");
  await expect(svg(first)).toHaveClass(/\bab-in-progress\b/);
  const misspelled = `${edited}\n  step nowhere`;
  await editSource(session, uuid, 0, misspelled);
  await waitForDocumentDraw(page, session, uuid, { index: 0, source: misspelled });
  const line = misspelled.split("\n").length;
  await expect(first.locator(".ub-ablauf-diagnostics")).toContainText(`Line ${line}: error: unknown playback target \`nowhere\``);
  await expect(controls(first)).toHaveCount(1);
  await expectStatic(first);

  await editSource(session, uuid, 0, FLOW);
  await waitForDocumentDraw(page, session, uuid, { index: 0, source: FLOW });
  await expect(controls(first)).toHaveCount(0);
  await expectStatic(first);
  await expect(page.locator(".ab-viewer")).toHaveCount(0);

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

test("The playback chunk loads only after the first play section, and a local source edit resets it", async ({ browser }) => {
  const session = writer();
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title: "Ablauf starts without playback", description: "A static drawing gains its first scene.",
    blocks: [{ type: "code", language: "ablauf", text: FLOW }],
  });
  const requests: string[] = [];
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: async page => {
      page.on("request", request => {
        if (/\/assets\/ablauf-playback-[^/]+\.js(?:\?.*)?$/.test(request.url())) requests.push(request.url());
      });
    },
  });
  await waitForDocumentDraw(page, session, uuid, { source: FLOW });
  const block = blocks(page).first();
  await waitForInView(block);
  await expectStatic(block);
  await expect(controls(block)).toHaveCount(0);
  expect(requests).toEqual([]);

  await editSource(session, uuid, 0, PLAYED);
  await waitForDocumentDraw(page, session, uuid, { source: PLAYED });
  await expect(controls(block)).toBeVisible();
  await expectStatic(block);
  expect(requests).toHaveLength(1);
  await toggle(block).click();
  await expect(toggle(block)).toHaveText("Pause");
  const source = block.locator(".ub-ablauf-source");
  if (!await source.isVisible()) {
    await svg(block).hover();
    await block.getByRole("button", { name: "Open ablauf source", exact: true }).click();
  }
  await expect(source).toBeVisible();
  const addedCaption = ' actor="Local author" "Local source edit"';
  const edited = `${PLAYED}${addedCaption}`;
  await source.click();
  await page.keyboard.press("ControlOrMeta+End");
  await expect.poll(() => source.evaluate(element => {
    const selection = element.ownerDocument.getSelection();
    return selection?.isCollapsed === true && selection.focusNode !== null && element.contains(selection.focusNode);
  })).toBe(true);
  await page.keyboard.insertText(addedCaption);
  await waitForDocumentDraw(page, session, uuid, { source: edited });
  await expect(controls(block)).toBeVisible();
  await expect(toggle(block)).toHaveText("Play");
  await expectStatic(block);
});

test("Sequence play sections use ablauf's controls and the scene ends with the whole figure", async ({ browser }) => {
  const session = writer();
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title: "Played sequence", description: "A scene uses the sequence's numbered messages.",
    blocks: [{ type: "code", language: "ablauf", text: SEQUENCE }],
  });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await waitForDocumentDraw(page, session, uuid, { source: SEQUENCE });
  const block = blocks(page).first();
  await expect(controls(block)).toBeVisible();
  await expect(block.locator(".ub-ablauf-diagnostics")).toBeHidden();
  await expectStatic(block);
  await toggle(block).click();
  await expect(toggle(block)).toHaveText("Pause");
  await expect(svg(block).locator("[data-ab-part].ab-current")).not.toHaveCount(0);
  await expect(controls(block).locator(".abp-caption")).toHaveText("Sends a draft");
  await expect(toggle(block)).toHaveText("Replay");
  await expectStatic(block);
  await expect(controls(block)).toBeVisible();
  await expect(page.locator(".ab-viewer")).toHaveCount(0);
  await expectMcp(async () => {
    expect((await codeBlocks(session, uuid))[0]?.text).toBe(SEQUENCE);
    const exported = await session.call<{ markdown: string }>("export_markdown", { uuid, frontmatter: false });
    expect(exported.markdown).toContain(`\`\`\`ablauf\n${SEQUENCE}\n\`\`\``);
  });
});

test("a successful playback chunk retry removes the load error and preserves source diagnostics", async ({ browser }) => {
  const session = writer();
  const source = `${PLAYED}\n  step nowhere`;
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title: "Ablauf playback recovery", description: "Retry playback without losing source diagnostics.",
    blocks: [{ type: "code", language: "ablauf", text: source }],
  });
  const requests: string[] = [];
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    contextOptions: { reducedMotion: "reduce" },
    beforeNavigate: async page => {
      await page.route(/\/assets\/ablauf-playback-[^/]+\.js(?:\?.*)?$/, async route => {
        requests.push(route.request().url());
        if (requests.length === 1) {
          await route.fulfill({ status: 503, contentType: "text/javascript", headers: { "Cache-Control": "no-store" }, body: "Temporarily unavailable" });
        } else await route.continue();
      });
    },
  });
  await waitForDocumentDraw(page, session, uuid, { source });
  const block = blocks(page).first();
  const sourceDiagnostic = `Line ${source.split("\n").length}: error: unknown playback target \`nowhere\``;
  await expect(block.locator(".ub-ablauf-diagnostics")).toContainText(sourceDiagnostic);
  await expect(block).toContainText("Playback cannot be loaded:");
  await expect(block.locator(".ub-ablauf-diagnostics")).toContainText(sourceDiagnostic);
  await expectStatic(block);
  await expect(controls(block)).toHaveCount(0);
  const edited = source.replace('"Draft"', '"Retry draft"');
  await editSource(session, uuid, 0, edited);
  await waitForDocumentDraw(page, session, uuid, { source: edited });
  await expect(controls(block)).toBeVisible();
  await expectStatic(block);
  await expect(block).not.toContainText("Playback cannot be loaded:");
  await expect(block.locator(".ub-ablauf-diagnostics")).toContainText(sourceDiagnostic);
  expect(requests).toHaveLength(2);
  expect(new URL(requests[1] ?? "").search).toBe("?retry=1");
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`A playable drawing stays static when scrolled into view (${reducedMotion})`, async ({ browser }) => {
    const session = writer();
    const { uuid } = await session.call<{ uuid: string }>("create_doc", {
      title: "Played Ablauf below the fold", description: "Static flows above a playable one.",
      blocks: [FLOW, FLOW, FLOW, FLOW, FLOW, PLAYED].map(text => ({ type: "code", language: "ablauf", text })),
    });
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      contextOptions: { viewport: { width: 1280, height: 480 }, reducedMotion },
    });
    await waitForDocumentDraw(page, session, uuid, { index: "all" });
    const last = blocks(page).last();
    await expect(controls(last)).toBeAttached();
    await expect(toggle(last)).toHaveText("Play");
    await expect(svg(last)).not.toBeInViewport();
    await expectStatic(last);

    await svg(last).scrollIntoViewIfNeeded();
    await waitForInView(last);
    await expect(svg(last)).toBeInViewport();
    await expectStatic(last);
  });
}

test("Under reduced motion touch playback stays idle and its controls never open the viewer", { tag: "@webkit-touch" }, async ({ browser }) => {
  const session = writer();
  const { uuid } = await session.call<{ uuid: string }>("create_doc", {
    title: "Played Ablauf, reduced motion", description: "A playable flow for a reader who asked for less motion.",
    blocks: [{ type: "code", language: "ablauf", text: PLAYED }],
  });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    contextOptions: { ...devices["iPad Pro 11"], viewport: { width: 1024, height: 768 }, reducedMotion: "reduce" },
  });
  await waitForDocumentDraw(page, session, uuid, { source: PLAYED });
  const block = blocks(page).first();
  await expect(controls(block)).toBeVisible();
  await waitForInView(block);
  await expectStatic(block);
  const bounds = await toggle(block).boundingBox();
  if (bounds === null) throw new Error("e2e: ablauf's Play is missing");
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  await toggle(block).tap();
  await expect(controls(block).getByRole("tab")).toHaveText(["Happy path", "Quick"]);
  await expect(toggle(block)).toHaveText("Play");
  await expectStatic(block);
  await controls(block).getByRole("button", { name: "Next", exact: true }).tap();
  await expect(svg(block).locator("[data-ab-part].ab-current")).not.toHaveCount(0);
  await expect(page.locator(".ab-viewer")).toHaveCount(0);
  await controls(block).getByRole("button", { name: "Previous", exact: true }).tap();
  await expectStatic(block);
  await expect(page.locator(".ab-viewer")).toHaveCount(0);
});

for (const appearance of ["light", "dark"] as const) {
  test(`read-only iPad playback follows the pinned ${appearance} palette over the opposite system preference`, { tag: "@webkit-touch" }, async ({ browser }) => {
    const session = writer();
    const source = PLAYED.replace('\nend done', '\nbox approve "Approve"\nend done')
      .replace("check --> done : Accepted", "check --> approve : Accepted\napprove --> done")
      .replace("  step done", "  step approve\n  step done");
    const { uuid } = await session.call<{ uuid: string }>("create_doc", {
      title: `Read-only played Ablauf (${appearance})`, description: "A playable flow in an archived document.",
      blocks: [{ type: "code", language: "ablauf", text: source }],
    });
    await session.call("archive_doc", { uuid });
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      contextOptions: { ...devices["iPad Pro 11"], viewport: { width: 1024, height: 768 }, colorScheme: appearance === "light" ? "dark" : "light" },
      beforeNavigate: async page => {
        await page.addInitScript(theme => { localStorage.setItem("uberblick.settings.v1", JSON.stringify({ appearance: theme })); }, appearance);
      },
    });
    await waitForDocumentDraw(page, session, uuid, { source });
    await expect(page.locator("html")).toHaveAttribute("data-theme", appearance);
    await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
    const block = blocks(page).first();
    await expect(block.locator(".ub-ablauf-diagnostics")).toBeHidden();
    await expect(controls(block)).toBeVisible();
    await expectStatic(block);
    await toggle(block).tap();
    await expect(toggle(block)).toHaveText("Pause");
    await activateControl(toggle(block));
    await expect(controls(block).locator(".abp-actor")).toHaveText("Author");

    const layout = await controls(block).evaluate(async root => {
      await root.ownerDocument.fonts.ready;
      const bounds = root.getBoundingClientRect();
      const targets = [...root.querySelectorAll("button, .abp-segments:not(.abp-inactive) .abp-segment")]
        .filter(target => target.getClientRects().length > 0).map((target, index) => {
        const rect = target.getBoundingClientRect();
        return {
          name: target.getAttribute("aria-label") ?? (target.textContent?.trim() || `Step ${index - 4}`),
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
        };
      });
      return {
        left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
        width: root.clientWidth, scrollWidth: root.scrollWidth, viewportWidth: root.ownerDocument.documentElement.clientWidth,
        targets,
      };
    });
    // Both tabs, Previous/Play/Next and every visible step target, including
    // the caption list when ablauf's default layout places it beside the figure.
    expect(layout.targets.length).toBeGreaterThanOrEqual(9);
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
    for (const target of layout.targets) {
      expect(target.width, `${target.name} touch width`).toBeGreaterThanOrEqual(44);
      expect(target.height, `${target.name} touch height`).toBeGreaterThanOrEqual(44);
      expect(target.left, `${target.name} left edge`).toBeGreaterThanOrEqual(layout.left);
      expect(target.right, `${target.name} right edge`).toBeLessThanOrEqual(layout.right);
      expect(target.top, `${target.name} top edge`).toBeGreaterThanOrEqual(layout.top);
      expect(target.bottom, `${target.name} bottom edge`).toBeLessThanOrEqual(layout.bottom);
    }
    for (const [index, target] of layout.targets.entries()) {
      for (const other of layout.targets.slice(index + 1)) {
        const overlaps = Math.min(target.right, other.right) > Math.max(target.left, other.left)
          && Math.min(target.bottom, other.bottom) > Math.max(target.top, other.top);
        expect(overlaps, `${target.name} overlaps ${other.name}`).toBe(false);
      }
    }

    const paint = await block.evaluate(element => {
      const probe = document.createElement("span");
      probe.style.color = "var(--ab-play)";
      probe.style.backgroundColor = "var(--ab-bg)";
      element.append(probe);
      const host = getComputedStyle(probe);
      const expected = { play: host.color, ground: host.backgroundColor };
      probe.remove();
      const root = element.querySelector(".ub-ablauf-drawing")?.shadowRoot?.querySelector(".ab-playback");
      const actor = root?.querySelector(".abp-actor");
      const caption = root?.querySelector(".abp-caption");
      const tab = root?.querySelector('[role="tab"][aria-selected="true"]');
      if (!root || !actor || !caption || !tab) throw new Error("e2e: playback controls are missing");
      return {
        ...expected, scheme: getComputedStyle(root).colorScheme, actor: getComputedStyle(actor).color,
        tab: getComputedStyle(tab).color, caption: getComputedStyle(caption).color,
        textFont: getComputedStyle(caption).fontFamily, monoFont: getComputedStyle(actor).fontFamily,
      };
    });
    expect(paint.scheme).toContain(appearance);
    expect(paint.actor).toBe(paint.play);
    expect(paint.tab).toBe(paint.play);
    expect(contrast(paint.actor, paint.ground)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(paint.caption, paint.ground)).toBeGreaterThanOrEqual(4.5);
    expect(paint.textFont).toContain("Geist");
    expect(paint.textFont).not.toContain("Geist Mono");
    expect(paint.monoFont).toContain("Geist Mono");
    await expect(svg(block).locator("[data-ab-part].ab-current")).not.toHaveCount(0);

    await svg(block).tap();
    const viewer = block.locator(".ab-viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Source", exact: true })).toHaveCount(0);
    const viewerPaint = await viewer.evaluate(async dialog => {
      await dialog.ownerDocument.fonts.ready;
      const toolbar = dialog.querySelector(".abv-toolbar");
      const action = toolbar?.querySelector("button");
      if (toolbar === null || action === undefined || action === null) throw new Error("e2e: viewer toolbar is missing");
      return {
        scheme: getComputedStyle(dialog).colorScheme, ground: getComputedStyle(dialog).backgroundColor,
        ink: getComputedStyle(action).color, textFont: getComputedStyle(dialog).fontFamily,
        monoFont: getComputedStyle(action).fontFamily,
        targets: [...toolbar.querySelectorAll("button")].map(button => {
          const bounds = button.getBoundingClientRect();
          return { name: button.getAttribute("aria-label") ?? button.textContent, width: bounds.width, height: bounds.height };
        }),
      };
    });
    expect(viewerPaint.scheme).toContain(appearance);
    expect(viewerPaint.ground).toBe(paint.ground);
    expect(contrast(viewerPaint.ink, viewerPaint.ground)).toBeGreaterThanOrEqual(4.5);
    expect(viewerPaint.textFont).toContain("Geist");
    expect(viewerPaint.textFont).not.toContain("Geist Mono");
    expect(viewerPaint.monoFont).toContain("Geist Mono");
    for (const target of viewerPaint.targets) {
      expect(target.width, `${target.name} viewer touch width`).toBeGreaterThanOrEqual(44);
      expect(target.height, `${target.name} viewer touch height`).toBeGreaterThanOrEqual(44);
    }
    await viewer.getByRole("button", { name: "Close", exact: true }).tap();
    await expect(viewer).toHaveCount(0);
  });
}
