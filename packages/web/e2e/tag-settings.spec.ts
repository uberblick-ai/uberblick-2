/** Workspace settings through the real browser, serving replica, and hub. */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { setupHarness } from "./app-helpers.js";

const { harness, openApp } = setupHarness();

function successNotice(page: Page, message: string) {
  return page.locator("[data-sonner-toast]:not([data-removed=true])").filter({
    has: page.locator("[data-description]", { hasText: message }),
  });
}

async function expectSuccess(page: Page, message: string): Promise<void> {
  await expect(successNotice(page, message)).toHaveAttribute("data-type", "success");
  await expect(successNotice(page, message).locator("[data-description]")).toHaveText(message);
  await expect(page.locator("[data-settings-page]").getByText(message, { exact: true })).toHaveCount(0);
}

test("a workspace rename reaches another page live and preserves its document links", async ({
  browser,
}) => {
  const settingsPath = `/${harness().workspace}/settings`;
  const open = async () => {
    const page = await openApp(browser, settingsPath);
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    return page;
  };
  const first = await open();
  const second = await open();
  const name = first.getByLabel("Workspace name");
  const save = first.getByRole("button", { name: "Save", exact: true });

  await name.fill("Product Research");
  await save.click();
  await expectSuccess(first, "Saved “Product Research”.");
  await expect(save).toBeFocused();
  await expect(second.getByLabel("Workspace name")).toHaveValue("Product Research");
  await expect(second.getByRole("button", { name: "Back to Product Research", exact: true })).toBeVisible();

  await second.getByRole("button", { name: "Back to Product Research", exact: true }).click();
  await second.getByRole("button", { name: "+ new doc" }).click();
  await expect(second.locator(".ub-title")).toHaveValue("Untitled");
  await second.locator(".ub-title").fill("Workspace rename links");
  await expect(second.locator(".ub-status-word--saved")).toHaveText("saved here");
  const documentId = new URL(second.url()).pathname.split("/").at(-1);
  const oldNamePath = `/product-research-${harness().workspaceUuid}/${documentId}`;
  await second.goto(new URL(oldNamePath, harness().appUrl).href);
  await expect(second.locator(".ub-title")).toHaveValue("Workspace rename links");

  await name.fill("Field Notes");
  await save.click();
  await expect(second.locator(".ub-workspace-name")).toHaveText("Field Notes");
  await expect(second).toHaveURL(new URL(oldNamePath, harness().appUrl).href);
  await second.locator(".ub-workspace").click();
  await expect(second.getByRole("menuitem", { name: /^Field Notes/ })).toBeVisible();
  await second.keyboard.press("Escape");

  // A rename changes shared display state; each configured spelling and the
  // bare identity still opens the same document, including the previous name.
  await expect(first).toHaveURL(new URL(settingsPath, harness().appUrl).href);
  const facts = first.locator("[data-settings-facts]");
  await expect(facts.locator('div:has(> dt:text-is("Workspace UUID")) > dd')).toHaveText(
    harness().workspaceUuid,
  );
  await expect(facts.locator('div:has(> dt:text-is("Address segment")) > dd')).toHaveText(
    harness().workspace,
  );
  for (const segment of [
    `product-research-${harness().workspaceUuid}`,
    harness().workspaceUuid,
    harness().workspace,
  ]) {
    await second.goto(new URL(`/${segment}/${documentId}`, harness().appUrl).href);
    await expect(second.locator(".ub-title")).toHaveValue("Workspace rename links");
    await expect(second.locator(".ub-workspace-name")).toHaveText("Field Notes");
  }
});

test("Tags settings is address-selected and its catalog changes converge", async ({
  browser,
}) => {
  const path = `/${harness().workspace}/settings/tags`;
  const first = await openApp(browser, path);
  const second = await openApp(browser, path);
  const examples = ["auth", "billing", "mcp", "permissions", "sync"];

  await expect(first).toHaveURL(new URL(path, harness().appUrl).href);
  await expect(first.getByRole("heading", { name: "Tags", level: 1 })).toBeVisible();
  await expect(
    first.getByRole("region", { name: "Active" }).getByRole("listitem"),
  ).toHaveCount(examples.length);
  await expect(
    first
      .getByRole("region", { name: "Active" })
      .getByRole("listitem")
      .locator(":scope > span"),
  ).toHaveText(examples);

  await first.getByLabel("Create a tag").fill("product");
  await first.getByRole("button", { name: "Create", exact: true }).click();
  await expectSuccess(first, "Created “product”.");
  await expect(first.getByRole("button", { name: "Create", exact: true })).toBeFocused();
  await expect(second.getByRole("button", { name: "Retire product" })).toBeVisible();

  // Curated from the keyboard, so focus has to survive the entry moving lists:
  // the control that took its place, and its own new control once the list it
  // left is empty.
  await first.getByRole("button", { name: "Retire product" }).press("Enter");
  await expectSuccess(first, "Retired “product”.");
  await expect(second.getByRole("button", { name: "Restore product" })).toBeVisible();
  await expect(first.getByRole("button", { name: "Retire sync" })).toBeFocused();
  await first.getByRole("button", { name: "Restore product" }).press("Enter");
  await expectSuccess(first, "Restored “product”.");
  await expect(second.getByRole("button", { name: "Retire product" })).toBeVisible();
  await expect(first.getByRole("button", { name: "Retire product" })).toBeFocused();

  await first
    .getByRole("navigation", { name: "Workspace settings" })
    .getByRole("button", { name: "General" })
    .click();
  await expect(first).toHaveURL(
    new URL(`/${harness().workspace}/settings`, harness().appUrl).href,
  );
  await first.goBack();
  await expect(first).toHaveURL(new URL(path, harness().appUrl).href);
  await expect(first.getByRole("heading", { name: "Tags", level: 1 })).toBeVisible();

  // The document front door consumes this catalog: one keyboard-operated
  // control, overlaid without shifting the title, and the same identity on a
  // second client.
  await first.locator(".ub-settings-back").click();
  await first.getByRole("button", { name: "+ new doc" }).click();
  const documentUrl = first.url();
  const title = first.locator(".ub-title");
  const titleBefore = await title.boundingBox();
  const picker = first.getByRole("button", { name: "Edit tags" });
  await picker.focus();
  await picker.press("Enter");
  // Six entries is under the panel's ten-entry search threshold (#958), so the
  // keyboard enters the list itself and walks it to the entry just created.
  await expect(first.getByRole("searchbox", { name: "Search tags" })).toHaveCount(
    0,
  );
  await expect(first.getByRole("option").first()).toBeFocused();
  const product = first.getByRole("option", { name: "product", exact: true });
  for (let step = 0; step < 4; step += 1) await first.keyboard.press("ArrowDown");
  await expect(product).toBeFocused();
  await product.press("Space");
  await product.press("Escape");
  await expect(picker).toBeFocused();
  expect(await title.boundingBox()).toEqual(titleBefore);
  await expect(picker).toContainText("product");
  await expect(first.locator(".ub-doc-meta .ub-badge")).toHaveCount(0);

  await second.goto(documentUrl);
  await expect(second.getByRole("button", { name: "Edit tags" })).toContainText(
    "product",
  );

  // Retirement remains visible on the assigned document, but once removed it
  // cannot be selected again.
  await second.goto(new URL(path, harness().appUrl).href);
  await second.getByRole("button", { name: "Retire product" }).click();
  await expect(picker).toContainText("product (retired)");
  await picker.click();
  const retired = first.getByRole("option", { name: "product retired" });
  await expect(retired).toHaveAttribute("aria-selected", "true");
  await retired.press("Space");
  await expect(first.getByRole("option", { name: "product retired" })).toHaveCount(
    0,
  );
  await picker.click();
  await second.goto(documentUrl);
  await expect(second.getByRole("button", { name: "Edit tags" })).toContainText(
    "Add tags",
  );
});

for (const appearance of ["light", "dark"] as const) {
  test(`settings successes use shared notices and preserve native submission focus — ${appearance}`, async ({ browser }) => {
    const page = await openApp(browser, `/${harness().workspace}/settings`, {
      contextOptions: { colorScheme: appearance }, readySelector: "[data-settings-page]",
    });
    const name = page.getByLabel("Workspace name");
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(name).toBeEnabled();
    await name.fill(" ");
    await name.press("Enter");
    await expect(page.getByRole("alert")).toContainText("1–64 characters after trimming");
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await name.fill(`Notification ${appearance}`);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await name.press("Enter");
    await expectSuccess(page, `Saved “Notification ${appearance}”.`);
    await expect(name).toBeFocused();
    await name.fill(`Pointer ${appearance}`);
    await save.click();
    await expectSuccess(page, `Saved “Pointer ${appearance}”.`);
    await expect(save).toBeFocused();

    await page.getByRole("navigation", { name: "Workspace settings" }).getByRole("button", { name: "Tags", exact: true }).click();
    const field = page.getByLabel("Create a tag");
    const create = page.getByRole("button", { name: "Create", exact: true });
    const tag = `notice-${appearance}-${randomUUID().slice(0, 8)}`;
    await field.fill(tag);
    await field.press("Enter");
    await expectSuccess(page, `Created “${tag}”.`);
    await expect(field).toBeFocused();
    await field.fill(`${tag}-two`);
    await create.click();
    await expectSuccess(page, `Created “${tag}-two”.`);
    await expect(create).toBeFocused();

    // With the preceding success dismissed, neither validation failure adds
    // a notice. Field edits clear alerts; later lifecycle success does too.
    await successNotice(page, `Created “${tag}-two”.`).locator("[data-close-button]").click();
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await field.fill("Invalid Name");
    await field.press("Enter");
    await expect(page.getByRole("alert")).toContainText("1–30 lowercase letters or numbers");
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await field.fill(tag);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await field.press("Enter");
    await expect(page.getByRole("alert")).toContainText("already an active tag");
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

    const active = page.getByRole("region", { name: "Active", exact: true }).getByRole("button");
    const activeNames = await active.allTextContents();
    const at = activeNames.findIndex((text) => text.trim() === `Retire ${tag}`);
    expect(at).toBeGreaterThanOrEqual(0);
    const activeAfterRetire = activeNames.filter((_, index) => index !== at);
    const nextName = activeAfterRetire[Math.min(at, activeAfterRetire.length - 1)];
    if (nextName === undefined) throw new Error("e2e: no tag-list refocus target");
    await page.getByRole("button", { name: `Retire ${tag}`, exact: true }).press("Enter");
    await expectSuccess(page, `Retired “${tag}”.`);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: nextName.trim(), exact: true })).toBeFocused();
    const retired = page.getByRole("region", { name: "Retired", exact: true }).getByRole("button");
    const retiredNames = await retired.allTextContents();
    const retiredAt = retiredNames.findIndex((text) => text.trim() === `Restore ${tag}`);
    expect(retiredAt).toBeGreaterThanOrEqual(0);
    const retiredAfterRestore = retiredNames.filter((_, index) => index !== retiredAt);
    const restoredFocus = retiredAfterRestore[Math.min(retiredAt, retiredAfterRestore.length - 1)]?.trim() ?? `Retire ${tag}`;
    await page.getByRole("button", { name: `Restore ${tag}`, exact: true }).press("Enter");
    await expectSuccess(page, `Restored “${tag}”.`);
    await expect(page.getByRole("button", { name: restoredFocus, exact: true })).toBeFocused();
  });
}
