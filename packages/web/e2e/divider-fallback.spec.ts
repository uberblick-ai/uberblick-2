import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { devices, expect, test } from "@playwright/test";
import { findBlockElement, getMeta, roomForDoc } from "@uberblick/schema";
import { wrapToken } from "@uberblick/schema/protocol";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import * as Y from "yjs";
import { docTitle, editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import { expectMcp, proveBrowserArrival, proveMcpArrival } from "./settle.js";

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
  test(`a divider ${arrivesWhileBound ? "arriving during editing" : "already stored"} stays editable and intact`, { tag: "@webkit" }, async ({ browser }, info) => {
    if (agent === null) throw new Error("e2e: the MCP agent is not configured");
    const writer = agent.open({ name: "divider-fallback-e2e" });
    const created = await writer.call<WrittenDoc>("create_doc", {
      title: docTitle("Divider compatibility"), description: "Dividers stay editable through collaboration.",
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
    await expect(editor(page).getByRole("separator")).toHaveCount(1);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");

    await proveMcpArrival(page, writer, created.uuid, { path: "upstream" });
    await expect(page.locator(".ub-foreign")).toHaveCount(0);
    await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: created.uuid }), stored => {
      expect(stored.blocks).toEqual(expected);
    });
    await editor(page).locator(".ub-paragraph").first().click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" Edited beside a divider.");
    await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: created.uuid }), stored => {
      expect(stored.blocks[0]?.text).toBe("Context stays intact. Edited beside a divider.");
      expect(stored.blocks[1]).toEqual(expected[1]);
    });
  });
}

for (const arrivesWhileBound of [false, true]) {
  test(`a divider child ${arrivesWhileBound ? "arriving during editing" : "already stored"} stays intact behind the unsupported-content fallback`, { tag: "@webkit" }, async ({ browser }, info) => {
    if (agent === null) throw new Error("e2e: the MCP agent is not configured");
    const writer = agent.open({ name: "divider-child-e2e" });
    const created = await writer.call<WrittenDoc>("create_doc", {
      title: docTitle("Older client divider"), description: "An older client's text child must remain untouched.",
      blocks: [{ type: "paragraph", text: "Context stays intact." }, { type: "divider" }],
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
      const id = created.blocks[1]?.id ?? "";
      await expect.poll(() => findBlockElement(doc, id)).not.toBeNull();
      const divider = findBlockElement(doc, id);
      if (divider === null) throw new Error("e2e: the divider fixture is missing");
      const options = { upstream: true, contextOptions: info.project.use.hasTouch === true ? devices["iPad (gen 7)"] : {} };
      const page = arrivesWhileBound ? await openApp(browser, `/${harness().workspace}/${created.uuid}`, options) : null;
      if (page !== null) await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      divider.insert(0, [new Y.XmlText("Written by an older client")]);
      const browserPage = page ?? await openApp(browser, `/${harness().workspace}/${created.uuid}`, options);
      const fallback = browserPage.locator(".ub-foreign");
      await expect(fallback).toBeVisible();
      await expect(fallback.locator(".ub-foreign-banner")).toContainText("unsupported type (#divider-shape)");
      await expect(fallback.locator(".ub-foreign-list")).toContainText("Context stays intact.");
      await expect(fallback.locator(".ub-foreign-list")).toContainText(id);
      await proveBrowserArrival(browserPage, { path: "upstream", readTags: () => getMeta(doc).tags });
      await expect(editor(browserPage)).toHaveCount(0);
      await expect(browserPage.locator('[contenteditable="true"]')).toHaveCount(0);
      expect(findBlockElement(doc, id)).toBe(divider);
      expect(divider.length).toBe(1);
      expect(divider.firstChild?.toString()).toBe("Written by an older client");
      expect(divider.getAttributes()).toEqual({ id });
    } finally { provider.destroy(); doc.destroy(); }
  });
}
