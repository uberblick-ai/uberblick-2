/** Old diagrams disappear; imported fences use the ordinary code editor. */
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { getBlocksFragment, importMarkdown, roomForDoc } from "@uberblick/schema";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import { wrapToken } from "@uberblick/schema/protocol";
import { editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import { expectMcp, proveMcpArrival } from "./settle.js";

const { harness, openApp } = setupHarness();
const SOURCE = "flowchart LR\n  Start --> Finish";
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = new McpAgent({ workspace: harness().workspace, hubUrl: harness().hubUrl,
    authSecret: harness().authSecret, statePrefix: "uberblick-e2e-mermaid-removal-" });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

test("an imported mermaid fence is editable, copyable, commentable code with no Mermaid menu entry", { tag: "@webkit" }, async ({ browser }) => {
  if (agent === null) throw new Error("e2e: writer is missing");
  const writer = agent.open({ name: "mermaid-code-e2e" });
  const imported = importMarkdown(`Neighbor paragraph.\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\``);
  expect(imported.blocks[1]).toMatchObject({ type: "code", language: "mermaid", text: SOURCE });
  const { uuid } = await writer.call<{ uuid: string }>("create_doc", {
    title: "Imported Mermaid code", description: "Mermaid fences stay ordinary source code.", blocks: imported.blocks,
  });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: async page => { await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true,
        value: { writeText: async (text: string) => document.documentElement.setAttribute("data-copied", text) } });
    }); },
    contextOptions: { viewport: { width: 1366, height: 900 }, hasTouch: false, isMobile: false },
  });
  const block = page.locator('.ub-code[data-language="mermaid"]');
  const source = block.locator(":scope > code");
  await expect(source).toHaveText(SOURCE);
  await expect(block.locator(".ub-code-caption")).toContainText("Mermaid");
  await expect(block.locator("svg, canvas, .hljs-keyword")).toHaveCount(0);
  await source.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(" revised");
  const revised = `${SOURCE} revised`;
  await expect(source).toHaveText(revised);
  await block.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-copied", revised);

  const box = await source.boundingBox();
  if (box === null) throw new Error("e2e: source has no geometry");
  await page.mouse.move(box.x + 1, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 65, box.y + 8, { steps: 8 });
  await page.mouse.up();
  const composer = page.locator('[data-slot="selection-composer"]');
  await composer.getByRole("button", { name: /^Comment on Code block/ }).click();
  await page.getByPlaceholder(/Comment as/).fill("Keep this source as code.");
  await composer.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(source.locator("[data-comment-thread]")).not.toHaveCount(0);
  await expect(page.getByRole("region", { name: "Threads", exact: true })).toContainText("Keep this source as code.");
  await page.locator(".ub-editor .ProseMirror > p").first().hover();
  await page.getByRole("button", { name: "Insert block below" }).click();
  await page.getByRole("combobox", { name: "Search blocks" }).fill("mermaid");
  await expect(page.getByRole("listbox", { name: "Block types" }).getByRole("option")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await proveMcpArrival(page, writer, uuid, { path: "upstream" });
  await expectMcp(async () => {
    const doc = await writer.call<{ blocks: Array<{ type: string; language?: string; text: string }> }>("get_doc", { uuid });
    expect(doc.blocks[1]).toMatchObject({ type: "code", language: "mermaid", text: revised });
  });
  await expectMcp(async () => {
    const exported = await writer.call<{ markdown: string }>("export_markdown", { uuid });
    expect(exported.markdown).toContain(`\`\`\`mermaid\n${revised}\n\`\`\``);
  });
});

test("a Mermaid write from an old peer disappears while the open document stays editable", { tag: "@webkit" }, async ({ browser }) => {
  if (agent === null) throw new Error("e2e: writer is missing");
  const writer = agent.open({ name: "mermaid-old-peer-e2e" });
  const { uuid } = await writer.call<{ uuid: string }>("create_doc", {
    title: "Old Mermaid write", description: "A removed type cannot disable an open editor.",
    blocks: [{ type: "paragraph", text: "Still editable" }],
  });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, { upstream: true });
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  const secret = await importRootSecret(harness().authSecret);
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({ url: harness().hubUrl,
    name: roomForDoc(harness().workspaceUuid, uuid), document: doc,
    token: async () => wrapToken(await mintToken(secret, { typ: "room", sub: randomUUID(),
      workspace: harness().workspaceUuid, scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS })),
  });
  try {
    await new Promise<void>(resolve => provider.on("synced", resolve));
    const old = new Y.XmlElement("mermaid");
    old.setAttribute("id", randomUUID()); old.insert(0, [new Y.XmlText(SOURCE)]);
    getBlocksFragment(doc).insert(1, [old]);
    await expect.poll(() => getBlocksFragment(doc).length).toBe(1);
    await expect(page.getByText("Editor disabled", { exact: false })).toHaveCount(0);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await editor(page).locator(":scope > p").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText(" after removal");
    await expect(editor(page)).toHaveText("Still editable after removal");
    await expectMcp(async () => {
      const stored = await writer.call<{ blocks: Array<{ type: string; text: string }> }>("get_doc", { uuid });
      expect(stored.blocks).toMatchObject([{ type: "paragraph", text: "Still editable after removal" }]);
    });
  } finally { provider.destroy(); doc.destroy(); }
});
