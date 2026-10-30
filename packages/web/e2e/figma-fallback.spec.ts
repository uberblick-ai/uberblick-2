import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { expect, test } from "@playwright/test";
import {
  appendBlock, createAnnotation, findBlockElement, getBlockInline, getMeta,
  listAnnotationRanges, roomForDoc,
} from "@uberblick/schema";
import { wrapToken } from "@uberblick/schema/protocol";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import * as Y from "yjs";
import { docTitle, editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import { expectMcp, proveBrowserArrival, proveMcpArrival } from "./settle.js";
import { mockFigmaLookup } from "./figma-fixtures.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-figma-fallback-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

interface StoredDoc {
  uuid: string;
  blocks: Array<{ id: string; type: string; text: string; rev: string }>;
}

const reference = {
  type: "figma",
  text: "url: https://figma.com/design/k3Lm9QzT2x/Checkout-flow?node-id=12-345&t=Tracking\n" +
    "title: Payment, mobile\nheight: 560\n\nA **marked** design reference.",
};

for (const arrivesWhileBound of [false, true]) {
  test(`a supported Figma block ${arrivesWhileBound ? "arriving during editing" : "already stored"} keeps the document editable and intact`, async ({ browser }) => {
    if (agent === null) throw new Error("e2e: the MCP agent is not configured");
    const writer = agent.open({ name: "figma-fallback-e2e" });
    const created = await writer.call<StoredDoc>("create_doc", {
      title: docTitle("Design reference"), description: "Synthetic Figma safety fixture.",
      blocks: [{ type: "paragraph", text: "Context stays intact." }, ...(arrivesWhileBound ? [] : [reference])],
    });
    const figmaRequests: string[] = [];
    const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
      upstream: true,
      beforeNavigate: async (target) => {
        await mockFigmaLookup(target);
        await target.route("https://embed.figma.com/**", async (route) => {
          figmaRequests.push(route.request().url());
          await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Figma fixture</title>" });
        });
      },
    });
    if (arrivesWhileBound) {
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      await writer.call("insert_block", {
        uuid: created.uuid, after_block_id: created.blocks[0]?.id,
        blocks: [{ ...reference }],
      });
    }
    const before = await writer.call<StoredDoc>("get_doc", { uuid: created.uuid });
    const view = page.locator(".ub-figma");
    await expect(view).toBeVisible();
    await expect(view.locator("iframe")).toHaveAttribute("title", "Payment, mobile");
    await expect(view.locator(".ub-figma-caption strong")).toHaveText("marked");
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await expect(page.locator(".ub-foreign")).toHaveCount(0);
    await proveMcpArrival(page, writer, created.uuid, { path: "upstream" });
    await expectMcp(async () => {
      const stored = await writer.call<StoredDoc>("get_doc", { uuid: created.uuid });
      expect(stored.blocks).toEqual(before.blocks);
      expect(stored.blocks[1]?.text).toContain("A **marked** design reference.");
      expect(stored.blocks[1]?.text).not.toContain("Tracking");
    });

    await page.reload();
    await expect(view).toBeVisible();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await proveMcpArrival(page, writer, created.uuid, { path: "upstream" });
    await expectMcp(async () => {
      expect((await writer.call<StoredDoc>("get_doc", { uuid: created.uuid })).blocks).toEqual(before.blocks);
    });
    await expect.poll(() => figmaRequests.length).toBe(2);
  });
}

test("an unsupported Figma shape stays opaque beside editable prose", async ({ browser }) => {
  if (agent === null) throw new Error("e2e: the MCP agent is not configured");
  const writer = agent.open({ name: "figma-foreign-shape-e2e" });
  const created = await writer.call<StoredDoc>("create_doc", {
    title: docTitle("Future design"), description: "Unsupported Figma grammar must remain untouched.",
    blocks: [{ type: "paragraph", text: "Before the reference." }, reference, { type: "paragraph", text: "After the reference." }],
  });
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
    const blockId = created.blocks[1]?.id ?? "";
    await expect.poll(() => findBlockElement(doc, blockId), {
      message: `e2e: unsupported Figma fixture block ${blockId} is missing`,
      timeout: 20_000,
    }).not.toBeNull();
    const block = findBlockElement(doc, blockId);
    if (block === null) throw new Error("e2e: unsupported Figma fixture is missing");
    block.setAttribute("future", "unrecognized");
    const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, { upstream: true });
    const placeholder = editor(page).locator(".ub-unsupported-block");
    await expect(placeholder).toHaveText("This block needs a newer version.");
    await expect(placeholder).toHaveAttribute("contenteditable", "false");
    await expect(page.locator(".ub-foreign")).toHaveCount(0);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await editor(page).locator(".ub-paragraph").last().click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" Edited.");
    await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: created.uuid }), stored => {
      expect(stored.blocks[2]?.text).toBe("After the reference. Edited.");
    });
    await proveBrowserArrival(page, { path: "upstream", readTags: () => getMeta(doc).tags });
    expect(block.getAttribute("future")).toBe("unrecognized");
    expect(findBlockElement(doc, blockId)).toBe(block);
    await expect(page.locator("iframe")).toHaveCount(0);
  } finally { provider.destroy(); doc.destroy(); }
});

for (const arrivesWhileBound of [false, true]) {
  test(`callouts ${arrivesWhileBound ? "arriving during editing" : "already stored"} stay editable and preserve stored attributes, prose and comments`, async ({ browser }) => {
    if (agent === null) throw new Error("e2e: the MCP agent is not configured");
    const writer = agent.open({ name: "callout-compatibility-e2e" });
    const created = await writer.call<StoredDoc>("create_doc", {
      title: docTitle("Callout safety"), description: "Body edits retain known, unknown and absent callout attributes.",
      blocks: [{ type: "paragraph", text: "Context stays intact." }],
    });
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
      await expect.poll(() => findBlockElement(doc, created.blocks[0]?.id ?? "")).not.toBeNull();
      const page = arrivesWhileBound
        ? await openApp(browser, `/${harness().workspace}/${created.uuid}`, { upstream: true }) : null;
      if (page !== null) await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      const fixtures = [
        { attrs: { variant: "warning", icon: "🚀" }, label: "Warning" },
        { attrs: { variant: "future-variant", icon: ":future:" }, label: "Note" },
        { attrs: {}, label: "Note" },
      ].map(({ attrs, label }) => {
        const id = appendBlock(doc, { type: "callout", variant: "warning", icon: "🚀", inline: [
          { text: "Keep this ", marks: {} }, { text: "warning", marks: { bold: true } }, { text: ".", marks: {} },
        ] });
        const block = findBlockElement(doc, id);
        if (block === null) throw new Error("e2e: the callout fixture is missing");
        block.removeAttribute("variant");
        block.removeAttribute("icon");
        for (const [name, value] of Object.entries(attrs)) block.setAttribute(name, value);
        const thread = createAnnotation(doc, id, 10, 17, "Reader", "Keep this warning");
        return { id, block, label, attrs: block.getAttributes(), thread,
          inline: getBlockInline(doc, id), anchors: listAnnotationRanges(doc, id) };
      });
      const browserPage = page ?? await openApp(browser, `/${harness().workspace}/${created.uuid}`, { upstream: true });
      await expect(editor(browserPage)).toHaveAttribute("contenteditable", "true");
      await expect(browserPage.locator(".ub-foreign")).toHaveCount(0);
      await proveBrowserArrival(browserPage, { path: "upstream", readTags: () => getMeta(doc).tags });
      for (const fixture of fixtures) {
        const callout = browserPage.locator(`.ub-callout[id="${fixture.id}"]`);
        await expect(callout).toHaveAttribute("role", "note");
        await expect(callout).toHaveAccessibleName(fixture.label);
        const body = callout.locator(".ub-callout-body");
        await expect(body.locator("strong")).toHaveText("warning");
        await expect(body.locator(`[data-comment-thread="${fixture.thread.id}"]`)).toHaveText("warning");
        expect(findBlockElement(doc, fixture.id)).toBe(fixture.block);
        expect(fixture.block.getAttributes()).toEqual(fixture.attrs);
        expect(getBlockInline(doc, fixture.id)).toEqual(fixture.inline);
        expect(listAnnotationRanges(doc, fixture.id)).toEqual(fixture.anchors);

        await body.click();
        await browserPage.keyboard.press("End");
        await browserPage.keyboard.insertText(" edited");
        await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: created.uuid }), read => {
          expect(read.blocks.find(block => block.id === fixture.id)?.text).toBe("Keep this warning. edited");
        });
        await expect.poll(() => getBlockInline(doc, fixture.id)).toEqual([
          ...fixture.inline.slice(0, -1), { text: ". edited", marks: {} },
        ]);
        expect(findBlockElement(doc, fixture.id)).toBe(fixture.block);
        expect(fixture.block.nodeName).toBe("callout");
        expect(fixture.block.getAttributes()).toEqual(fixture.attrs);
        expect(listAnnotationRanges(doc, fixture.id)).toEqual(fixture.anchors);
      }
      await browserPage.reload();
      await expect(editor(browserPage)).toHaveAttribute("contenteditable", "true");
      await proveMcpArrival(browserPage, writer, created.uuid, { path: "upstream" });
      for (const fixture of fixtures) {
        await expect(browserPage.locator(`.ub-callout[id="${fixture.id}"] .ub-callout-body`)).toHaveText("Keep this warning. edited");
        expect(findBlockElement(doc, fixture.id)).toBe(fixture.block);
        expect(fixture.block.getAttributes()).toEqual(fixture.attrs);
        expect(listAnnotationRanges(doc, fixture.id)).toEqual(fixture.anchors);
      }
    } finally { provider.destroy(); doc.destroy(); }
  });
}
