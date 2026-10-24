import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  archiveDecisionRecord, createGroup, deleteDirectoryEntry, directoryRoom, pinDoc, readSidebar, sidebarRoom,
} from "@uberblick/schema";
import { wrapToken } from "@uberblick/schema/protocol";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import * as Y from "yjs";
import { activateControl, editor, setupHarness } from "./app-helpers.js";
import { renderedText } from "./contrast-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { expectMcp, expectOpenPages, provePageArrival } from "./settle.js";
import { alphaOf, oklab } from "../test/colour.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl, authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-deleted-documents-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

function session(): McpSession {
  if (agent === null) throw new Error("e2e: the MCP agent is not configured");
  return agent.open({ name: "deleted-documents-e2e" });
}

async function create(writer: McpSession, title: string | undefined, fields: Record<string, unknown> = {}): Promise<{ uuid: string }> {
  return writer.call("create_doc", {
    title, description: "Deletion browser acceptance fixture.",
    blocks: [{ type: "paragraph", text: "Content that permanent deletion must remove." }], ...fields,
  });
}

async function peer(room: string): Promise<{ doc: Y.Doc; close(): void }> {
  const secret = await importRootSecret(harness().authSecret);
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: harness().hubUrl, name: room, document: doc,
    token: async () => wrapToken(await mintToken(secret, {
      typ: "room", sub: randomUUID(), workspace: harness().workspaceUuid,
      scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    })),
  });
  await new Promise<void>(resolve => provider.on("synced", resolve));
  return { doc, close: () => { provider.destroy(); doc.destroy(); } };
}

async function deletedPage(page: Page): Promise<void> {
  await expect(page.locator(".ub-document-pane")).toHaveText("This document was deleted.");
  await expect(page.locator(".ub-document-pane button, .ub-editor, .ub-archived-banner, .ub-thread")).toHaveCount(0);
}

async function calmBanner(page: Page, touch: boolean): Promise<void> {
  const banner = page.locator(".ub-archived-banner");
  await expect(banner).toContainText("Archived. Read-only and hidden from the document list.");
  // Shared controls animate theme changes; contrast needs the settled palette.
  await banner.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true })
      .filter(animation => animation instanceof CSSTransition)
      .map(animation => animation.finished.catch(() => undefined)));
  });
  const paint = await banner.evaluate(element => {
    const icon = element.querySelector("svg");
    const message = element.querySelector(":scope > span");
    if (icon === null || message === null) throw new Error("e2e: missing archive icon or message");
    const probe = document.createElement("span");
    probe.style.cssText = "border:1px solid var(--border);color:var(--foreground)";
    element.append(probe);
    try {
      return {
        fill: getComputedStyle(element).backgroundColor,
        border: getComputedStyle(element).borderColor,
        normalBorder: getComputedStyle(probe).borderColor,
        text: getComputedStyle(message).color,
        normalText: getComputedStyle(probe).color,
        icon: getComputedStyle(icon).color,
        iconBeforeMessage: Boolean(icon.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    } finally { probe.remove(); }
  });
  expect(paint.border).toBe(paint.normalBorder);
  expect(paint.text).toBe(paint.normalText);
  expect(paint.iconBeforeMessage).toBe(true);
  expect(alphaOf(paint.fill)).toBeGreaterThan(0);
  for (const [colour, maximum] of [[paint.fill, 0.03], [paint.icon, 0.1]] as const) {
    const lab = oklab(colour);
    expect(lab.chroma).toBeGreaterThan(0.005);
    expect(lab.chroma).toBeLessThan(maximum);
    expect(Math.atan2(lab.b, lab.a) * 180 / Math.PI).toBeGreaterThan(50);
    expect(Math.atan2(lab.b, lab.a) * 180 / Math.PI).toBeLessThan(100);
  }
  expect(paint.icon).not.toBe(paint.text);
  const readings = await renderedText(page, ".ub-archived-banner");
  expect(readings.length).toBeGreaterThanOrEqual(3);
  for (const reading of readings) expect(reading.ratio, reading.where).toBeGreaterThanOrEqual(4.5);
  if (touch) {
    for (const action of await banner.getByRole("button").all()) {
      expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
  }
}

for (const touch of [false, true]) {
  test(`archived deletion is calm, cancellable and permanent on ${touch ? "iPad touch @webkit-touch" : "desktop"} in both appearances`, async ({ browser }) => {
    const writer = session();
    const title = `Delete acceptance ${touch ? "touch" : "desktop"}`;
    const target = await create(writer, title);
    const page = await openApp(browser, `/${harness().workspace}/${target.uuid}`, {
      contextOptions: { ...(touch ? devices["iPad (gen 7)"] : { viewport: { width: 1440, height: 1000 } }), colorScheme: "light" },
    });
    await expect(editor(page)).toContainText("Content that permanent deletion must remove.");
    await activateControl(page.getByRole("button", { name: "Document actions", exact: true }), { touch });
    await activateControl(page.getByRole("menuitem", { name: "Archive document", exact: true }), { touch });
    await activateControl(page.getByRole("alertdialog").getByRole("button", { name: "Archive", exact: true }), { touch });
    const banner = page.locator(".ub-archived-banner");
    await expect(banner.getByRole("button", { name: "Restore", exact: true })).toBeFocused();
    const trigger = banner.getByRole("button", { name: "Delete…", exact: true });
    const dialog = page.getByRole("alertdialog", { name: `Delete “${title}”?`, exact: true });
    for (const appearance of ["light", "dark"] as const) {
      await test.step(`${appearance} banner and confirmation`, async () => {
        await page.emulateMedia({ colorScheme: appearance });
        expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(appearance === "dark");
        await calmBanner(page, touch);
        await activateControl(trigger, { touch });
        await expect(dialog).toContainText("It will be gone for everyone, with its comments and history. Links to it will show it was deleted. This can't be undone.");
        await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
        const remove = dialog.getByRole("button", { name: "Delete", exact: true });
        const deletePaint = await remove.evaluate(element => {
          const probe = document.createElement("span");
          probe.style.backgroundColor = "var(--destructive)";
          element.append(probe);
          try { return { fill: getComputedStyle(element).backgroundColor, destructive: getComputedStyle(probe).backgroundColor }; }
          finally { probe.remove(); }
        });
        expect(deletePaint.fill).toBe(deletePaint.destructive);
        await activateControl(dialog.getByRole("button", { name: "Cancel", exact: true }), { touch });
        await expect(dialog).toHaveCount(0);
        await expect(banner).toBeVisible();
        await activateControl(trigger, { touch });
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(editor(page)).toContainText("Content that permanent deletion must remove.");
      });
    }
    await activateControl(trigger, { touch });
    await activateControl(dialog.getByRole("button", { name: "Delete", exact: true }), { touch });
    await deletedPage(page);
    await page.reload();
    await deletedPage(page);
  });
}

for (const touch of [false, true]) {
  test(`archived topic deletion includes every record on ${touch ? "iPad touch @webkit-touch" : "desktop"} in both appearances`, async ({ browser }) => {
    const writer = session();
    const title = `Delete topic acceptance ${touch ? "touch" : "desktop"}`;
    const owner = await create(writer, "Owner of a permanently deleted topic");
    const first = await create(writer, title, { kind: "decision", status: "decided", related: owner.uuid });
    const current = await create(writer, undefined, {
      kind: "decision", status: "decided", supersedes: first.uuid,
      answer: { who: "Browser acceptance", when: "2026-10-22T12:00:00Z", where: "https://example.org/decision" },
    });
    const proposal = await create(writer, undefined, { kind: "decision", supersedes: current.uuid });
    const source = await create(writer, "Deleted topic reference fixture", { blocks: [
      { type: "paragraph", inline: [
        { text: "topic reference", marks: { docLink: first.uuid } },
        { text: " and ", marks: {} },
        { text: "record reference", marks: { docLink: proposal.uuid } },
      ] },
    ] });
    const directory = await peer(directoryRoom(harness().workspaceUuid));
    const sidebar = await peer(sidebarRoom(harness().workspaceUuid));
    try {
      expect(archiveDecisionRecord(directory.doc, sidebar.doc, proposal.uuid)).toBe(true);
      const page = await openApp(browser, `/${harness().workspace}/${first.uuid}/record/${proposal.uuid}`, {
        contextOptions: { ...(touch ? devices["iPad (gen 7)"] : { viewport: { width: 1440, height: 1000 } }), colorScheme: "light" },
      });
      const banner = page.locator(".ub-archived-banner");
      await expect(banner).toBeVisible();
      await expect(banner.getByRole("button", { name: /^Delete/ })).toHaveCount(0);
      await writer.call("archive_doc", { uuid: current.uuid });
      const trigger = banner.getByRole("button", { name: "Delete topic…", exact: true });
      await expect(trigger).toBeVisible();
      for (const uuid of [first.uuid, current.uuid, proposal.uuid]) {
        await page.goto(new URL(`/${harness().workspace}/${first.uuid}/record/${uuid}`, page.url()).href);
        await expect(trigger).toBeVisible();
      }
      const dialog = page.getByRole("alertdialog", { name: `Delete topic “${title}”?`, exact: true });
      for (const appearance of ["light", "dark"] as const) {
        await test.step(`${appearance} topic banner and confirmation`, async () => {
          await page.emulateMedia({ colorScheme: appearance });
          expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(appearance === "dark");
          await calmBanner(page, touch);
          await activateControl(trigger, { touch });
          await expect(dialog).toContainText("The topic and all its records will be deleted for everyone, with their comments and history.");
          await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
          await activateControl(dialog.getByRole("button", { name: "Cancel", exact: true }), { touch });
          await expect(dialog).toHaveCount(0);
          await activateControl(trigger, { touch });
          await page.keyboard.press("Escape");
          await expect(dialog).toHaveCount(0);
          await expect(editor(page)).toBeVisible();
        });
      }
      const references = await openApp(browser, `/${harness().workspace}/${source.uuid}`);
      await expect(editor(references).locator(".ub-doclink")).toHaveCount(2);
      await activateControl(trigger, { touch });
      await activateControl(dialog.getByRole("button", { name: "Delete topic", exact: true }), { touch });
      await deletedPage(page);
      for (const uuid of [first.uuid, current.uuid, proposal.uuid]) {
        await expectMcp(async () => {
          await expect(writer.call("get_doc", { uuid })).rejects.toThrow(/doc_deleted/);
        });
      }
      for (const link of await editor(references).locator(".ub-doclink").all()) {
        await expect(link).toHaveAttribute("data-doc-link-state", "deleted");
        await expect(link).not.toHaveAttribute("href");
      }
      await page.reload();
      await deletedPage(page);
      const ownerPage = await openApp(browser, `/${harness().workspace}/${owner.uuid}`);
      await expect(editor(ownerPage)).toBeVisible();
      await expect(ownerPage.locator(".ub-decisions-block")).toHaveCount(0);
    } finally { sidebar.close(); directory.close(); }
  });
}

async function inertReference(page: Page, link: Locator): Promise<void> {
  const address = page.url();
  await expect(link).toHaveAttribute("data-doc-link-state", "deleted");
  await expect(link).toHaveAttribute("title", "This document was deleted.");
  await expect(link).not.toHaveAttribute("href");
  await expect(link).toHaveAttribute("tabindex", "-1");
  await expect(link).toHaveCSS("text-decoration-line", "line-through");
  await expect(link).toHaveCSS("text-decoration-style", "solid");
  const colours = await link.evaluate(element => {
    const probe = document.createElement("span");
    probe.style.color = "var(--muted-foreground)";
    element.append(probe);
    try { return { actual: getComputedStyle(element).color, muted: getComputedStyle(probe).color }; }
    finally { probe.remove(); }
  });
  expect(colours.actual).toBe(colours.muted);
  const compactTitle = link.locator(".ub-decision-rfc-title");
  if (await compactTitle.count() > 0) {
    await expect(compactTitle).toHaveCSS("color", colours.muted);
    await expect(compactTitle).toHaveCSS("text-decoration-line", "line-through");
    await expect(compactTitle).toHaveCSS("text-decoration-style", "solid");
  }
  await link.click();
  await link.click({ modifiers: ["ControlOrMeta"] });
  await link.click({ modifiers: ["Shift"] });
  await link.click({ button: "middle" });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await link.focus();
  await page.keyboard.press("Enter");
  await provePageArrival(page, { path: "browser context" });
  await expectOpenPages(page.context(), 1);
  await expect(page).toHaveURL(address);
}

test("remote deletion retires an open page and stale pin, while prose, table and topic references stay inert", async ({ browser }) => {
  const writer = session();
  const target = await create(writer, "Remote permanent deletion target");
  const source = await create(writer, "Permanent deletion reference fixture", { blocks: [
    { type: "paragraph", inline: [{ text: "prose reference", marks: { docLink: target.uuid } }] },
    { type: "table", text: `| Reference |\n| --- |\n| [table reference](${target.uuid}) |` },
  ] });
  let before = "";
  await expectMcp(() => writer.call<{ markdown: string }>("export_markdown", { uuid: source.uuid, frontmatter: false }), exported => {
    expect(exported.markdown).toContain(target.uuid);
    before = exported.markdown;
  });
  const first = await create(writer, "Deleted RFC reference topic", {
    kind: "decision", status: "decided", discussion: target.uuid,
  });
  await create(writer, "Deleted RFC reference topic", {
    kind: "decision", status: "decided", discussion: target.uuid, supersedes: first.uuid,
    answer: { who: "Browser acceptance", when: "2026-10-22T12:00:00Z", where: "https://example.org/decision" },
  });
  await writer.call("archive_doc", { uuid: source.uuid });
  await writer.call("archive_doc", { uuid: target.uuid });
  const directory = await peer(directoryRoom(harness().workspaceUuid));
  const sidebar = await peer(sidebarRoom(harness().workspaceUuid));
  try {
    const group = createGroup(sidebar.doc, "Stale deleted pin");
    pinDoc(sidebar.doc, group, target.uuid);
    const targetPage = await openApp(browser, `/${harness().workspace}/${target.uuid}`);
    await expect(targetPage.locator(".ub-archived-banner")).toBeVisible();
    const topicPage = await openApp(browser, `/${harness().workspace}/${first.uuid}`);
    const selectedRfc = topicPage.locator(".ub-decision-rfc .ub-doclink");
    const historyRfc = topicPage.locator(`.ub-decision-timeline li[data-record="${first.uuid}"] .ub-decision-record-rfc .ub-doclink`);
    await expect(selectedRfc).toHaveAttribute("data-doc-link-state", "archived");
    const page = await openApp(browser, `/${harness().workspace}/${source.uuid}`, {
      contextOptions: { viewport: { width: 1440, height: 1000 } },
    });
    const pin = page.locator(".ub-pin-row > button").filter({ hasText: "Remote permanent deletion target" });
    await expect(pin).toBeVisible();
    const prose = editor(page).locator(":scope > p .ub-doclink");
    const cell = editor(page).locator(".ub-table td .ub-doclink");
    await expect(prose).toHaveAttribute("data-doc-link-state", "archived");
    await expect(cell).toHaveAttribute("data-doc-link-state", "archived");
    deleteDirectoryEntry(directory.doc, target.uuid);
    await deletedPage(targetPage);
    await expect(pin).toHaveCount(0);
    expect(readSidebar(sidebar.doc).find(entry => entry.id === group)?.docs).toEqual([target.uuid]);
    await inertReference(page, prose);
    await inertReference(page, cell);
    await inertReference(topicPage, selectedRfc);
    await inertReference(topicPage, historyRfc);
    await expect(prose).toHaveText("prose reference");
    await expect(cell).toHaveText("table reference");
    await expectMcp(() => writer.call<{ markdown: string }>("export_markdown", { uuid: source.uuid, frontmatter: false }), exported => {
      expect(exported.markdown).toBe(before);
    });
    await targetPage.reload();
    await deletedPage(targetPage);
  } finally { sidebar.close(); directory.close(); }
});
