import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { expect, test } from "@playwright/test";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/hub";
import { wrapToken } from "@uberblick/hub/protocol";
import {
  appendBlock,
  createGroup,
  decisionDirectoryFields,
  directoryRoom,
  getDirectoryEntry,
  getDirectoryMap,
  initDoc,
  pinDoc,
  readSidebar,
  roomForDoc,
  setKind,
  sidebarRoom,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import * as Y from "yjs";
import { editor, setupHarness } from "./app-helpers.js";

const { harness, openApp } = setupHarness({
  app: { readySelector: ".ub-editor .ProseMirror" },
});

test("decision archive and restore follow the whole topic and its first record", async ({ browser }) => {
  const first = randomUUID();
  const successor = randomUUID();
  const running = harness();
  const secret = await importRootSecret(running.authSecret);
  const peers: Array<{ doc: Y.Doc; provider: HocuspocusProvider }> = [];
  async function peer(room: string): Promise<Y.Doc> {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: running.hubUrl,
      name: room,
      document: doc,
      token: async () => wrapToken(await mintToken(secret, {
        typ: "room", sub: randomUUID(), workspace: running.workspaceUuid,
        scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      })),
    });
    peers.push({ doc, provider });
    await new Promise<void>((resolve) => provider.on("synced", resolve));
    return doc;
  }
  try {
    const directory = await peer(directoryRoom(running.workspaceUuid));
    const sidebar = await peer(sidebarRoom(running.workspaceUuid));
    for (const uuid of [first, successor]) {
      const doc = await peer(roomForDoc(running.workspaceUuid, uuid));
      initDoc(doc, {
        uuid, title: uuid === first ? "Original lease" : "Proposed lease",
        topic: first,
        ...(uuid === successor ? { supersedes: first } : {}),
      });
      setKind(doc, "decision");
      appendBlock(doc, { type: "paragraph", text: "Lease reasoning stays readable." });
      upsertDirectoryEntry(directory, {
        uuid, title: uuid === first ? "Original lease" : "Proposed lease",
        kind: "decision", status: "open", ...decisionDirectoryFields(doc),
      });
    }
    const group = createGroup(sidebar, "Reading");
    pinDoc(sidebar, group, first);
    pinDoc(sidebar, group, successor);
    const page = await openApp(browser, `/${running.workspace}/${successor}`);
    const earlier = await openApp(browser, `/${running.workspace}/${first}`);
    const map = getDirectoryMap(directory);

    // A mirror-only tombstone leaves a successor writable and archivable.
    map.set(successor, { ...(map.get(successor) as object), deleted: true });
    await expect(page.getByRole("button", { name: "Document actions" })).toBeVisible();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await page.getByRole("button", { name: "Document actions" }).click();
    await page.getByRole("menuitem", { name: "Archive document" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Archive document" }).click();
    await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
    await expect(earlier.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
    await expect.poll(() => readSidebar(sidebar)[0]?.docs).toEqual([]);
    await expect.poll(() => getDirectoryEntry(directory, first)?.deleted).toBe(true);
    await expect.poll(() => getDirectoryEntry(directory, successor)?.deleted).toBe(true);
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");

    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await expect(editor(earlier)).toHaveAttribute("contenteditable", "true");
    await expect.poll(() => getDirectoryEntry(directory, first)?.deleted).toBeUndefined();
    await expect.poll(() => getDirectoryEntry(directory, successor)?.deleted).toBeUndefined();

    // A partial archive's first tombstone alone gates every record's writes.
    map.set(first, { ...(map.get(first) as object), deleted: true });
    await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await expect(page.locator(".ub-title")).toHaveAttribute("readonly", "");
    expect(getDirectoryEntry(directory, successor)?.deleted).toBeUndefined();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await expect(editor(earlier)).toHaveAttribute("contenteditable", "true");
  } finally {
    for (const { provider, doc } of peers.reverse()) {
      provider.destroy();
      doc.destroy();
    }
  }
});
