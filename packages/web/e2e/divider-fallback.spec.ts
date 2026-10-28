import { devices, expect, test } from "@playwright/test";
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
    statePrefix: "uberblick-e2e-divider-fallback-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

interface WrittenDoc {
  uuid: string;
  blocks: Array<{ id: string; rev: string }>;
}
interface StoredDoc extends WrittenDoc {
  blocks: Array<{ id: string; rev: string; type: string; text: string }>;
}

for (const arrivesWhileBound of [false, true]) {
  test(`a divider ${arrivesWhileBound ? "arriving during editing" : "already stored"} disables the editor and remains intact`, { tag: "@webkit" }, async ({ browser }, info) => {
    if (agent === null) throw new Error("e2e: the MCP agent is not configured");
    const writer = agent.open({ name: "divider-fallback-e2e" });
    const created = await writer.call<WrittenDoc>("create_doc", {
      title: docTitle("Divider safety"), description: "Unsupported dividers must remain untouched.",
      blocks: [{ type: "paragraph", text: "Context stays intact." }, ...(arrivesWhileBound ? [] : [{ type: "divider" }])],
    });
    const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, {
      upstream: true,
      contextOptions: {
        ...(info.project.use.hasTouch === true ? devices["iPad (gen 7)"] : {}),
        colorScheme: arrivesWhileBound ? "dark" : "light",
      },
    });
    let divider = created.blocks[1];
    if (arrivesWhileBound) {
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      const inserted = await writer.call<WrittenDoc>("insert_block", {
        uuid: created.uuid, after_block_id: created.blocks[0]?.id, blocks: [{ type: "divider" }],
      });
      divider = inserted.blocks[0];
    }
    if (divider === undefined) throw new Error("e2e: the divider write returned no block");
    const expected = [
      { ...created.blocks[0], type: "paragraph", text: "Context stays intact." },
      { ...divider, type: "divider", text: "" },
    ];
    const fallback = page.locator(".ub-foreign");
    await expect(fallback).toBeVisible();
    await expect(fallback.locator(".ub-foreign-banner")).toContainText("unsupported type (divider)");
    await expect(fallback.locator(".ub-foreign-list")).toContainText("Context stays intact.");
    await expect(fallback.locator(".ub-foreign-list")).toContainText(divider.id);
    await expect(editor(page)).toHaveCount(0);
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);

    // The later metadata write proves the browser's preceding room updates reached this reader.
    await proveMcpArrival(page, writer, created.uuid, { path: "upstream" });
    await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: created.uuid }), stored => {
      expect(stored.blocks).toEqual(expected);
    });
  });
}
