/** Browser identity comes from the serving CLI, then follows this origin's preference. */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createDoc, docTitle, editor, openDoc, setupHarness } from "./app-helpers.js";
import { placeCaret, placeCaretIn } from "./harness.js";

const gitName = "Git Display Name";
const { harness, openApp } = setupHarness({
  gitUserName: gitName,
  app: { readySelector: ".ub-list-head", contextOptions: { viewport: { width: 1440, height: 900 } } },
});

async function rename(page: Page, name: string): Promise<void> {
  await page.getByTestId("account-menu").click();
  const field = page.getByRole("textbox", { name: "Presence name", exact: true });
  await field.fill(name);
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(field).toHaveValue(name.trim() || gitName);
  await page.keyboard.press("Escape");
}

async function comment(page: Page, block: number, passage: string, text: string, author: string): Promise<void> {
  await placeCaretIn(editor(page).locator(":scope > *").nth(block));
  for (let character = 0; character < passage.length; character += 1) {
    await page.keyboard.press("Shift+ArrowLeft");
  }
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(passage);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const composer = page.locator('[data-slot="selection-composer"]');
  const field = composer.getByPlaceholder(`Comment as ${author}…`, { exact: true });
  await field.fill(text);
  await composer.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.locator(".ub-thread-card").filter({ hasText: text }).locator(".ub-thread-author")).toHaveText(author);
}

test("git's name reaches peers and comments, and renaming republishes without rewriting earlier authors", async ({ browser }) => {
  const title = docTitle("presence-name");
  const a = await openApp(browser);
  const b = await openApp(browser);
  await createDoc(a, title, { pin: true });
  await placeCaret(a);
  await a.keyboard.type("First passage");
  await a.keyboard.press("Enter");
  await a.keyboard.type("Second passage");
  await openDoc(b, title);
  await expect(editor(b).locator(":scope > *").nth(1)).toContainText("Second passage");

  await placeCaretIn(editor(a).locator(":scope > *").first());
  const cursor = b.locator(".ub-editor .ProseMirror-yjs-cursor > div");
  const peer = b.locator(".ub-peers > .ub-peer-control");
  await expect(cursor).toHaveText(gitName);
  await expect(peer).toHaveAttribute("aria-label", /^Git Display Name/);
  await comment(a, 0, "First passage", "Before the rename", gitName);
  const earlier = b.locator(".ub-thread-card").filter({ hasText: "Before the rename" });
  await expect(earlier.locator(".ub-thread-author")).toHaveText(gitName);

  const instance = await a.evaluate(() => performance.timeOrigin);
  await rename(a, "  Chosen Display Name  ");
  await expect(peer).toHaveAttribute("aria-label", /^Chosen Display Name/);
  await placeCaretIn(editor(a).locator(":scope > *").first());
  await expect(cursor).toHaveText("Chosen Display Name");
  expect(await a.evaluate(() => performance.timeOrigin)).toBe(instance);
  await comment(a, 1, "Second passage", "After the rename", "Chosen Display Name");
  await expect(b.locator(".ub-thread-card").filter({ hasText: "After the rename" }).locator(".ub-thread-author"))
    .toHaveText("Chosen Display Name");
  await expect(earlier.locator(".ub-thread-author")).toHaveText(gitName);

  // Empty and whitespace-only submissions restore the nonblank serving default.
  for (const cleared of ["", "   "]) {
    await rename(a, cleared);
    await expect(peer).toHaveAttribute("aria-label", /^Git Display Name/);
    await placeCaretIn(editor(a).locator(":scope > *").first());
    await expect(cursor).toHaveText(gitName);
    await rename(a, "Chosen Display Name");
  }
});

test("the chosen name survives reload and a same-port ub open restart in this browser", async ({ browser }) => {
  const page = await openApp(browser);
  await createDoc(page, docTitle("presence-name-persist"));
  await rename(page, "Persistent Display Name");
  await page.reload();
  await expect(editor(page)).toBeVisible();
  await page.getByTestId("account-menu").click();
  await expect(page.getByRole("textbox", { name: "Presence name", exact: true })).toHaveValue("Persistent Display Name");
  await page.keyboard.press("Escape");

  await harness().restartOpen({ authenticated: true });
  await page.reload();
  await expect(editor(page)).toBeVisible();
  await page.getByTestId("account-menu").click();
  await expect(page.getByRole("textbox", { name: "Presence name", exact: true })).toHaveValue("Persistent Display Name");

  // A separate browser profile still begins with the CLI default.
  const fresh = await openApp(browser);
  await fresh.getByTestId("account-menu").click();
  await expect(fresh.getByRole("textbox", { name: "Presence name", exact: true })).toHaveValue(gitName);
});
