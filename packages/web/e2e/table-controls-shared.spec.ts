/** Table menus keep their shared targets while real collaborator changes arrive. */
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import { wrapToken } from "@uberblick/schema/protocol";
import {
  appendBlock, deleteBlock, directoryRoom, editBlock,
  getBlocks, getBlocksFragment, initDoc, roomForDoc,
  tableCellText, tableRows, tombstoneDirectoryEntry, upsertDirectoryEntry,
} from "@uberblick/schema";
import * as Y from "yjs";
import { setupHarness } from "./app-helpers.js";

const { harness, ws } = setupHarness();
const SOURCE = "| A | B |\n| --- | --- |\n| alpha | one |\n| beta | two |";

function makeRagged(doc: Y.Doc, id: string, source: string): void {
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

async function publishTable(options: { source?: string; ragged?: boolean } = {}): Promise<{
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
  if (options.ragged) makeRagged(doc, id, source);
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
    upsertDirectoryEntry(directory, { uuid, title });
    await connect(roomForDoc(harness().workspaceUuid, uuid), doc);
    return { uuid, id, doc, directory, close };
  } catch (error) {
    close();
    throw error;
  }
}

for (const deleted of ["column", "table"] as const) {
  test(`an open column menu closes when a collaborator deletes its ${deleted}`, async ({ page }) => {
    const fixture = await publishTable();
    try {
      await page.goto(new URL(`/${ws()}/${fixture.uuid}`, harness().appUrl).href);
      const table = page.locator(".ub-table");
      await expect(table.locator("tr")).toHaveCount(3);
      await table.locator("td").first().click();
      await page.getByRole("button", { name: "Column 1 actions", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "Delete column", exact: true })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Move column right", exact: true })).toBeEnabled();
      const remaining = "| B |\n| --- |\n| one |\n| two |";
      if (deleted === "column") {
        editBlock(fixture.doc, fixture.id, SOURCE, remaining, {
          tableMapping: { rows: [0, 1, 2], columns: [1] },
        });
        await expect(table.locator("th")).toHaveText(["B"]);
        await expect(table.locator("td")).toHaveText(["one", "two"]);
      } else {
        deleteBlock(fixture.doc, fixture.id);
        await expect(table).toHaveCount(0);
      }
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(page.getByRole("menuitem", { name: "Delete column", exact: true })).toHaveCount(0);
      await expect(page.getByRole("menuitem", { name: /^Move column / })).toHaveCount(0);
      if (deleted === "column") {
        await expect.poll(() => getBlocks(fixture.doc).find((block) => block.id === fixture.id)?.text).toBe(remaining);
      } else {
        await expect.poll(() => getBlocks(fixture.doc).some((block) => block.id === fixture.id)).toBe(false);
      }
    } finally { fixture.close(); }
  });
}

test("an open column menu keeps its target through collaborator edits, insertion and deletion to its left", async ({ page }) => {
  const source = "| A | B | C |\n| --- | --- | --- |\n| alpha | one | last |\n| beta | two | tail |";
  const fixture = await publishTable({ source });
  try {
    await page.goto(new URL(`/${ws()}/${fixture.uuid}`, harness().appUrl).href);
    const table = page.locator(".ub-table");
    await expect(table.locator("th")).toHaveCount(3);
    await table.locator("td").nth(1).click();
    await page.getByRole("button", { name: "Column 2 actions", exact: true }).click();
    const remove = page.getByRole("menuitem", { name: "Delete column", exact: true });
    await expect(remove).toBeVisible();
    const edited = source.replace("one", "edited one").replace("last", "edited last");
    editBlock(fixture.doc, fixture.id, source, edited, {
      tableMapping: { rows: [0, 1, 2], columns: [0, 1, 2] },
    });
    await expect(table.locator("td").nth(1)).toHaveText("edited one");
    const expanded = "| A | New | B | C |\n| --- | --- | --- | --- |\n| alpha | new one | edited one | edited last |\n| beta | new two | two | tail |";
    editBlock(fixture.doc, fixture.id, edited, expanded, {
      tableMapping: { rows: [0, 1, 2], columns: [0, null, 1, 2] },
    });
    await expect(table.locator("th")).toHaveText(["A", "New", "B", "C"]);
    await expect(remove).toBeVisible();
    const reduced = "| New | B | C |\n| --- | --- | --- |\n| new one | edited one | edited last |\n| new two | two | tail |";
    editBlock(fixture.doc, fixture.id, expanded, reduced, {
      tableMapping: { rows: [0, 1, 2], columns: [1, 2, 3] },
    });
    await expect(table.locator("th")).toHaveText(["New", "B", "C"]);
    await expect(remove).toBeVisible();
    await remove.click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(table.locator("th")).toHaveText(["New", "C"]);
    await expect(table.locator("td")).toHaveText(["new one", "edited last", "new two", "tail"]);
    await expect.poll(() => getBlocks(fixture.doc).find((block) => block.id === fixture.id)?.text)
      .toBe("| New | C |\n| --- | --- |\n| new one | edited last |\n| new two | tail |");
  } finally { fixture.close(); }
});

test("a column move resolves its target after collaborator edits and insertion to its left", async ({ page }) => {
  const source = "| A | B | C |\n| --- | --- | --- |\n| alpha | one | last |\n| beta | two | tail |";
  const fixture = await publishTable({ source });
  try {
    await page.goto(new URL(`/${ws()}/${fixture.uuid}`, harness().appUrl).href);
    const table = page.locator(".ub-table");
    await expect(table.locator("th")).toHaveText(["A", "B", "C"]);
    await table.locator("td").nth(1).click();
    await page.getByRole("button", { name: "Column 2 actions", exact: true }).click();
    const move = page.getByRole("menuitem", { name: "Move column left", exact: true });
    await expect(move).toBeEnabled();
    const edited = source.replace("one", "edited one").replace("last", "edited last");
    editBlock(fixture.doc, fixture.id, source, edited, {
      tableMapping: { rows: [0, 1, 2], columns: [0, 1, 2] },
    });
    await expect(table.locator("td").nth(1)).toHaveText("edited one");
    const expanded = "| A | New | B | C |\n| --- | --- | --- | --- |\n| alpha | new one | edited one | edited last |\n| beta | new two | two | tail |";
    editBlock(fixture.doc, fixture.id, edited, expanded, {
      tableMapping: { rows: [0, 1, 2], columns: [0, null, 1, 2] },
    });
    await expect(table.locator("th")).toHaveText(["A", "New", "B", "C"]);
    await expect(move).toBeEnabled();
    await move.click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(table.locator("th")).toHaveText(["A", "B", "New", "C"]);
    await expect(table.locator("td")).toHaveText(["alpha", "edited one", "new one", "edited last", "beta", "two", "new two", "tail"]);
    await expect.poll(() => getBlocks(fixture.doc).find((block) => block.id === fixture.id)?.text)
      .toBe("| A | B | New | C |\n| --- | --- | --- | --- |\n| alpha | edited one | new one | edited last |\n| beta | two | new two | tail |");
  } finally { fixture.close(); }
});

for (const direction of ["left", "right"] as const) {
  test(`an open column menu disables moving ${direction} when its target reaches that edge`, async ({ page }) => {
    const source = "| A | B | C |\n| --- | --- | --- |\n| alpha | one | last |";
    const fixture = await publishTable({ source });
    try {
      await page.goto(new URL(`/${ws()}/${fixture.uuid}`, harness().appUrl).href);
      const table = page.locator(".ub-table");
      await expect(table.locator("th")).toHaveText(["A", "B", "C"]);
      await table.locator("td").nth(1).click();
      await page.getByRole("button", { name: "Column 2 actions", exact: true }).click();
      const move = page.getByRole("menuitem", { name: `Move column ${direction}`, exact: true });
      await expect(move).toBeEnabled();
      const remaining = direction === "left"
        ? "| B | C |\n| --- | --- |\n| one | last |"
        : "| A | B |\n| --- | --- |\n| alpha | one |";
      editBlock(fixture.doc, fixture.id, source, remaining, {
        tableMapping: { rows: [0, 1], columns: direction === "left" ? [1, 2] : [0, 1] },
      });
      await expect(table.locator("th")).toHaveText(direction === "left" ? ["B", "C"] : ["A", "B"]);
      await expect(move).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      expect(getBlocks(fixture.doc).find((block) => block.id === fixture.id)?.text).toBe(remaining);
    } finally { fixture.close(); }
  });
}

test("a single-column menu cannot move or delete its last column", async ({ page }) => {
  const source = "| A |\n| --- |\n| alpha |";
  const fixture = await publishTable({ source });
  try {
    await page.goto(new URL(`/${ws()}/${fixture.uuid}`, harness().appUrl).href);
    const table = page.locator(".ub-table");
    await expect(table.locator("th")).toHaveCount(1);
    await table.locator("td").first().click();
    await page.getByRole("button", { name: "Column 1 actions", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Move column left", exact: true })).toBeDisabled();
    await expect(page.getByRole("menuitem", { name: "Move column right", exact: true })).toBeDisabled();
    await expect(page.getByRole("menuitem", { name: "Delete column", exact: true })).toBeDisabled();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(table.locator("th")).toHaveText(["A"]);
    await expect(table.locator("td")).toHaveText(["alpha"]);
    expect(getBlocks(fixture.doc).find((block) => block.id === fixture.id)?.text).toBe(source);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Column 1 actions", exact: true })).toBeFocused();
  } finally { fixture.close(); }
});

test("a column menu closes when concurrent structural edits make its table ragged", async ({ page }) => {
  const source = "| A | B |\n| --- | --- |\n| alpha | one |";
  const fixture = await publishTable({ source });
  try {
    await page.goto(new URL(`/${ws()}/${fixture.uuid}`, harness().appUrl).href);
    const table = page.locator(".ub-table");
    await expect(table.locator("th")).toHaveCount(2);
    await table.locator("td").first().click();
    await page.getByRole("button", { name: "Column 1 actions", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Delete column", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Move column right", exact: true })).toBeEnabled();
    makeRagged(fixture.doc, fixture.id, source);
    await expect(table.locator("tr")).toHaveCount(3);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: /^Move column / })).toHaveCount(0);
    await expect(page.locator(".ub-table-controls")).toHaveCount(0);
    expect(await table.locator("tr").evaluateAll((rows) => rows.map((row) => row.querySelectorAll("th, td").length)))
      .toEqual([3, 3, 2]);
    await table.locator("td").first().click();
    await page.keyboard.press("Control+Alt+t");
    await expect(page.getByRole("button", { name: /^Column \d+ actions$/ })).toHaveCount(0);
    await expect(table.locator("td").first()).toHaveText("alpha");
  } finally { fixture.close(); }
});

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
    await table.locator("tr").last().hover();
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

for (const kind of ["row", "column"] as const) {
test(`a received archive closes its ${kind} menu and removes structural controls`, async ({ page }) => {
  const fixture = await publishTable();
  try {
    await page.goto(new URL(`/${ws()}/${fixture.uuid}`, harness().appUrl).href);
    const table = page.locator(".ub-table");
    await expect(table.locator("tr")).toHaveCount(3);
    await expect(page.locator(".ub-editor .ProseMirror")).toHaveAttribute("contenteditable", "true");
    await table.locator("td").first().click();
    await page.getByRole("button", { name: kind === "row" ? "Row 2 actions" : "Column 1 actions", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: `Delete ${kind}`, exact: true })).toBeVisible();
    if (kind === "column") await expect(page.getByRole("menuitem", { name: "Move column right", exact: true })).toBeEnabled();
    tombstoneDirectoryEntry(fixture.directory, fixture.uuid);
    await expect(page.locator(".ub-archived-banner")).toBeVisible();
    await expect(page.locator(".ub-editor .ProseMirror")).toHaveAttribute("contenteditable", "false");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: /^Move column / })).toHaveCount(0);
    await expect(page.locator(".ub-table-controls")).toHaveCount(0);
    await table.locator("td").first().click({ button: "right" });
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(table.locator("td")).toHaveText(["alpha", "one", "beta", "two"]);
    expect(getBlocks(fixture.doc).find((block) => block.id === fixture.id)?.text).toBe(SOURCE);
  } finally { fixture.close(); }
});
}
