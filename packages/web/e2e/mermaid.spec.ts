/** Mermaid drawings keep source, permissions and failures local to their block. */
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { activateControl, editor, setupHarness } from "./app-helpers.js";
import { legacyDecisionPeer } from "./legacy-decision-peer.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
const peers: Array<{ close(): void }> = [];
const SOURCE = "flowchart LR\n  Start --> Finish[Finish]";
const CHUNK = /\/assets\/mermaid-renderer-[^/]+\.js(?:\?|$)/;

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: `uberblick-e2e-mermaid-${process.env.UB_AGENTS_RUN ?? "local"}-`,
  });
});
test.afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  await agent?.closeSessions();
});
test.afterAll(async () => { await agent?.close(); agent = null; });

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: Mermaid MCP agent is not configured");
  return agent.open({ name: "mermaid-e2e" });
}

interface Block { id: string; type: string; text: string; rev: string }
interface Document { uuid: string; blocks: Block[] }

async function mermaidDoc(session: McpSession, title: string, sources = [SOURCE]): Promise<string> {
  return (await session.call<{ uuid: string }>("create_doc", {
    title, description: "Mermaid browser proof with literal source.",
    blocks: [{ type: "paragraph", text: "Neighbor prose." },
      ...sources.map((text) => ({ type: "mermaid", text }))],
  })).uuid;
}

async function storedBlock(session: McpSession, uuid: string, index = 0): Promise<Block> {
  const doc = await session.call<Document>("get_doc", { uuid });
  const block = doc.blocks.filter((entry) => entry.type === "mermaid")[index];
  if (block === undefined) throw new Error("e2e: stored Mermaid block is missing");
  return block;
}

async function editSource(session: McpSession, uuid: string, text: string, index = 0): Promise<void> {
  const block = await storedBlock(session, uuid, index);
  await session.call("edit_block", { uuid, block_id: block.id, rev: block.rev,
    old_text: block.text, new_text: text });
}

function block(page: Page, index = 0): Locator { return page.locator(".ub-mermaid").nth(index); }
function drawing(page: Page, index = 0): Locator { return block(page, index).locator(".ub-mermaid-panel svg"); }
function source(page: Page, index = 0): Locator { return block(page, index).locator(".ub-mermaid-source"); }
function openSource(page: Page, index = 0): Locator {
  return block(page, index).getByRole("button", { name: "Open Mermaid source", exact: true });
}
function neighbor(page: Page): Locator { return editor(page).locator(":scope > p").first(); }

async function authoredText(target: Locator): Promise<string> {
  return target.evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement;
    for (const cursor of copy.querySelectorAll(".ProseMirror-yjs-cursor")) cursor.remove();
    return copy.textContent ?? "";
  });
}

async function sourceCaret(page: Page) {
  return source(page).evaluate((element) => {
    const selection = document.getSelection();
    const mounted = element.closest(".ProseMirror") as HTMLElement & {
      editor: { state: { selection: { from: number; to: number } } };
    };
    if (selection?.focusNode === null || selection?.focusNode === undefined || !element.contains(selection.focusNode)) return null;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.setEnd(selection.focusNode, selection.focusOffset);
    const content = range.cloneContents();
    for (const cursor of content.querySelectorAll(".ProseMirror-yjs-cursor")) cursor.remove();
    return { collapsed: selection.isCollapsed, prefix: content.textContent,
      focused: document.activeElement === mounted,
      from: mounted.editor.state.selection.from, to: mounted.editor.state.selection.to };
  });
}

async function caretEnd(target: Locator): Promise<void> {
  await target.evaluate((element) => element.closest<HTMLElement>(".ProseMirror")?.focus());
  await target.page().evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  await target.evaluate((element) => {
    const texts = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (text) => text.parentElement?.closest(".ProseMirror-yjs-cursor") === null
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    let last: Node | null = null;
    while (texts.nextNode()) last = texts.currentNode;
    if (last === null) throw new Error("e2e: Mermaid source has no text");
    const range = document.createRange();
    range.setStart(last, last.textContent?.length ?? 0);
    range.collapse(true);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await target.page().keyboard.press("Shift");
  await expect.poll(() => target.evaluate((element) => {
    const selection = document.getSelection();
    return selection?.isCollapsed === true && element.contains(selection.focusNode)
      && selection.focusOffset === selection.focusNode?.textContent?.length;
  })).toBe(true);
  await target.page().evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function appendStatement(page: Page, text: string): Promise<void> {
  await activateControl(openSource(page));
  await caretEnd(source(page));
  const before = await authoredText(source(page));
  const suffix = `; ${text.trimStart()}`;
  await page.keyboard.type(suffix, { delay: 5 });
  await expect.poll(() => authoredText(source(page))).toBe(`${before}${suffix}`);
}

async function copySource(page: Page, index = 0): Promise<string | null> {
  await page.evaluate(() => {
    document.documentElement.removeAttribute("data-mermaid-copy");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => document.documentElement.setAttribute("data-mermaid-copy", text),
    } });
  });
  await activateControl(block(page, index).getByRole("button", { name: "Copy", exact: true }));
  await expect(page.locator("html")).toHaveAttribute("data-mermaid-copy", /./s);
  return page.locator("html").getAttribute("data-mermaid-copy");
}

async function expectReady(page: Page, label = "Finish", index = 0): Promise<void> {
  await expect(block(page, index)).toHaveAttribute("data-state", "ready");
  await expect(drawing(page, index)).toBeVisible();
  await expect(drawing(page, index)).toContainText(label);
  const geometry = await drawing(page, index).boundingBox();
  expect(geometry?.width).toBeGreaterThan(0);
  expect(geometry?.height).toBeGreaterThan(0);
}

interface LayoutSample { sourceOffset: number; sourceVisible: boolean; errorVisible: boolean }
interface LayoutProbe { running: boolean; samples: LayoutSample[] }

async function observeLayout(target: Locator): Promise<() => Promise<LayoutSample[]>> {
  await target.evaluate((element) => {
    const root = element.closest(".ub-mermaid");
    const error = root?.querySelector(".ub-mermaid-error");
    if (root === null || error === null || error === undefined) throw new Error("e2e: Mermaid layout probe is missing chrome");
    const probe: LayoutProbe = { running: true, samples: [] };
    (element as HTMLElement & { mermaidLayoutProbe: LayoutProbe }).mermaidLayoutProbe = probe;
    const sample = () => {
      if (!probe.running) return;
      probe.samples.push({
        sourceOffset: element.getBoundingClientRect().top - root.getBoundingClientRect().top,
        sourceVisible: element.getClientRects().length > 0,
        errorVisible: error.getClientRects().length > 0,
      });
      requestAnimationFrame(sample);
    };
    sample();
  });
  return () => target.evaluate((element) => {
    const probe = (element as HTMLElement & { mermaidLayoutProbe: LayoutProbe }).mermaidLayoutProbe;
    probe.running = false;
    return probe.samples;
  });
}

test("pending redraws keep tall diagrams and readable failure states in place", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const tall = "flowchart TD\n  N0[Start] --> N1[One] --> N2[Two] --> N3[Three] --> N4[Four] --> N5[Five] --> N6[Finish]\n%% Stable drawing ";
  const uuid = await mermaidDoc(session, "Mermaid stable redraw layout", [tall]);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await expectReady(page);
  expect((await drawing(page).boundingBox())?.height).toBeGreaterThan(400);
  expect(await drawing(page).locator(".nodeLabel").first().evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Geist");
  await activateControl(openSource(page));
  await caretEnd(source(page));
  const previous = await drawing(page).elementHandle();
  if (previous === null) throw new Error("e2e: initial tall Mermaid diagram is missing");
  const finishLayout = await observeLayout(source(page));
  await page.keyboard.type("keeps source in place while typing", { delay: 25 });
  await expect.poll(() => authoredText(source(page))).toBe(`${tall}keeps source in place while typing`);
  await expect.poll(() => previous.evaluate((element) => element.isConnected)).toBe(false);
  await expectReady(page);
  const samples = await finishLayout();
  expect(samples.length).toBeGreaterThan(5);
  const baseline = samples[0]?.sourceOffset;
  if (baseline === undefined) throw new Error("e2e: Mermaid layout baseline is missing");
  // Comment edits preserve diagram geometry; only native viewport scrolling may move the block.
  expect(Math.max(...samples.map((sample) => Math.abs(sample.sourceOffset - baseline)))).toBeLessThanOrEqual(1);
  expect(samples.every((sample) => sample.sourceVisible)).toBe(true);

  await activateControl(neighbor(page));
  const invalid = "flowchart TD\n  N0 -->";
  await editSource(session, uuid, invalid);
  await expect(block(page)).toHaveAttribute("data-state", "error");
  const error = block(page).locator(".ub-mermaid-error");
  await expect(error).toBeVisible();
  await expect(source(page)).toBeVisible();
  const previousError = await error.evaluateHandle((element) => element.firstChild);
  const finishFailureLayout = await observeLayout(source(page));
  await editSource(session, uuid, `${invalid} `);
  await expect.poll(() => authoredText(source(page))).toBe(`${invalid} `);
  await expect.poll(() => previousError.evaluate((node) => node?.isConnected ?? false)).toBe(false);
  await expect(block(page)).toHaveAttribute("data-state", "error");
  const failures = await finishFailureLayout();
  expect(failures.length).toBeGreaterThan(1);
  expect(failures.every((sample) => sample.sourceVisible && sample.errorVisible)).toBe(true);
  await expect(drawing(page)).toHaveCount(0);
});

test("typing, collaborator edits and MCP edits redraw while preserving source and comment anchors", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const uuid = await mermaidDoc(session, "Mermaid live source");
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  const peer = await openApp(browser, `/${harness().workspace}/${uuid}`, { upstream: true });
  for (const client of [page, peer]) {
    await expectReady(client);
    await expect(source(client)).toBeHidden();
    expect(await copySource(client)).toBe(SOURCE);
  }
  await openSource(page).focus();
  await page.keyboard.press("Enter");
  await expect(source(page)).toBeVisible();
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => source(page).evaluate((element) => element.contains(document.getSelection()?.focusNode ?? null))).toBe(true);
  await appendStatement(page, "Finish --> Local[Local update]");
  const localCaret = await sourceCaret(page);
  expect(localCaret).toMatchObject({ collapsed: true, focused: true, prefix: await authoredText(source(page)) });
  for (const client of [page, peer]) await expectReady(client, "Local update");
  await expect.poll(() => sourceCaret(page)).toEqual(localCaret);
  await appendStatement(peer, "Local --> Peer[Collaborator update]");
  const peerCaret = await sourceCaret(peer);
  expect(peerCaret).toMatchObject({ collapsed: true, focused: true, prefix: await authoredText(source(peer)) });
  for (const client of [page, peer]) await expectReady(client, "Collaborator update");
  await expect.poll(() => sourceCaret(peer)).toEqual(peerCaret);
  await editSource(session, uuid, SOURCE.replace("Finish[Finish]", "Finish[MCP update]"));
  for (const client of [page, peer]) await expectReady(client, "MCP update");
  await activateControl(neighbor(page));
  await expect(source(page)).toBeHidden();
  const before = await storedBlock(session, uuid);
  const start = before.text.indexOf("MCP update");
  await session.call("annotate", { uuid, block_id: before.id, start, end: start + 3,
    text: "Keep the comment anchored to the literal source." });
  await expect(source(page)).toBeVisible();
  await expect(source(page).locator("[data-comment-thread]")).toHaveText("MCP");
  await appendStatement(page, "Finish --> Annotated[Annotated edit]");
  await expectReady(page, "Annotated edit");
  await activateControl(neighbor(page));
  await expect(source(page)).toBeVisible();
  await expect(source(page).locator("[data-comment-thread]")).toHaveText("MCP");
  const stored = await storedBlock(session, uuid);
  expect(stored.type).toBe("mermaid");
  expect(stored.text).toBe(`${before.text}; Finish --> Annotated[Annotated edit]`);
  expect(await copySource(page)).toBe(stored.text);
  expect((await session.call<{ markdown: string }>("export_markdown", { uuid, frontmatter: false })).markdown)
    .toContain(`\`\`\`mermaid\n${stored.text}\n\`\`\``);
});

test("invalid and unsupported source clears only its diagram and recovers without a reload", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const uuid = await mermaidDoc(session, "Mermaid isolated errors", [SOURCE, "sequenceDiagram\n  Alice->>Bob: Neighbor diagram"]);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await expectReady(page);
  await expectReady(page, "Neighbor diagram", 1);
  const neighborDrawing = await drawing(page, 1).elementHandle();
  if (neighborDrawing === null) throw new Error("e2e: neighbor diagram is missing");
  for (const [text, message] of [
    ["flowchart LR\n  A -->", /parse|syntax|expecting/i],
    ["unknownDiagram\n  unreadable?", /diagram|unknown|unsupported/i],
    [`${SOURCE}\n%%${"x".repeat(60_000)}`, /maximum|size|limit|exceed/i],
  ] as const) {
    const previousError = await block(page).locator(".ub-mermaid-error").evaluateHandle((element) => element.firstChild);
    await editSource(session, uuid, text);
    await expect.poll(() => authoredText(source(page))).toBe(text);
    await expect(block(page)).toHaveAttribute("data-state", "error");
    await expect.poll(() => previousError.evaluate((node) => node?.isConnected ?? false)).toBe(false);
    await expect(block(page).locator(".ub-mermaid-error")).toContainText(message);
    await expect(source(page)).toBeVisible();
    expect(await authoredText(source(page))).toBe(text);
    await expect(drawing(page)).toHaveCount(0);
    await expectReady(page, "Neighbor diagram", 1);
    expect(await page.evaluate(() => document.querySelectorAll('svg[id^="ub-mermaid-"], #dmermaid, #dmermaid-error').length)).toBe(0);
    expect(await neighborDrawing.evaluate((element) => element.isConnected)).toBe(true);
    await expect(neighbor(page)).toHaveText("Neighbor prose.");
  }
  await editSource(session, uuid, SOURCE);
  await expectReady(page);
  await expect(block(page).locator(".ub-mermaid-error")).toBeHidden();
});

test("locked and archived documents draw and reveal source without allowing edits or writing document content", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const uuid = await mermaidDoc(session, "Mermaid locked content");
  const before = await session.call<Document>("get_doc", { uuid });
  const peer = await legacyDecisionPeer(harness(), uuid);
  peers.push(peer);
  peer.decide("decided");
  for (const archived of [false, true]) {
    if (archived) await session.call("archive_doc", { uuid });
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await expectReady(page);
    await expect(source(page)).toBeHidden();
    await activateControl(openSource(page));
    await expect(source(page)).toBeVisible();
    await activateControl(source(page));
    await page.keyboard.type("must stay unchanged");
    expect(await authoredText(source(page))).toBe(SOURCE);
    expect(await copySource(page)).toBe(SOURCE);
    expect((await session.call<Document>("get_doc", { uuid })).blocks).toEqual(before.blocks);
  }
});

test("renderer download and unsupported-runtime failures keep readable source and working controls", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const uuid = await mermaidDoc(session, "Mermaid unavailable renderer", [SOURCE, SOURCE.replaceAll("Finish", "Other")]);
  for (const failure of ["download", "runtime"] as const) {
    const requested: string[] = [];
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      beforeNavigate: async (client) => {
        if (failure === "download") await client.route(CHUNK, async (route) => {
          requested.push(route.request().url());
          await route.abort("failed");
        });
        else await client.addInitScript(() => Object.defineProperty(Promise, "withResolvers", { value: undefined, configurable: true }));
      },
    });
    for (const index of [0, 1]) {
      await expect(block(page, index)).toHaveAttribute("data-state", "error");
      await expect(block(page, index).locator(".ub-mermaid-error")).toContainText(/cannot|unavailable|unsupported|could not|failed/i);
      await expect(source(page, index)).toBeVisible();
      await expect(drawing(page, index)).toHaveCount(0);
      await activateControl(openSource(page, index));
      expect(await copySource(page, index)).toBe(index === 0 ? SOURCE : SOURCE.replaceAll("Finish", "Other"));
    }
    if (failure === "download") expect(requested.length).toBeGreaterThan(0);
    const previousError = await block(page).locator(".ub-mermaid-error").evaluateHandle((element) => element.firstChild);
    await appendStatement(page, "Finish --> Editable[Still editable]");
    await expect.poll(async () => (await storedBlock(session, uuid)).text).toContain("Still editable");
    await expect.poll(() => previousError.evaluate((node) => node?.isConnected ?? false)).toBe(false);
    await expect(block(page)).toHaveAttribute("data-state", "error");
    await expect(neighbor(page)).toHaveText("Neighbor prose.");
    await editSource(session, uuid, SOURCE);
  }
});

test("documents without Mermaid never fetch the renderer, and viewing source or switching appearance writes no block", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const plain = await mermaidDoc(session, "No Mermaid download", []);
  const uuid = await mermaidDoc(session, "Lazy Mermaid download");
  const requests: string[] = [];
  const page = await openApp(browser, `/${harness().workspace}/${plain}`, {
    beforeNavigate: async (client) => {
      client.on("request", (request) => { if (CHUNK.test(request.url())) requests.push(request.url()); });
    },
  });
  await expect(neighbor(page)).toHaveText("Neighbor prose.");
  await activateControl(neighbor(page));
  await page.keyboard.type(" Plain editing.");
  expect(requests).toEqual([]);
  const before = await session.call<Document>("get_doc", { uuid });
  await page.goto(new URL(`/${harness().workspace}/${uuid}`, harness().appUrl).href);
  await expectReady(page);
  expect(requests.length).toBeGreaterThan(0);
  await activateControl(openSource(page));
  expect(await copySource(page)).toBe(SOURCE);
  await activateControl(neighbor(page));
  const lightDrawing = await drawing(page).elementHandle();
  if (lightDrawing === null) throw new Error("e2e: initial Mermaid diagram is missing");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await expect.poll(() => lightDrawing.evaluate((element) => element.isConnected)).toBe(false);
  await expectReady(page);
  expect((await session.call<Document>("get_doc", { uuid })).blocks).toEqual(before.blocks);
});

test("strict rendering prevents source callbacks, script execution and styles outside the block", { tag: "@webkit" }, async ({ browser }) => {
  const session = writer();
  const uuid = await mermaidDoc(session, "Mermaid hostile source");
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: async (client) => {
      await client.addInitScript(() => {
        (window as unknown as { mermaidAttack: number; mermaidCallback(): void }).mermaidAttack = 0;
        (window as unknown as { mermaidCallback(): void }).mermaidCallback = () => {
          (window as unknown as { mermaidAttack: number }).mermaidAttack += 1;
        };
      });
    },
  });
  await expectReady(page);
  const paint = () => neighbor(page).evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor, size: style.fontSize };
  });
  const before = await paint();
  await page.evaluate(() => {
    const paragraph = document.querySelector(".ub-editor .ProseMirror > p");
    if (paragraph === null) throw new Error("e2e: no outside-content style probe");
    const paint = () => {
      const style = getComputedStyle(paragraph);
      return { color: style.color, background: style.backgroundColor, size: style.fontSize };
    };
    const outsidePaints = [paint()];
    (window as unknown as { outsidePaints: typeof outsidePaints }).outsidePaints = outsidePaints;
    new MutationObserver(() => { outsidePaints.push(paint()); }).observe(document.body, { childList: true, subtree: true });
  });
  const body = ["flowchart LR",
    '  Start["<img src=x onerror=mermaidCallback()><script>mermaidCallback()</script>Label"] --> Finish',
    "  click Finish call mermaidCallback()",
  ].join("\n");
  const css = ".ub-title, .ub-paragraph, body { color: red !important; font-size: 99px !important; }";
  const hostileSources = [
    `%%{init: ${JSON.stringify({ securityLevel: "loose", themeCSS: css, secure: [],
      dompurifyConfig: { ADD_TAGS: ["script"], ADD_ATTR: ["onerror", "onclick"] } })}}%%\n${body}`,
    `---\nconfig:\n  securityLevel: loose\n  themeCSS: '${css}'\n  secure: []\n  dompurifyConfig:\n    ADD_TAGS: [script]\n    ADD_ATTR: [onerror, onclick]\n---\n${body}`,
    `${SOURCE}\n  classDef outside fill:red,stroke:red} .ub-paragraph {color:red!important\n  class Finish outside`,
  ];
  for (const hostile of hostileSources) {
    const previousDrawing = await drawing(page).elementHandle();
    if (previousDrawing === null) throw new Error("e2e: previous hostile-source diagram is missing");
    await editSource(session, uuid, hostile);
    await expect.poll(() => authoredText(source(page))).toBe(hostile);
    await expect.poll(() => previousDrawing.evaluate((element) => element.isConnected)).toBe(false);
    if (hostile === hostileSources[2]) {
      await expect(block(page)).toHaveAttribute("data-state", "error");
      await expect(block(page).locator(".ub-mermaid-error")).toContainText(/parse|syntax|expecting|lexical/i);
      await expect(drawing(page)).toHaveCount(0);
      await expect(source(page)).toBeVisible();
    } else {
      await expectReady(page);
      await activateControl(drawing(page).locator(".node").last());
      await expect(drawing(page).locator("script, a, [onerror], [onclick]")).toHaveCount(0);
      expect(await drawing(page).evaluate((element) => element.getRootNode() instanceof ShadowRoot)).toBe(true);
    }
    expect(await page.evaluate(() => (window as unknown as { mermaidAttack: number }).mermaidAttack)).toBe(0);
    expect(await paint()).toEqual(before);
    expect((await storedBlock(session, uuid)).text).toBe(hostile);
  }
  await editSource(session, uuid, SOURCE);
  await expect.poll(() => authoredText(source(page))).toBe(SOURCE);
  await expectReady(page);
  const paints = await page.evaluate(() => (window as unknown as { outsidePaints: typeof before[] }).outsidePaints);
  expect(paints.every((paint) => JSON.stringify(paint) === JSON.stringify(before))).toBe(true);
  expect(await page.evaluate(() => document.querySelectorAll('svg[id^="ub-mermaid-"]').length)).toBe(0);
});

test("desktop and iPad diagrams fit the column and redraw legibly in light and dark appearance", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer();
  const wide = `flowchart LR\n  ${Array.from({ length: 12 }, (_, index) => `N${index}[Long label ${index}]`).join(" --> ")}`;
  const uuid = await mermaidDoc(session, "Mermaid fit and appearance", [wide]);
  for (const touch of [false, true]) {
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      contextOptions: { ...(touch ? devices["iPad Pro 11"] : { viewport: { width: 1280, height: 800 } }), colorScheme: "light" },
    });
    await expectReady(page, "Long label 11");
    const node = drawing(page).locator(".node rect").first();
    const light = await node.evaluate((element) => getComputedStyle(element).fill);
    for (const appearance of ["light", "dark"] as const) {
      if (appearance === "dark") {
        const previous = await drawing(page).elementHandle();
        if (previous === null) throw new Error("e2e: appearance drawing is missing");
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
        await expect.poll(() => previous.evaluate((element) => element.isConnected)).toBe(false);
        await expectReady(page, "Long label 11");
        expect(await node.evaluate((element) => getComputedStyle(element).fill)).not.toBe(light);
      }
      await activateControl(openSource(page), { touch });
      await expect(source(page)).toBeVisible();
      await activateControl(neighbor(page), { touch });
      await expect(source(page)).toBeHidden();
      expect(await page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>(".ub-pane");
        return pane !== null && pane.scrollWidth <= pane.clientWidth && document.documentElement.scrollWidth <= innerWidth;
      })).toBe(true);
      const panel = block(page).locator(".ub-mermaid-panel");
      const fitsOrScrolls = await panel.evaluate((element) => {
        const svg = element.shadowRoot?.querySelector("svg");
        if (svg === null || svg === undefined) return false;
        const bounds = svg.getBoundingClientRect();
        return bounds.width <= element.clientWidth + 1 || ["auto", "scroll"].includes(getComputedStyle(element).overflowX);
      });
      expect(fitsOrScrolls).toBe(true);
      const name = `mermaid-${touch ? "ipad" : "desktop"}-${appearance}`;
      const path = info.outputPath(`${name}.png`);
      await block(page).screenshot({ path });
      await info.attach(name, { path, contentType: "image/png" });
    }
    // The system preference route also replaces the diagram when no explicit appearance is set.
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
    await expect.poll(() => node.evaluate((element) => getComputedStyle(element).fill)).toBe(light);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => node.evaluate((element) => getComputedStyle(element).fill)).not.toBe(light);
  }
});
