import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { expect, test } from "@playwright/test";
import { findBlockElement, roomForDoc } from "@uberblick/schema";
import { wrapToken } from "@uberblick/schema/protocol";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import * as Y from "yjs";
import { docTitle, editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";

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
        await target.route("https://embed.figma.com/**", async (route) => {
          figmaRequests.push(route.request().url());
          await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Figma fixture</title>" });
        });
      },
    });
    if (arrivesWhileBound) {
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      await writer.call("insert_block", {
        uuid: created.uuid, after_block_id: created.blocks[0]?.id, ...reference,
      });
    }
    const before = await writer.call<StoredDoc>("get_doc", { uuid: created.uuid });
    const view = page.locator(".ub-figma");
    await expect(view).toBeVisible();
    await expect(view.locator("iframe")).toHaveAttribute("title", "Payment, mobile");
    await expect(view.locator(".ub-figma-caption strong")).toHaveText("marked");
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await expect(page.locator(".ub-foreign")).toHaveCount(0);
    expect((await writer.call<StoredDoc>("get_doc", { uuid: created.uuid })).blocks).toEqual(before.blocks);
    expect(before.blocks[1]?.text).not.toContain("Tracking");

    await page.reload();
    await expect(view).toBeVisible();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    expect((await writer.call<StoredDoc>("get_doc", { uuid: created.uuid })).blocks).toEqual(before.blocks);
    await expect.poll(() => figmaRequests.length).toBe(2);
  });
}

test("an unsupported Figma shape still names the block and makes the document read-only", async ({ browser }) => {
  if (agent === null) throw new Error("e2e: the MCP agent is not configured");
  const writer = agent.open({ name: "figma-foreign-shape-e2e" });
  const created = await writer.call<StoredDoc>("create_doc", {
    title: docTitle("Future design"), description: "Unsupported Figma grammar must remain untouched.", blocks: [reference],
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
    await new Promise<void>((resolve) => provider.on("synced", resolve));
    const block = findBlockElement(doc, created.blocks[0]?.id ?? "");
    if (block === null) throw new Error("e2e: unsupported Figma fixture is missing");
    block.setAttribute("future", "unrecognized");
    const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, { upstream: true });
    const fallback = page.locator(".ub-foreign");
    await expect(fallback).toBeVisible();
    await expect(fallback.locator(".ub-foreign-banner")).toContainText("unsupported type (#figma-shape)");
    await expect(editor(page)).toHaveCount(0);
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
    expect(block.getAttribute("future")).toBe("unrecognized");
    await expect(page.locator("iframe")).toHaveCount(0);
  } finally { provider.destroy(); doc.destroy(); }
});
