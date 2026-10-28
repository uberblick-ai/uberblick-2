/** Native comment-card discovery, attribution, selection and settled anchors. */
import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import * as Y from "yjs";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import { wrapToken } from "@uberblick/schema/protocol";
import {
  addComment, appendBlock, createAnnotation, deleteComment, getAnnotationCommentId, initDoc,
  roomForDoc, upsertDirectoryEntry, directoryRoom,
} from "@uberblick/schema";
import { setupHarness } from "./app-helpers.js";
import { renderedText } from "./contrast-helpers.js";

const { harness, openApp } = setupHarness();
const EXTERNAL = "https://example.invalid/spec";
const GITHUB = "https://github.com/Example/SomeRepo/issues/12";
const MARKDOWN = `**must** and *maybe* ~~old~~ \`ub update\`\n[spec](${EXTERNAL})\n${GITHUB}`;

async function fixture(openingText = "Opening conversation", ownReplies = false): Promise<{ uuid: string; first: string; second: string; removeFirst: () => void; close: () => void }> {
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
  const first = createAnnotation(doc, firstBlock, 0, 5, "Claude Client", openingText, undefined,
    { kind: "agent", account: "avatar-success", agent: "claude" });
  addComment(doc, first.id, "Codex Client", "A considered reply", { kind: "agent", account: ownReplies ? "avatar-success" : "avatar-failure", agent: "codex" });
  if (ownReplies) addComment(doc, first.id, "Reader", "A second own reply", { account: "avatar-success", kind: "person" });
  const second = createAnnotation(doc, secondBlock, 0, 6, "Neutral Person", "Another opening comment", undefined, ownReplies ? { account: "avatar-success", kind: "person" } : undefined);
  const directory = await room(directoryRoom(harness().workspaceUuid));
  upsertDirectoryEntry(directory, { uuid, title: "A calm conversation" });
  return { uuid, first: first.id, second: second.id,
    removeFirst: () => {
      const commentId = getAnnotationCommentId(doc, first.id, 0);
      if (commentId === null) throw new Error("The fixture needs its opening comment to delete it");
      deleteComment(doc, first.id, commentId, "avatar-success");
    },
    close: () => {
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

async function ownAccount(page: Page): Promise<void> {
  await avatarStubs(page);
  await page.route("**/api/account", (route) => route.fulfill({
    json: { state: "signed-in", handle: "AVATAR-success" },
  }));
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

async function inlineMarkdown(card: Locator): Promise<void> {
  const text = card.locator(".ub-thread-text").first();
  await expect(text.locator("strong")).toHaveText("must");
  await expect(text.locator("em")).toHaveText("maybe");
  await expect(text.locator("s, del")).toHaveText("old");
  await expect(text.locator("code.ub-inline-code")).toHaveText("ub update");
  await expect(text).toHaveCSS("white-space", "pre-wrap");
  const external = text.getByRole("link", { name: "spec", exact: true });
  const github = text.getByRole("link", { name: "Issue Example/SomeRepo#12", exact: true });
  for (const [link, address] of [[external, EXTERNAL], [github, GITHUB]] as const) {
    await expect(link).toHaveAttribute("href", address);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /\bnoopener\b/);
    await expect(link).toHaveAttribute("rel", /\bnoreferrer\b/);
  }
  await expect(github.locator(".ub-github-pill-repo")).toHaveText("SomeRepo");
  await expect(github.locator(".ub-github-pill-number")).toHaveText("#12");
  await expect(github.locator("svg")).toBeVisible();
}

async function externalPopup(page: Page, address: string, activate: () => Promise<unknown>): Promise<void> {
  const [popup] = await Promise.all([
    page.context().waitForEvent("page", { timeout: 5_000 }), activate(),
  ]);
  try {
    await popup.waitForLoadState();
    await expect(popup).toHaveURL(address);
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    expect(await popup.evaluate(() => document.referrer)).toBe("");
  } finally {
    await popup.close();
    await page.bringToFront();
  }
}

async function destinations(page: Page): Promise<void> {
  await avatarStubs(page);
  await page.context().route(/https:\/\/(?:example\.invalid|github\.com)\//, (route) => route.fulfill({
    contentType: "text/html", body: "<p>External destination</p>",
  }));
}

async function readablePill(page: Page, selector: string, state: string): Promise<void> {
  const paint = await renderedText(page, selector);
  expect(paint.length, state).toBeGreaterThanOrEqual(2);
  for (const reading of paint) expect(reading.ratio, `${state}: ${reading.where}`).toBeGreaterThanOrEqual(4.5);
}

test("comment Markdown links stay native and pills remain readable on resting, hovered and selected cards", async ({ browser }) => {
  const data = await fixture(MARKDOWN);
  try {
    const page = await openApp(browser, `/${harness().workspace}/${data.uuid}`, {
      contextOptions: { viewport: { width: 1600, height: 1000 }, hasTouch: false, isMobile: false, reducedMotion: "reduce" },
      beforeNavigate: destinations,
    });
    const card = page.locator(`#ub-thread-${data.first} .ub-thread`);
    const text = card.locator(".ub-thread-text").first();
    const external = text.getByRole("link", { name: "spec", exact: true });
    const github = text.getByRole("link", { name: "Issue Example/SomeRepo#12", exact: true });
    const pill = github.locator(".ub-github-pill");
    const outside = page.locator(".ub-editor .ub-paragraph").filter({ hasText: "Outside every comment." });
    await inlineMarkdown(card);
    const codeStyle = await text.locator("code").evaluate((element) => {
      const style = getComputedStyle(element);
      if (element.parentElement === null) throw new Error("Inline code needs its text container");
      return { face: style.fontFamily, size: parseFloat(style.fontSize) / parseFloat(getComputedStyle(element.parentElement).fontSize) };
    });
    expect(codeStyle.face).toContain("Geist Mono");
    expect(codeStyle.size).toBeCloseTo(0.85, 2);
    await card.locator(".ub-thread-select").focus();
    await page.keyboard.press("Tab");
    await expect(external).toBeFocused();
    await externalPopup(page, EXTERNAL, () => page.keyboard.press("Enter"));
    await expect(card).not.toHaveAttribute("aria-current", "true");
    await github.focus();
    await externalPopup(page, GITHUB, () => page.keyboard.press("Enter"));
    await expect(card).not.toHaveAttribute("aria-current", "true");
    await text.locator("strong").click();
    await expect(card).toHaveAttribute("aria-current", "true");
    await externalPopup(page, EXTERNAL, () => external.click());
    await expect(card).toHaveAttribute("aria-current", "true");
    await externalPopup(page, GITHUB, () => pill.click());
    await expect(card).toHaveAttribute("aria-current", "true");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await outside.click();
      await page.mouse.move(0, 0);
      await expect(card).not.toHaveAttribute("aria-current", "true");
      await readablePill(page, `#ub-thread-${data.first} .ub-github-pill`, `${colorScheme} resting`);
      const resting = await pill.boundingBox();
      await pill.hover();
      await expect(pill).toHaveCSS("cursor", "pointer");
      await expect(pill.locator(".ub-github-pill-number")).toHaveCSS("text-decoration-line", "underline");
      await readablePill(page, `#ub-thread-${data.first} .ub-github-pill`, `${colorScheme} hovered`);
      await text.locator("strong").click();
      await page.mouse.move(0, 0);
      await expect(card).toHaveAttribute("aria-current", "true");
      await readablePill(page, `#ub-thread-${data.first} .ub-github-pill`, `${colorScheme} selected`);
      const selected = await pill.boundingBox();
      expect(selected?.width).toBe(resting?.width);
      expect(selected?.height).toBe(resting?.height);
    }
  } finally { data.close(); }
});

test("keyboard deletes an own reply immediately and confirms an opening comment's reply count", async ({ browser }) => {
  const data = await fixture("Opening conversation", true);
  try {
    const page = await openApp(browser, `/${harness().workspace}/${data.uuid}`, {
      contextOptions: { viewport: { width: 1600, height: 1000 }, hasTouch: false, isMobile: false, reducedMotion: "reduce" },
      beforeNavigate: ownAccount,
    });
    const card = page.locator(`#ub-thread-${data.first} .ub-thread`);
    const opening = card.locator(".ub-thread-comment").first();
    const remove = opening.getByRole("button", { name: "Delete", exact: true });
    const mark = page.locator(`.ub-comment[data-comment-thread="${data.first}"]`);
    await card.locator(".ub-thread-select").focus();
    await expect(card.locator(".ub-thread-select")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(card).toHaveAttribute("aria-current", "true");
    await page.mouse.move(0, 0);
    await expect(remove).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(opening.getByRole("button", { name: "Edit", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(remove).toBeFocused();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog", { name: "Delete this conversation?" });
    await expect(dialog).toContainText("opening comment and 2 replies");
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(card.locator(".ub-thread-comment")).toHaveCount(3);
    const reply = card.locator(".ub-thread-comment").last();
    await reply.getByRole("button", { name: "Edit", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(reply.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(card.locator(".ub-thread-comment")).toHaveCount(2);
    await expect(dialog).toHaveCount(0);
    await remove.focus();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const paint = await renderedText(page, `#ub-thread-${data.first} .ub-comment-delete`);
      expect(paint.length).toBeGreaterThan(0);
      for (const reading of paint) expect(reading.ratio, `${colorScheme}: ${reading.where}`).toBeGreaterThanOrEqual(4.5);
    }
    await page.keyboard.press("Enter");
    await expect(dialog).toContainText("opening comment and 1 reply");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(card).toHaveCount(0);
    await expect(mark).toHaveCount(0);
    await expect(page.locator(".ub-editor .tiptap")).toBeFocused();
  } finally { data.close(); }
});

test("iPad touch deletes replies and confirms permanent conversation deletion with shared targets", { tag: "@webkit-touch" }, async ({ browser }) => {
  const data = await fixture("Opening conversation", true);
  try {
    const page = await openApp(browser, `/${harness().workspace}/${data.uuid}`, {
      contextOptions: { ...devices["iPad (gen 7)"], reducedMotion: "reduce" }, beforeNavigate: ownAccount,
    });
    await page.locator(".ub-threads-toggle").tap();
    const sheet = page.getByRole("dialog", { name: "Comments", exact: true });
    const card = sheet.locator(`#ub-thread-${data.first} .ub-thread`);
    await card.locator(".ub-thread-text").first().tap();
    const replyRemove = card.locator(".ub-thread-comment").last().getByRole("button", { name: "Delete", exact: true });
    const target = await replyRemove.boundingBox();
    expect(target?.width).toBeGreaterThanOrEqual(44);
    expect(target?.height).toBeGreaterThanOrEqual(44);
    await replyRemove.tap();
    await expect(card.locator(".ub-thread-comment")).toHaveCount(2);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    const openingRemove = card.locator(".ub-thread-comment").first().getByRole("button", { name: "Delete", exact: true });
    await openingRemove.tap();
    const dialog = page.getByRole("alertdialog", { name: "Delete this conversation?" });
    await expect(dialog).toContainText("opening comment and 1 reply");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).tap();
    await expect(card).toBeVisible();
    await openingRemove.tap();
    await dialog.getByRole("button", { name: "Delete", exact: true }).tap();
    await expect(card).toHaveCount(0);
    await expect(sheet).toHaveCount(0);
    await expect(page.locator(".ub-threads-toggle")).toHaveText("Comments 1");
    await expect(page.locator(`.ub-comment[data-comment-thread="${data.first}"]`)).toHaveCount(0);
  } finally { data.close(); }
});

test("a remote conversation deletion removes its card and keeps the unsent text recoverable", async ({ browser }) => {
  const data = await fixture("Opening conversation", true);
  try {
    const page = await openApp(browser, `/${harness().workspace}/${data.uuid}`, {
      contextOptions: { viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" }, beforeNavigate: ownAccount,
    });
    const card = page.locator(`#ub-thread-${data.first} .ub-thread`);
    await card.locator(".ub-thread-text").first().click();
    await card.getByPlaceholder("Reply…").fill("Recover this reply after remote deletion");
    data.removeFirst();
    await expect(card).toHaveCount(0);
    await expect(page.locator(".ub-thread-unsent")).toContainText("Recover this reply after remote deletion");
    await expect(page.locator(`.ub-comment[data-comment-thread="${data.first}"]`)).toHaveCount(0);
  } finally { data.close(); }
});

test("iPad comment drawer renders inline Markdown and follows links without selecting or toggling the card", { tag: "@webkit-touch" }, async ({ browser }) => {
  const data = await fixture(MARKDOWN);
  try {
    const page = await openApp(browser, `/${harness().workspace}/${data.uuid}`, {
      contextOptions: { ...devices["iPad (gen 7)"], reducedMotion: "reduce" },
      beforeNavigate: destinations,
    });
    await page.locator(".ub-threads-toggle").tap();
    const sheet = page.getByRole("dialog", { name: "Comments", exact: true });
    const card = sheet.locator(`#ub-thread-${data.first} .ub-thread`);
    await inlineMarkdown(card);
    const external = card.getByRole("link", { name: "spec", exact: true });
    const github = card.getByRole("link", { name: "Issue Example/SomeRepo#12", exact: true });
    await externalPopup(page, EXTERNAL, () => external.tap());
    await expect(card).not.toHaveAttribute("aria-current", "true");
    await externalPopup(page, GITHUB, () => github.tap());
    await expect(card).not.toHaveAttribute("aria-current", "true");
    await card.locator(".ub-thread-select").tap();
    await expect(card).toHaveAttribute("aria-current", "true");
    await external.focus();
    await externalPopup(page, EXTERNAL, () => page.keyboard.press("Enter"));
    await expect(card).toHaveAttribute("aria-current", "true");
    await github.focus();
    await externalPopup(page, GITHUB, () => page.keyboard.press("Enter"));
    await expect(card).toHaveAttribute("aria-current", "true");
    await expect(sheet).toBeVisible();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await readablePill(page, `#ub-thread-${data.first} .ub-github-pill`, `${colorScheme} drawer selected`);
    }
  } finally { data.close(); }
});

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

test("your comment exposes a quiet Edit action and keyboard saves and cancels in place", async ({ browser }) => {
  const data = await fixture();
  try {
    const page = await openApp(browser, `/${harness().workspace}/${data.uuid}`, {
      contextOptions: { viewport: { width: 1600, height: 1000 }, hasTouch: false, isMobile: false, reducedMotion: "reduce" },
      beforeNavigate: ownAccount,
    });
    const card = page.locator(`#ub-thread-${data.first} .ub-thread`);
    const opening = card.locator(".ub-thread-comment").first();
    const edit = opening.getByRole("button", { name: "Edit", exact: true });
    await expect(card.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await card.locator(".ub-thread-text").first().click();
    await expect(card).toHaveAttribute("aria-current", "true");
    await expect(card.getByRole("button", { name: "Edit", exact: true })).toHaveCount(1);
    await page.mouse.move(0, 0);
    await expect(edit).toHaveCSS("opacity", "0");
    await opening.hover();
    await expect(edit).toHaveCSS("opacity", "1");
    await page.mouse.move(0, 0);
    await opening.locator(".ub-thread-select").focus();
    await expect(edit).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(edit).toBeFocused();
    await page.keyboard.press("Enter");
    const field = opening.getByPlaceholder("Edit comment…");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Opening conversation");
    await field.fill("An abandoned correction");
    await field.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(opening.locator(".ub-thread-text")).toHaveText("Opening conversation");
    await expect(card).toHaveAttribute("aria-current", "true");
    await expect(opening.locator(".ub-comment-edited")).toHaveCount(0);
    await edit.focus();
    await page.keyboard.press("Enter");
    await field.fill("Edited opening");
    await field.press("Enter");
    await expect(field).toHaveCount(0);
    await expect(card.locator(".ub-thread-text")).toHaveCount(2);
    await expect(opening.locator(".ub-thread-text")).toContainText("Edited opening");
    await expect(card.locator(".ub-thread-text").last()).toHaveText("A considered reply");
    await expect(opening.getByRole("img", { name: "via Claude" })).toBeVisible();
    const marker = opening.locator(".ub-comment-edited");
    await expect(marker).toHaveText("(edited)");
    const editedAt = await marker.getAttribute("datetime");
    expect(Number.isFinite(Date.parse(editedAt ?? ""))).toBe(true);
    await expect(opening.locator(".ub-thread-byline time")).toHaveAttribute("datetime", editedAt ?? "");
    await marker.hover();
    await expect(page.getByRole("tooltip")).toHaveText(await marker.getAttribute("title") ?? "");
    await edit.focus();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const paint = await renderedText(page, `#ub-thread-${data.first} .ub-comment-edit`);
      const markerPaint = await renderedText(page, `#ub-thread-${data.first} .ub-comment-edited`);
      expect(paint.length).toBeGreaterThan(0);
      expect(markerPaint.length).toBeGreaterThan(0);
      for (const reading of [...paint, ...markerPaint]) {
        expect(reading.ratio, `${colorScheme}: ${reading.where}`).toBeGreaterThanOrEqual(4.5);
      }
      const inline = await marker.evaluate((node) => {
        const text = node.parentElement?.firstChild;
        if (text === null || text === undefined) throw new Error("e2e: edited comment needs text before its marker");
        const range = node.ownerDocument.createRange();
        range.selectNodeContents(text);
        const before = range.getBoundingClientRect();
        const marker = node.getBoundingClientRect();
        const probe = node.ownerDocument.createElement("span");
        probe.style.color = "var(--muted-foreground)";
        node.ownerDocument.body.append(probe);
        const muted = getComputedStyle(probe).color;
        probe.remove();
        return { after: marker.left >= before.right - 1, sameRow: Math.abs(marker.bottom - before.bottom) <= 4,
          muted: getComputedStyle(node).color === muted };
      });
      expect(inline).toEqual({ after: true, sameRow: true, muted: true });
    }
  } finally { data.close(); }
});

test("iPad touch can start, cancel and save an own comment edit with shared targets", { tag: "@webkit-touch" }, async ({ browser }) => {
  const data = await fixture();
  try {
    const page = await openApp(browser, `/${harness().workspace}/${data.uuid}`, {
      contextOptions: { ...devices["iPad (gen 7)"], reducedMotion: "reduce" },
      beforeNavigate: ownAccount,
    });
    await page.locator(".ub-threads-toggle").tap();
    const sheet = page.getByRole("dialog", { name: "Comments", exact: true });
    const card = sheet.locator(`#ub-thread-${data.first} .ub-thread`);
    const opening = card.locator(".ub-thread-comment").first();
    const edit = opening.getByRole("button", { name: "Edit", exact: true });
    await card.locator(".ub-thread-text").first().tap();
    const editBox = await edit.boundingBox();
    expect(editBox?.width).toBeGreaterThanOrEqual(44);
    expect(editBox?.height).toBeGreaterThanOrEqual(44);
    await edit.tap();
    const field = opening.getByPlaceholder("Edit comment…");
    await expect(field).toHaveValue("Opening conversation");
    await field.fill("Touch correction to cancel");
    const save = opening.getByRole("button", { name: "Save", exact: true });
    const cancel = opening.getByRole("button", { name: "Cancel", exact: true });
    for (const control of [save, cancel]) {
      const target = await control.boundingBox();
      expect(target?.width).toBeGreaterThanOrEqual(44);
      expect(target?.height).toBeGreaterThanOrEqual(44);
    }
    await cancel.tap();
    await expect(field).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(opening.locator(".ub-thread-text")).toHaveText("Opening conversation");
    await edit.tap();
    await field.fill("Touch correction saved");
    await save.tap();
    await expect(field).toHaveCount(0);
    await expect(opening.locator(".ub-thread-text")).toContainText("Touch correction saved");
    await expect(opening.locator(".ub-comment-edited")).toHaveText("(edited)");
    await expect(card.locator(".ub-thread-text").last()).toHaveText("A considered reply");
    await expect(sheet).toBeVisible();
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
    await sheet.getByRole("button", { name: "Close comments" }).tap();
    await mark.focus();
    await mark.press("Enter");
    await expect(card.locator(".ub-thread-select")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(card.getByRole("button", { name: "Resolve", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(sheet.getByRole("button", { name: "1 resolved", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await expect(mark).not.toHaveAttribute("tabindex");
  } finally { data.close(); }
});
