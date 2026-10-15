import { expect, test } from "@playwright/test";
import { docTitle, editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import { expectMcp, proveMcpArrival } from "./settle.js";

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
  test(`Figma ${arrivesWhileBound ? "arriving during editing" : "already stored"} keeps the document read-only and intact`, async ({ browser }) => {
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
        await target.route(/^https?:\/\/(?:[^/]+\.)?figma\.com(?:\/|$)/, async (route) => {
          figmaRequests.push(route.request().url());
          await route.abort();
        });
      },
    });
    if (arrivesWhileBound) {
      await expect(editor(page)).toBeVisible();
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      await writer.call("insert_block", {
        uuid: created.uuid, after_block_id: created.blocks[0]?.id, ...reference,
      });
    }
    const before = await writer.call<StoredDoc>("get_doc", { uuid: created.uuid });
    const fallback = page.locator(".ub-foreign");
    await expect(fallback).toBeVisible();
    await expect(fallback.locator(".ub-foreign-banner")).toContainText("unsupported type (figma)");
    await expect(fallback.locator(".ub-foreign-list > li > code")).toHaveText(["paragraph", "figma"]);
    await expect(editor(page)).toHaveCount(0);
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
    await proveMcpArrival(page, writer, created.uuid, { path: "upstream" });
    await expectMcp(async () => {
      const stored = await writer.call<StoredDoc>("get_doc", { uuid: created.uuid });
      expect(stored.blocks).toEqual(before.blocks);
      expect(stored.blocks[1]?.text).toContain("A **marked** design reference.");
      expect(stored.blocks[1]?.text).not.toContain("Tracking");
    });

    await page.reload();
    await expect(fallback).toBeVisible();
    await expect(editor(page)).toHaveCount(0);
    await proveMcpArrival(page, writer, created.uuid, { path: "upstream" });
    await expectMcp(async () => {
      expect((await writer.call<StoredDoc>("get_doc", { uuid: created.uuid })).blocks).toEqual(before.blocks);
    });
    expect(figmaRequests).toEqual([]);
  });
}
