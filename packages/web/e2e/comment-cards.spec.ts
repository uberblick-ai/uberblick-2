/** Native comment-card discovery, attribution, selection and settled anchors. */
import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import * as Y from "yjs";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import { wrapToken } from "@uberblick/schema/protocol";
import {
  addComment, appendBlock, createAnnotation, initDoc,
  roomForDoc, upsertDirectoryEntry, directoryRoom,
} from "@uberblick/schema";
import { setupHarness } from "./app-helpers.js";

const { harness, openApp } = setupHarness();

async function fixture(): Promise<{ uuid: string; first: string; second: string; close: () => void }> {
  const uuid = randomUUID();
  const secret = await importRootSecret(harness().authSecret);
  const peers: Array<{ doc: Y.Doc; provider: HocuspocusProvider }> = [];
  const room = async (name: string): Promise<Y.Doc> => {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: harness().hubUrl, name, document: doc,
      token: async () => wrapToken(await mintToken(secret, {
        typ: "room", sub: randomUUID(), workspace: harness().workspaceUuid,
        scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      })),
    });
    peers.push({ doc, provider });
    await new Promise<void>((resolve) => provider.on("synced", resolve));
    return doc;
  };
  const doc = await room(roomForDoc(harness().workspaceUuid, uuid));
  initDoc(doc, { uuid, title: "A calm conversation" });
  const firstBlock = appendBlock(doc, { type: "paragraph", text: "First annotated range." });
  const secondBlock = appendBlock(doc, { type: "paragraph", text: "Second annotated range." });
  appendBlock(doc, { type: "paragraph", text: "Outside every comment." });
  const first = createAnnotation(doc, firstBlock, 0, 5, "Claude Client", "Opening conversation", undefined,
    { kind: "agent", account: "avatar-success", agent: "claude" });
  addComment(doc, first.id, "Codex Client", "A considered reply", { kind: "agent", account: "avatar-failure", agent: "codex" });
  const second = createAnnotation(doc, secondBlock, 0, 6, "Neutral Person", "Another opening comment");
  const directory = await room(directoryRoom(harness().workspaceUuid));
  upsertDirectoryEntry(directory, { uuid, title: "A calm conversation" });
  return { uuid, first: first.id, second: second.id, close: () => {
    for (const peer of peers) { peer.provider.destroy(); peer.doc.destroy(); }
  } };
}

async function avatarStubs(page: Page): Promise<void> {
  await page.route("https://avatars.githubusercontent.com/**", async (route) => {
    if (route.request().url().includes("avatar-failure")) await route.abort();
    else await route.fulfill({ contentType: "image/svg+xml", body:
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#456"/></svg>' });
  });
}

async function revealed(card: Locator, value: "0" | "1"): Promise<void> {
  for (const control of await card.locator(".ub-thread-control").all()) {
    await expect(control).toHaveCSS("opacity", value);
  }
}

async function inlineReply(field: Locator, send: Locator): Promise<void> {
  const [input, button] = await Promise.all([field.boundingBox(), send.boundingBox()]);
  if (input === null || button === null) throw new Error("e2e: reply controls need layout boxes");
  expect(button.x).toBeGreaterThanOrEqual(input.x + input.width - 1);
  expect(Math.abs(button.y + button.height - input.y - input.height)).toBeLessThanOrEqual(1);
}

test("comment cards reveal quiet controls through hover, keyboard and selection while drafts stay with each card", async ({ browser }) => {
  const data = await fixture();
  try {
    const page = await openApp(browser, `/${harness().workspace}/${data.uuid}`, {
      contextOptions: { viewport: { width: 1600, height: 1000 }, hasTouch: false, isMobile: false, reducedMotion: "reduce" },
      beforeNavigate: avatarStubs,
    });
    const first = page.locator(`#ub-thread-${data.first} .ub-thread`);
    const second = page.locator(`#ub-thread-${data.second} .ub-thread`);
    const outside = page.locator(".ub-editor .ub-paragraph").filter({ hasText: "Outside every comment." });
    const mark = page.locator(`[data-comment-thread="${data.first}"]`);
    await expect(first).toContainText("1 reply");
    await expect(first).not.toContainText("A considered reply");
    await expect(first.locator(".ub-thread-ref, .ub-thread-excerpt, .ub-chip")).toHaveCount(0);
    await page.mouse.move(0, 0);
    await revealed(first, "0");
    await first.hover();
    await revealed(first, "1");
    await page.mouse.move(0, 0);
    await revealed(first, "0");
    await first.locator(".ub-thread-select").focus();
    await revealed(first, "1");
    await page.keyboard.press("Tab");
    await expect(first.getByRole("button", { name: "Resolve", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    const reply = first.getByPlaceholder("Reply…");
    await expect(reply).toBeFocused();
    const send = first.getByRole("button", { name: "Reply", exact: true });
    await inlineReply(reply, send);
    await expect(send).toBeDisabled();
    await expect(send).toHaveCSS("opacity", "0.4");
    await reply.fill("Keep the first draft");
    await expect(send).toBeEnabled();
    await expect(send).toHaveCSS("opacity", "1");
    await first.locator(".ub-thread-select").focus();
    await page.keyboard.press("Enter");
    await expect(first).toHaveAttribute("aria-current", "true");
    await expect(first).toContainText("A considered reply");
    await page.mouse.move(0, 0);
    await revealed(first, "1");
    await expect(first.getByRole("img", { name: "via Claude" })).toBeVisible();
    await expect(first.getByRole("img", { name: "via Codex" })).toBeVisible();
    await expect(first.locator(".ub-comment-agent [data-icon=claude] svg")).toBeVisible();
    await expect(first.locator(".ub-comment-agent [data-icon=codex] svg")).toBeVisible();
    await expect(first.locator(".ub-comment-avatar img")).toHaveCount(1);
    await expect(first.locator(".ub-comment-avatar").last()).toHaveText("CC");
    await expect(second.locator(".ub-comment-avatar")).toHaveText("NP");
    await expect(first.locator(".ub-comment-avatar img")).toHaveJSProperty("naturalWidth", 32);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const backgrounds = await page.locator(".ub-comment").evaluateAll((marks) => marks.map((node) => getComputedStyle(node).backgroundColor));
      const tokens = await page.evaluate(() => {
        const probe = document.createElement("span");
        document.body.append(probe);
        probe.style.backgroundColor = "var(--brand-subtle)";
        const selected = getComputedStyle(probe).backgroundColor;
        probe.style.backgroundColor = "var(--muted)";
        const neutral = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { selected, neutral };
      });
      expect(backgrounds).toEqual([tokens.selected, tokens.neutral]);
    }
    await second.locator(".ub-thread-text").first().click();
    await second.getByPlaceholder("Reply…").fill("Keep the second draft");
    await expect(page.locator('.ub-thread[aria-current="true"]')).toHaveCount(1);
    await expect(first).toContainText("1 reply");
    await outside.click();
    await expect(page.locator('.ub-thread[aria-current="true"]')).toHaveCount(0);
    await first.locator(".ub-thread-text").first().click();
    await expect(reply).toHaveValue("Keep the first draft");
    await reply.press("Escape");
    await expect(mark).toBeFocused();
    await expect(page.locator('.ub-thread[aria-current="true"]')).toHaveCount(0);
    await first.locator(".ub-thread-text").first().click();
    await expect(reply).toHaveValue("Keep the first draft");
    await second.locator(".ub-thread-text").first().click();
    await expect(second.getByPlaceholder("Reply…")).toHaveValue("Keep the second draft");
    await second.getByPlaceholder("Reply…").press("Enter");
    await expect(second.locator(".ub-thread-text")).toHaveText(["Another opening comment", "Keep the second draft"]);
    await second.locator(".ub-thread-select").focus();
    await page.keyboard.press("Tab");
    await expect(second.getByRole("button", { name: "Resolve", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    const resolved = page.getByRole("button", { name: "1 resolved", exact: true });
    await expect(resolved).toBeFocused();
    await expect(second).toHaveCount(0);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(second.locator(".ub-thread-select")).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(second.getByRole("button", { name: "Reopen", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(second).toHaveAttribute("aria-current", "true");
    await expect(page.locator(`[data-comment-thread="${data.second}"]`)).toHaveAttribute("tabindex", "0");
  } finally { data.close(); }
});

test("iPad taps select, reply, resolve and reopen without reviving a resolved anchor", { tag: "@webkit-touch" }, async ({ browser }) => {
  const data = await fixture();
  try {
    const page = await openApp(browser, `/${harness().workspace}/${data.uuid}`, {
      contextOptions: { ...devices["iPad (gen 7)"], reducedMotion: "reduce" },
      beforeNavigate: avatarStubs,
    });
    const mark = page.locator(`[data-comment-thread="${data.first}"]`);
    const toggle = page.locator(".ub-threads-toggle");
    await expect(toggle).toHaveText("Comments 2");
    await toggle.tap();
    const sheet = page.getByRole("dialog", { name: "Comments", exact: true });
    const card = sheet.locator(`#ub-thread-${data.first} .ub-thread`);
    await card.locator(".ub-thread-text").first().tap();
    const reply = card.getByPlaceholder("Reply…");
    const send = card.getByRole("button", { name: "Reply", exact: true });
    await reply.fill("Touch reply");
    await inlineReply(reply, send);
    for (const control of [send, card.getByRole("button", { name: "Resolve", exact: true })]) {
      const box = await control.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await send.tap();
    await expect(card).toContainText("Touch reply");
    await card.getByRole("button", { name: "Resolve", exact: true }).tap();
    await expect(card.getByPlaceholder("Reply…")).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "1 resolved" })).toBeVisible();
    await sheet.getByRole("button", { name: "Close comments" }).tap();
    await expect(toggle).toHaveText("Comments 1");
    await expect(mark).not.toHaveAttribute("role");
    await expect(mark).not.toHaveAttribute("tabindex");
    await expect(mark).not.toHaveAttribute("aria-label");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(mark).not.toHaveClass(/(?:^| )ub-comment(?: |$)/);
      await expect(mark).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(mark).toHaveCSS("border-bottom-width", "0px");
      await expect(mark).not.toHaveCSS("cursor", "pointer");
    }
    await mark.tap();
    await expect(sheet).toHaveCount(0);
    await toggle.tap();
    const resolved = sheet.getByRole("button", { name: "1 resolved" });
    const target = await resolved.boundingBox();
    expect(target?.height).toBeGreaterThanOrEqual(44);
    await expect(card).toHaveCount(0);
    await resolved.tap();
    await expect(card).toBeVisible();
    await resolved.tap();
    await expect(card).toHaveCount(0);
    await resolved.tap();
    await card.locator(".ub-thread-text").first().tap();
    const reopen = card.getByRole("button", { name: "Reopen", exact: true });
    const reopenTarget = await reopen.boundingBox();
    expect(reopenTarget?.height).toBeGreaterThanOrEqual(44);
    await reopen.tap();
    await sheet.getByRole("button", { name: "Close comments" }).tap();
    await expect(mark).toHaveAccessibleName("Comment");
    await expect(mark).toHaveAttribute("tabindex", "0");
    await expect(mark).toHaveClass(/(?:^| )ub-comment(?: |$)/);
    await mark.tap();
    await expect(sheet).toBeVisible();
    await expect(card).toContainText("Touch reply");
  } finally { data.close(); }
});
