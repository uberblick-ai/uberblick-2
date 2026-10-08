/** A row menu names its shared row while real collaborator changes arrive. */
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/hub";
import { wrapToken } from "@uberblick/hub/protocol";
import {
  appendBlock, decisionDirectoryFields, deleteBlock, directoryRoom, editBlock,
  getBlocks, getBlocksFragment, initDoc, roomForDoc, setKind, setStatus,
  tableCellText, tableRows, upsertDirectoryEntry,
} from "@uberblick/schema";
import * as Y from "yjs";
import { setupHarness } from "./app-helpers.js";

const { harness, ws } = setupHarness();
const SOURCE = "| A | B |\n| --- | --- |\n| alpha | one |\n| beta | two |";

async function publishTable(options: { source?: string; ragged?: boolean; decision?: boolean } = {}): Promise<{
  uuid: string;
  id: string;
  doc: Y.Doc;
  directory: Y.Doc;
  close: () => void;
}> {
  const uuid = randomUUID();
  const doc = new Y.Doc();
  const title = "Shared table controls";
  initDoc(doc, { uuid, title });
  const source = options.source ?? SOURCE;
  const id = appendBlock(doc, { type: "table", text: source });
  if (options.decision) {
    setKind(doc, "decision");
    setStatus(doc, "open");
  }
  if (options.ragged) {
    const other = new Y.Doc();
    try {
      Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
      editBlock(doc, id, source, `${source}\n|  |  |`, {
        tableMapping: { rows: [0, 1, null], columns: [0, 1] },
      });
      editBlock(other, id, source, "| A | B | extra |\n| --- | --- | --- |\n| alpha | one | new |", {
        tableMapping: { rows: [0, 1], columns: [0, 1, null] },
      });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    } finally { other.destroy(); }
  }
  const peers: Array<{ provider: HocuspocusProvider; ydoc: Y.Doc }> = [];
  const close = (): void => {
    for (const { provider, ydoc } of peers) { provider.destroy(); ydoc.destroy(); }
    if (!peers.some((peer) => peer.ydoc === doc)) doc.destroy();
  };
  try {
    const secret = await importRootSecret(harness().authSecret);
    const connect = async (room: string, ydoc = new Y.Doc()): Promise<Y.Doc> => {
      const provider = new HocuspocusProvider({
        url: harness().hubUrl, name: room, document: ydoc,
        token: async () => wrapToken(await mintToken(secret, {
          typ: "room", sub: randomUUID(), workspace: harness().workspaceUuid,
          scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
        })),
      });
      peers.push({ provider, ydoc });
      await new Promise<void>((resolve) => provider.on("synced", resolve));
      return ydoc;
    };
    const directory = await connect(directoryRoom(harness().workspaceUuid));
    upsertDirectoryEntry(directory, {
      uuid, title,
      ...(options.decision ? { kind: "decision", status: "open", ...decisionDirectoryFields(doc) } : {}),
    });
    await connect(roomForDoc(harness().workspaceUuid, uuid), doc);
    return { uuid, id, doc, directory, close };
  } catch (error) {
    close();
    throw error;
  }
}

for (const deleted of ["row", "table"] as const) {
  test(`an open row menu closes when a collaborator deletes its ${deleted}`, async ({ page }) => {
    const fixture = await publishTable();
    try {
      await page.goto(new URL(`/${ws()}/${fixture.uuid}`, harness().appUrl).href);
      const table = page.locator(".ub-table");
      await expect(table.locator("tr")).toHaveCount(3);
      await table.locator("td").first().click({ button: "right" });
      await expect(page.getByRole("menuitem", { name: "Delete row", exact: true })).toBeVisible();
      if (deleted === "row") {
        editBlock(fixture.doc, fixture.id, SOURCE, "| A | B |\n| --- | --- |\n| beta | two |", {
          tableMapping: { rows: [0, 2], columns: [0, 1] },
        });
        await expect(table.locator("tr")).toHaveCount(2);
        await expect(table.locator("td")).toHaveText(["beta", "two"]);
      } else {
        deleteBlock(fixture.doc, fixture.id);
        await expect(table).toHaveCount(0);
      }
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(page.getByRole("menuitem", { name: "Delete row", exact: true })).toHaveCount(0);
      if (deleted === "row") {
        await expect.poll(() => getBlocks(fixture.doc).find((block) => block.id === fixture.id)?.text)
          .toBe("| A | B |\n| --- | --- |\n| beta | two |");
      } else {
        await expect.poll(() => getBlocks(fixture.doc).some((block) => block.id === fixture.id)).toBe(false);
      }
    } finally { fixture.close(); }
  });
}

test("a row menu keeps its original row through a collaborator edit and insertion above it", async ({ page }) => {
  const fixture = await publishTable();
  try {
    await page.goto(new URL(`/${ws()}/${fixture.uuid}`, harness().appUrl).href);
    const table = page.locator(".ub-table");
    await expect(table.locator("tr")).toHaveCount(3);
    await table.hover();
    await page.getByRole("button", { name: "Row 3 actions", exact: true }).click();
    const remove = page.getByRole("menuitem", { name: "Delete row", exact: true });
    await expect(remove).toBeVisible();
    const edited = SOURCE.replace("beta", "edited beta");
    editBlock(fixture.doc, fixture.id, SOURCE, edited);
    await expect(table.locator("tr").last().locator("td").first()).toHaveText("edited beta");
    await expect(remove).toBeVisible();
    const expanded = edited.replace("| alpha | one |", "| new | row |\n| alpha | one |");
    editBlock(fixture.doc, fixture.id, edited, expanded, {
      tableMapping: { rows: [0, null, 1, 2], columns: [0, 1] },
    });
    await expect(table.locator("tr")).toHaveCount(4);
    await expect(remove).toBeVisible();
    await remove.click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(table.locator("tr")).toHaveCount(3);
    await expect(table.locator("td")).toHaveText(["new", "row", "alpha", "one"]);
    await expect.poll(() => getBlocks(fixture.doc).find((block) => block.id === fixture.id)?.text)
      .toBe("| A | B |\n| --- | --- |\n| new | row |\n| alpha | one |");
  } finally { fixture.close(); }
});

test("a ragged shared table offers no structural controls and retains editable cells", async ({ page }) => {
  const fixture = await publishTable({ source: "| A | B |\n| --- | --- |\n| alpha | one |", ragged: true });
  try {
    await page.goto(new URL(`/${ws()}/${fixture.uuid}`, harness().appUrl).href);
    const table = page.locator(".ub-table");
    await expect(table.locator("tr")).toHaveCount(3);
    expect(await table.locator("tr").evaluateAll((rows) => rows.map((row) => row.querySelectorAll("th, td").length)))
      .toEqual([3, 3, 2]);
    const cell = table.locator("tr").last().locator("td").last();
    await cell.click();
    await expect(page.locator(".ub-table-controls")).toHaveCount(0);
    await page.keyboard.press("Control+Alt+r");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await cell.click({ button: "right" });
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await cell.click();
    await page.keyboard.type("still editable");
    await expect(cell).toHaveText("still editable");
    await expect(page.locator(".ub-table-controls")).toHaveCount(0);
    await expect.poll(() => {
      const shared = getBlocksFragment(fixture.doc).get(0);
      const cell = shared instanceof Y.XmlElement ? tableRows(shared)[2]?.[1] : undefined;
      return cell === undefined ? null : tableCellText(cell)?.toString();
    }).toBe("still editable");
    expect(await table.locator("tr").evaluateAll((rows) => rows.map((row) => row.querySelectorAll("th, td").length)))
      .toEqual([3, 3, 2]);
  } finally { fixture.close(); }
});

test("deciding a record closes its table menu and removes structural controls", async ({ page }) => {
  const fixture = await publishTable({ decision: true });
  try {
    await page.goto(new URL(`/${ws()}/${fixture.uuid}`, harness().appUrl).href);
    const table = page.locator(".ub-table");
    await expect(table.locator("tr")).toHaveCount(3);
    await expect(page.locator(".ub-editor .ProseMirror")).toHaveAttribute("contenteditable", "true");
    await table.hover();
    await page.getByRole("button", { name: "Row 2 actions", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Delete row", exact: true })).toBeVisible();
    setStatus(fixture.doc, "decided");
    upsertDirectoryEntry(fixture.directory, {
      uuid: fixture.uuid, title: "Shared table controls", kind: "decision", status: "decided",
      ...decisionDirectoryFields(fixture.doc),
    });
    await expect(page.locator(".ub-editor .ProseMirror")).toHaveAttribute("contenteditable", "false");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.locator(".ub-table-controls")).toHaveCount(0);
    await table.locator("td").first().click({ button: "right" });
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(table.locator("td")).toHaveText(["alpha", "one", "beta", "two"]);
    expect(getBlocks(fixture.doc).find((block) => block.id === fixture.id)?.text).toBe(SOURCE);
  } finally { fixture.close(); }
});
