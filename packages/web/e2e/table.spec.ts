/** Composed TableKit surface: direct input, contained overflow and caret reveal. */
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/hub";
import { wrapToken } from "@uberblick/hub/protocol";
import { appendBlock, directoryRoom, getBlocksFragment, initDoc, roomForDoc, tableCellText, tableRows, upsertDirectoryEntry } from "@uberblick/schema";
import * as Y from "yjs";
import { createDoc, docTitle, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";

const { harness, ws } = setupHarness();

test("TableKit cells stay drawn and wide tables contain horizontal scrolling", { tag: "@webkit" }, async ({ page }, info) => {
  await page.goto(harness().appUrl);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await createDoc(page, "Editable table");
  await placeCaret(page);
  await page.keyboard.type("Neighbor paragraph");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/table");
  await page.keyboard.press("Enter");
  const table = page.locator(".ub-table");
  await expect(table).toBeVisible();
  await expect(table.locator("th")).toHaveCount(3);
  await expect(table.locator("td")).toHaveCount(6);
  const first = table.locator("th").first();
  if (info.project.use.hasTouch === true) await first.tap();
  else await first.click();
  await page.keyboard.type("Direct");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Enter");
  await expect(first).toHaveText("Direct");
  await expect(first.locator("p")).toHaveCount(1);
  await expect(page.locator(".ub-table-source")).toHaveCount(0);

  // A fresh empty paragraph takes exactly one GFM table, retaining the block.
  await page.locator(".ub-editor .ProseMirror > p").first().click();
  await placeCaret(page);
  await page.keyboard.press("Enter");
  const header = "| Name | Amount | Date | Status | Owner | Notes | Source | Last column |";
  await page.keyboard.type(header);
  await page.keyboard.press("Enter");
  await page.keyboard.type("| --- | --- | --- | --- | --- | --- | --- | --- |");
  const wide = page.locator(".ub-table").first();
  await expect(wide.locator("th")).toHaveCount(8);
  const wrapper = wide.locator("..");
  await expect.poll(() => wrapper.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await wide.locator("th").first().click();
  for (let index = 0; index < 7; index += 1) await page.keyboard.press("Tab");
  await expect.poll(() => wrapper.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await page.keyboard.type(" edited");
  await expect(wide.locator("th").last()).toContainText("edited");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Native horizontal wheel input stands in for a trackpad's deltaX.
  if (info.project.use.isMobile !== true) {
    await wrapper.evaluate((element) => { element.scrollLeft = 0; });
    await wrapper.hover();
    await page.mouse.wheel(500, 0);
    await expect.poll(() => wrapper.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  }

  await wide.locator("th").last().scrollIntoViewIfNeeded();
  await wide.locator("th").last().evaluate((element, pointerType) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { pointerType, bubbles: true, pointerId: 1 }));
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  }, info.project.use.hasTouch === true ? "touch" : "mouse");
  const formatting = page.getByRole("toolbar", { name: "Text formatting", exact: true });
  await expect(formatting).toBeVisible();
  await expect(formatting.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
  if (process.env.UB_AGENTS_SCRATCH !== undefined) {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH, `table-${info.project.name}-${colorScheme}.png`) });
    }
  }
});

test("a document link typed in a table cell opens its target and Back restores the table", async ({ page }, info) => {
  await page.goto(harness().appUrl);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  const targetTitle = docTitle("cell-target");
  const target = await createDoc(page, targetTitle);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  const source = await createDoc(page, docTitle("cell-source"));
  await placeCaret(page);
  await page.keyboard.type("/table");
  await page.keyboard.press("Enter");
  const cell = page.locator(".ub-table th").first();
  if (info.project.use.hasTouch === true) await cell.tap();
  else await cell.click();
  await page.keyboard.type(`[the target](${target})`);
  const link = cell.locator("a.ub-doclink");
  await expect(link).toHaveText("the target");
  await expect(link).toHaveAttribute("data-doc-id", target);
  if (info.project.use.hasTouch === true) await link.tap();
  else await link.click();
  await expect(page).toHaveURL(new RegExp(`/${ws()}/${target}$`));
  await expect(page.locator(".ub-title")).toHaveValue(targetTitle);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/${ws()}/${source}$`));
  await expect(page.locator(".ub-table th").first().locator("a.ub-doclink")).toHaveText("the target");
});

test("two merged cell link conflicts stay distinct through repair and the table binds afterwards", async ({ page }, info) => {
  const source = randomUUID();
  const targets = [randomUUID(), randomUUID()] as const;
  const hrefs = ["https://example.invalid/first", "https://example.invalid/other"] as const;
  const doc = new Y.Doc();
  initDoc(doc, { uuid: source, title: "Table conflict repair" });
  appendBlock(doc, { type: "table", text: "| first suffix | other suffix | unchanged |\n| --- | --- | --- |" });
  const texts = (ydoc: Y.Doc): [Y.XmlText, Y.XmlText, Y.XmlText] => {
    const table = getBlocksFragment(ydoc).get(0);
    if (!(table instanceof Y.XmlElement)) throw new Error("e2e: table fixture is absent");
    const row = tableRows(table)[0];
    if (row?.length !== 3) throw new Error("e2e: table fixture must have three header cells");
    const [first, second, third] = row.map((cell) => tableCellText(cell));
    if (!(first instanceof Y.XmlText) || !(second instanceof Y.XmlText) || !(third instanceof Y.XmlText)) {
      throw new Error("e2e: table fixture cells must hold shared text");
    }
    return [first, second, third];
  };
  const cells = texts(doc);
  cells[0].format(0, 5, { bold: true });
  cells[1].format(0, 5, { italic: true });
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  for (const column of [0, 1] as const) {
    cells[column].format(0, 5, { link: { href: hrefs[column] } });
    texts(other)[column].format(0, 5, { docLink: { docId: targets[column] } });
  }
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
  other.destroy();

  const peers: Array<{ provider: HocuspocusProvider; ydoc: Y.Doc }> = [];
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
  try {
    const directory = await connect(directoryRoom(harness().workspaceUuid));
    upsertDirectoryEntry(directory, { uuid: source, title: "Table conflict repair" });
    targets.forEach((uuid, column) => { upsertDirectoryEntry(directory, { uuid, title: `Cell target ${column + 1}` }); });
    await connect(roomForDoc(harness().workspaceUuid, source), doc);
    await page.goto(new URL(`/${ws()}/${source}`, harness().appUrl).href);
    const repairs = page.locator(".ub-link-repair li");
    await expect(repairs).toHaveCount(2);
    await expect(page.locator(".ub-editor .ProseMirror")).toHaveCount(0);
    await expect(repairs.nth(0).locator("q")).toHaveText("first");
    await expect(repairs.nth(1).locator("q")).toHaveText("other");
    const first = repairs.nth(0).getByRole("button", { name: "Keep the document: Cell target 1", exact: true });
    if (info.project.use.hasTouch === true) await first.tap();
    else await first.click();
    await expect(repairs).toHaveCount(1);
    await expect(repairs.locator("q")).toHaveText("other");
    await expect(page.locator(".ub-editor .ProseMirror")).toHaveCount(0);
    const second = repairs.getByRole("button", { name: `Keep the link: ${hrefs[1]}`, exact: true });
    if (info.project.use.hasTouch === true) await second.tap();
    else await second.click();
    await expect(repairs).toHaveCount(0);
    const table = page.locator(".ub-table");
    await expect(table.locator("th")).toHaveText(["first suffix", "other suffix", "unchanged"]);
    await expect(table.locator("th").nth(0).locator("strong a.ub-doclink, a.ub-doclink strong")).toHaveText("first");
    await expect(table.locator("th").nth(1).locator("em a.ub-link, a.ub-link em")).toHaveText("other");
    await expect.poll(() => cells[0].toDelta()).toEqual([
      { insert: "first", attributes: { bold: true, docLink: { docId: targets[0] } } }, { insert: " suffix" },
    ]);
    await expect.poll(() => cells[1].toDelta()).toEqual([
      { insert: "other", attributes: { italic: true, link: { href: hrefs[1] } } }, { insert: " suffix" },
    ]);
  } finally {
    for (const { provider, ydoc } of peers) { provider.destroy(); ydoc.destroy(); }
    if (!peers.some((peer) => peer.ydoc === doc)) doc.destroy();
  }
});
