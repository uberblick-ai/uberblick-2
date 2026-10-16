import { randomUUID } from "node:crypto";
import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import { expect, test } from "@playwright/test";
import {
  appendBlock, directoryRoom, restoreDirectoryEntry, roomForDoc, setTitle,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import { DOC_DELETED_REASON, wrapToken } from "@uberblick/schema/protocol";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import * as Y from "yjs";
import { editor, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";
import { expectMcp, waitForAcknowledged } from "./settle.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-deletion-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

/** Hold an ordinary protocol-compatible room offline across another client's delete. */
async function offlinePeer(room: string): Promise<{ doc: Y.Doc; provider: HocuspocusProvider; close(): void }> {
  const doc = new Y.Doc();
  const key = await importRootSecret(harness().authSecret);
  const provider = new HocuspocusProvider({
    url: harness().hubUrl, name: room, document: doc,
    token: async () => wrapToken(await mintToken(key, {
      typ: "room", sub: randomUUID(), workspace: harness().workspaceUuid,
      scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    })),
  });
  const close = (): void => { provider.destroy(); doc.destroy(); };
  try {
    await expect.poll(() => provider.isSynced).toBe(true);
    provider.disconnect();
    await expect.poll(() => provider.configuration.websocketProvider.status).toBe(WebSocketStatus.Disconnected);
    return { doc, provider, close };
  } catch (error) { close(); throw error; }
}

test("MCP deletion retires an open browser document and rejects an offline writer without affecting another document", async ({ browser }) => {
  if (agent === null) throw new Error("e2e: the deletion MCP agent is not configured");
  const writer = agent.open({ name: "deletion-e2e" });
  const retired = await writer.call<{ uuid: string }>("create_doc", {
    title: "Private retired draft", description: "A browser deletion fixture with private content.",
    blocks: [{ type: "paragraph", text: "Private retired content" }],
  });
  const healthy = await writer.call<{ uuid: string }>("create_doc", {
    title: "Healthy working document", description: "A browser fixture that must remain writable.",
    blocks: [{ type: "paragraph", text: "Healthy content" }],
  });
  await writer.call("archive_doc", { uuid: retired.uuid });
  const room = roomForDoc(harness().workspaceUuid, retired.uuid);
  const staleDocument = await offlinePeer(room);
  const staleDirectory = await offlinePeer(directoryRoom(harness().workspaceUuid)).catch((error) => {
    staleDocument.close();
    throw error;
  });
  try {
    restoreDirectoryEntry(staleDirectory.doc, retired.uuid);
    upsertDirectoryEntry(staleDirectory.doc, {
      uuid: retired.uuid, title: "Offline restored title", tags: [], description: "Offline restored description",
    });
    setTitle(staleDocument.doc, "Offline restored title");
    appendBlock(staleDocument.doc, { type: "paragraph", text: "Offline private edit" });

    const retiredPage = await openApp(browser, `/${harness().workspace}/${retired.uuid}`);
    const healthyPage = await openApp(browser, `/${harness().workspace}/${healthy.uuid}`);
    await expect(editor(retiredPage)).toHaveText("Private retired content");
    await expect(retiredPage.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
    await expect(editor(healthyPage)).toHaveAttribute("contenteditable", "true");

    await writer.call("delete_doc", { uuid: retired.uuid });
    await expect(editor(retiredPage)).toHaveCount(0);
    await expect(retiredPage.getByRole("button", { name: "Restore", exact: true })).toHaveCount(0);
    await expect(retiredPage.locator("body")).not.toContainText("Private retired content");
    await expect(retiredPage.locator("body")).not.toContainText(/not authorized|sign.in required|edit refused/i);

    // Reconnecting the stale directory delivers a real unseen restore and stub
    // rewrite. The document room must still refuse its queued content update.
    await staleDirectory.provider.connect();
    await expect.poll(() => staleDirectory.provider.isSynced).toBe(true);
    const refused = new Promise<string>((resolve) => staleDocument.provider.on("authenticationFailed", ({ reason }: { reason: string }) => resolve(reason)));
    await staleDocument.provider.connect();
    expect(await refused).toBe(DOC_DELETED_REASON);
    staleDocument.provider.disconnect();

    await placeCaret(healthyPage);
    await healthyPage.keyboard.type(" remains writable");
    await expectMcp(
      () => writer.call<{ blocks: Array<{ text: string }> }>("get_doc", { uuid: healthy.uuid }),
      doc => { expect(doc.blocks.map((block) => block.text).join("\n")).toBe("Healthy content remains writable"); },
    );
    const listed = await writer.call<{ docs: Array<{ uuid: string }> }>("list_docs", { include_deleted: true });
    expect(listed.docs.map((doc) => doc.uuid)).not.toContain(retired.uuid);
    await expectMcp(async () => {
      await expect(writer.call("get_doc", { uuid: retired.uuid })).rejects.toThrow(/doc_deleted/);
    });

    await retiredPage.reload();
    await waitForAcknowledged(retiredPage, { path: "upstream" });
    await expect(editor(retiredPage)).toHaveCount(0);
    await retiredPage.goto(new URL(`/${harness().workspace}`, harness().appUrl).href);
    await expect(retiredPage.locator(".ub-docs-row", { hasText: "Healthy working document" })).toBeVisible();
    await expect(retiredPage.locator(".ub-docs-row", { hasText: /Private retired draft|Offline restored title/ })).toHaveCount(0);
    await expect(retiredPage.locator("body")).not.toContainText(/not authorized|sign.in required|edit refused/i);
  } finally {
    staleDocument.close();
    staleDirectory.close();
  }
});
