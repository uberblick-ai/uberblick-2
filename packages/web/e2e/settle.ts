import { expect, test } from "@playwright/test";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import type { McpSession } from "./mcp-agent.js";
import { dataRevision } from "../src/editor/render-state.js";
import type { RenderData } from "../src/editor/render-state.js";
import type { JSONValue } from "@uberblick/schema";

export type SyncPath = "relay" | "upstream";

/** A relay acknowledgement covers this computer; upstream also covers its hub. */
export async function waitForAcknowledged(page: Page, options: { path: SyncPath }): Promise<void> {
  await test.step(`acknowledged by ${options.path === "relay" ? "ub open relay" : "upstream hub"}`, async () => {
    const status = page.locator(".ub-status[data-local-sync]");
    await expect(status).toHaveAttribute("data-local-sync", "acknowledged");
    if (options.path === "upstream") {
      const upstream = await status.getAttribute("data-upstream-sync");
      if (upstream !== null) await expect(status).toHaveAttribute("data-upstream-sync", "acknowledged");
    }
  });
}

export async function waitForDraw(block: Locator, options: {
  source: string;
  data?: Parameters<typeof dataRevision>[0];
  outcome?: "success" | "error";
  timeout?: number;
}): Promise<void> {
  await expect.poll(() => block.evaluate(element => ({
    source: element.getAttribute("data-source-rev"),
    data: element.getAttribute("data-data-rev"),
    outcome: element.getAttribute("data-draw-state"),
  })), options.timeout === undefined ? {} : { timeout: options.timeout })
    .toEqual({ source: options.source, data: dataRevision(options.data ?? null), outcome: options.outcome ?? "success" });
}

/** Poll the actual MCP reader instead of asserting one possibly stale answer. */
export async function expectMcp(assertion: () => Promise<void>): Promise<void>;
export async function expectMcp<T>(read: () => Promise<T>, assertion: (value: T) => void | Promise<void>): Promise<void>;
export async function expectMcp<T>(read: () => Promise<T>, assertion?: (value: T) => void | Promise<void>): Promise<void> {
  await test.step("converges at the upstream hub MCP reader", async () => {
    await expect(async () => {
      const value = await read();
      if (assertion !== undefined) await assertion(value);
    }).toPass({ timeout: 20_000 });
  });
}

export async function expectUpstreamHub(assertion: () => void | Promise<void>): Promise<void> {
  await test.step("converges at the upstream hub storage reader", async () => {
    await expect(assertion).toPass({ timeout: 20_000 });
  });
}

/** Compute a complete expected data revision through bounded public MCP pages. */
export async function readRenderData(session: McpSession, uuid: string): Promise<RenderData | null> {
  const summary = await session.call<{ data: { collections: { name: string }[] } | null }>("get_data", { uuid });
  if (summary.data === null) return null;
  const collections: { name: string; schema: JSONValue | null; records: { id: string; value: JSONValue }[] }[] = [];
  for (const entry of summary.data.collections) {
    const records: { id: string; value: JSONValue }[] = [];
    let after: string | undefined;
    let schema: JSONValue | null = null;
    do {
      const page = await session.call<{
        schema: JSONValue | null; records: { id: string; value: JSONValue }[]; next_after: string | null;
      }>("get_data", { uuid, collection: entry.name, limit: 1000, max_bytes: 1024 * 1024,
        ...(after === undefined ? {} : { after }) });
      schema = page.schema;
      records.push(...page.records.map(({ id, value }) => ({ id, value })));
      after = page.next_after ?? undefined;
    } while (after !== undefined);
    collections.push({ name: entry.name, schema, records });
  }
  return { collections };
}

export async function waitForDocumentDraw(page: Page, session: McpSession, uuid: string, options: {
  index?: number | "all"; outcome?: "success" | "error"; source?: string; timeout?: number;
} = {}): Promise<void> {
  const throughRelay = await page.locator(".ub-status[data-local-sync]").getAttribute("data-upstream-sync") !== null;
  await test.step(`upstream MCP revision is drawn through ${throughRelay ? "ub open relay" : "direct upstream hub"}`, async () => {
    type Block = { id: string; type: string; language?: string; text: string; rev: string };
    let blocks: Block[] = [];
    await expect(async () => {
      const doc = await session.call<{ blocks: Block[] }>("get_doc", { uuid });
      const rendered = doc.blocks.filter(entry => entry.type === "chart" || entry.type === "code" && entry.language === "wireframe");
      const block = rendered[options.index === "all" ? 0 : options.index ?? 0];
      expect(block).toBeDefined();
      if (options.source !== undefined) expect(block?.text).toBe(options.source);
      blocks = options.index === "all" ? rendered : block === undefined ? [] : [block];
    }).toPass({ timeout: options.timeout ?? 20_000 });
    const data = blocks.some(block => block.type === "chart") ? await readRenderData(session, uuid) : null;
    for (const block of blocks) {
      await waitForDraw(page.locator(`[id="${block.id}"]`), { source: block.rev, data: block.type === "chart" ? data : null,
        ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }) });
    }
  });
}

/**
 * A later tag write takes the same document room, relay and hub as a content
 * write. Reading it on this MCP session proves the preceding browser action
 * has reached the replica used by get_doc, export_markdown and get_data.
 */
export async function proveMcpArrival(page: Page, session: McpSession, uuid: string, options: { path: "upstream"; restore?: boolean }): Promise<void> {
  await test.step(`later browser metadata reaches the ${options.path} MCP reader`, async () => {
    const picker = page.getByRole("button", { name: "Edit tags", exact: true });
    const archived = await page.getByRole("button", { name: "Restore", exact: true }).count() > 0;
    if (archived) await page.getByRole("button", { name: "Restore", exact: true }).click();
    await picker.click();
    const option = page.getByRole("option").first();
    const selected = await option.getAttribute("aria-selected") === "true";
    const label = (await option.locator(":scope > span").nth(1).textContent())?.trim();
    if (label === undefined || label === "") throw new Error("e2e: arrival proof needs a catalog tag");
    await expectMcp(() => session.call<{ tags: { name: string }[] }>("get_doc", { uuid }), doc => {
      expect(doc.tags.some(tag => tag.name === label)).toBe(selected);
    });
    await option.click();
    await page.keyboard.press("Escape");
    await waitForAcknowledged(page, { path: options.path });
    await expectMcp(() => session.call<{ tags: { name: string }[] }>("get_doc", { uuid }), doc => {
      expect(doc.tags.some(tag => tag.name === label)).toBe(!selected);
    });
    if (options.restore === true) {
      await picker.click();
      await page.getByRole("option", { name: label, exact: true }).click();
      await page.keyboard.press("Escape");
      await waitForAcknowledged(page, { path: options.path });
      await expectMcp(() => session.call<{ tags: { name: string }[] }>("get_doc", { uuid }), doc => {
        expect(doc.tags.some(tag => tag.name === label)).toBe(selected);
      });
    }
    if (archived) {
      await page.getByRole("button", { name: "Document actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Archive document", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Archive document", exact: true }).click();
      await waitForAcknowledged(page, { path: options.path });
    }
  });
}

/** The raw upstream fixtures start without tags, making the later assignment unambiguous. */
export async function proveBrowserArrival(page: Page, options: {
  path: "upstream"; readTags: () => string[] | Promise<string[]>;
}): Promise<void> {
  await test.step("later browser metadata reaches the upstream hub replica reader", async () => {
    const archived = await page.getByRole("button", { name: "Restore", exact: true }).count() > 0;
    if (archived) await page.getByRole("button", { name: "Restore", exact: true }).click();
    await page.getByRole("button", { name: "Edit tags", exact: true }).click();
    await expect(page.getByRole("option", { selected: true })).toHaveCount(0);
    await expect.poll(options.readTags).toEqual([]);
    await page.getByRole("option", { selected: false }).first().click();
    await page.keyboard.press("Escape");
    await waitForAcknowledged(page, { path: options.path });
    await expect.poll(options.readTags).toHaveLength(1);
    if (archived) {
      await page.getByRole("button", { name: "Document actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Archive document", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Archive document", exact: true }).click();
      await waitForAcknowledged(page, { path: options.path });
    }
  });
}

/** Observe a later metadata write at both pages before checking unchanged document content. */
export async function proveDocumentPageArrival(actor: Page, reader: Page, options: { path: SyncPath }): Promise<void> {
  const throughRelay = await actor.locator(".ub-status[data-local-sync]").getAttribute("data-upstream-sync") !== null;
  const path = options.path === "relay" ? "ub open relay→document page" :
    throughRelay ? "ub open relay→upstream hub→document page" : "upstream hub→observer";
  await test.step(`later browser metadata reaches ${path}`, async () => {
    await actor.getByRole("button", { name: "Edit tags", exact: true }).click();
    const option = actor.getByRole("option").first();
    const selected = await option.getAttribute("aria-selected") === "true";
    const label = (await option.locator(":scope > span").nth(1).textContent())?.trim();
    if (label === undefined || label === "") throw new Error("e2e: page arrival proof needs a catalog tag");
    const hasTag = async (page: Page): Promise<boolean> => (await page.locator(".ub-tag-name").allTextContents()).includes(label);
    await expect.poll(() => hasTag(reader)).toBe(selected);
    await option.click();
    await actor.keyboard.press("Escape");
    await waitForAcknowledged(actor, { path: options.path });
    await expect.poll(() => hasTag(actor)).toBe(!selected);
    await expect.poll(() => hasTag(reader)).toBe(!selected);
  });
}

export async function expectOpenPages(context: BrowserContext, count: number): Promise<void> {
  await expect.poll(() => context.pages().length).toBe(count);
}

/** A later real popup proves that this context has delivered preceding page events. */
export async function provePageArrival(page: Page, options: { path: "browser context" }): Promise<void> {
  await test.step(`later positive page event reaches ${options.path}`, async () => {
    const [popup] = await Promise.all([
      page.context().waitForEvent("page"),
      page.evaluate(() => { window.open("about:blank", "_blank", "noopener,noreferrer"); }),
    ]);
    await popup.waitForLoadState();
    await popup.close();
    await page.bringToFront();
  });
}
