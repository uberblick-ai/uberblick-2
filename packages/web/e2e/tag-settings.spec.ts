import { waitForAcknowledged } from "./settle.js";
/** Settings through the real browser, serving replica, and hub. */

import { expect, test } from "@playwright/test";
import { EXAMPLE_TAGS } from "@uberblick/schema";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { setupHarness } from "./app-helpers.js";

const { harness, openApp } = setupHarness({ accessRole: "admin", seedExampleTags: true });

function successNotice(page: Page, message: string) {
  return page.locator("[data-sonner-toast]:not([data-removed=true])").filter({
    has: page.locator("[data-title]", { hasText: message }),
  });
}

async function expectSuccess(page: Page, message: string): Promise<void> {
  await expect(successNotice(page, message)).toHaveAttribute("data-type", "success");
  await expect(successNotice(page, message).locator("[data-title]")).toHaveText(message);
  await expect(page.locator("[data-settings-page]").getByText(message, { exact: true })).toHaveCount(0);
  await expect.poll(() => successNotice(page, message).evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      withinViewport: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
      lowerRight: box.left > innerWidth / 2 && box.top > innerHeight / 2,
      receivesPointer: element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)),
    };
  })).toEqual({ withinViewport: true, lowerRight: true, receivesPointer: true });
}

async function expectSubmissionFocusRetained(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.activeElement ===
    (window as unknown as { settingsSubmissionOrigin?: Element }).settingsSubmissionOrigin)).toBe(true);
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
  const name = first.getByLabel("Name", { exact: true });
  const save = first.getByRole("button", { name: "Save", exact: true });

  await name.fill("Product Research");
  await save.click();
  await expectSuccess(first, "Saved “Product Research”.");
  await expect(save).toBeFocused();
  await expect(second.getByLabel("Name", { exact: true })).toHaveValue("Product Research");
  await expect(second.locator(".ub-settings-back")).toHaveText("Product Research");

  await second.locator(".ub-settings-back").click();
  await second.getByRole("button", { name: "+ New page" }).click();
  await expect(second.locator(".ub-title")).toHaveValue("Untitled");
  await second.locator(".ub-title").fill("Workspace rename links");
  await waitForAcknowledged(second, { path: "relay" });
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
  await expect(facts.locator('div:has(> dt:text-is("Workspace ID")) > dd > span > span')).toHaveText(
    harness().workspaceUuid,
  );
  await first.getByRole("button", { name: "Connection details", exact: true }).click();
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
  const examples = EXAMPLE_TAGS.map((entry) => entry.name);

  await expect(first).toHaveURL(new URL(path, harness().appUrl).href);
  await expect(first.getByRole("heading", { name: "Tags", level: 1 })).toBeVisible();
  await expect(
    first.locator("[data-tag-list]").getByRole("listitem"),
  ).toHaveCount(examples.length);
  await expect(
    first
      .locator("[data-tag-list]")
      .getByRole("listitem")
      .locator(":scope > span"),
  ).toHaveText(examples);

  await first.getByLabel("Create a tag").fill("product");
  await first.getByRole("button", { name: "Create", exact: true }).click();
  await expectSuccess(first, "Created “product”.");
  await expect(first.getByRole("button", { name: "Create", exact: true })).toBeFocused();
  await expect(second.getByRole("button", { name: "Delete product" })).toBeVisible();

  await first.getByRole("button", { name: "Delete product" }).press("Enter");
  let dialog = first.getByRole("alertdialog", { name: "Delete “product”?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(second.getByRole("button", { name: "Delete product" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(first.getByRole("button", { name: "Delete product" })).toBeFocused();
  await first.getByRole("button", { name: "Delete product" }).press("Enter");
  dialog = first.getByRole("alertdialog", { name: "Delete “product”?" });
  await dialog.getByRole("button", { name: "Delete", exact: true }).press("Enter");
  await expectSuccess(first, "Deleted “product”.");
  await expect(second.getByRole("button", { name: "Delete product" })).toHaveCount(0);
  await expect(first.getByLabel("Create a tag")).toBeFocused();
  await first.getByLabel("Create a tag").fill("PRODUCT");
  await first.getByRole("button", { name: "Create", exact: true }).click();
  await expect(second.getByRole("button", { name: "Delete product" })).toBeVisible();

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
  await first.getByRole("button", { name: "+ New page" }).click();
  const documentUrl = first.url();
  const title = first.locator(".ub-title");
  const titleBefore = await title.boundingBox();
  const picker = first.getByRole("button", { name: "Edit tags" });
  await picker.focus();
  await picker.press("Enter");
  // This catalog is under the panel's ten-entry search threshold, so the
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

  // Deletion immediately hides the assignment on the other browser.
  await second.goto(new URL(path, harness().appUrl).href);
  await second.getByRole("button", { name: "Delete product" }).click();
  await second.getByRole("alertdialog", { name: "Delete “product”?" }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(picker).toContainText("Add tags");
  await picker.click();
  await expect(first.getByRole("option", { name: "product", exact: true })).toHaveCount(0);
  await picker.click();
  await second.goto(documentUrl);
  await expect(second.getByRole("button", { name: "Edit tags" })).toContainText(
    "Add tags",
  );
});

test("settings successes use shared notices and preserve native submission focus @webkit", async ({ browser }) => {
  const appearance = "light";
  const page = await openApp(browser, `/${harness().workspace}/settings`, {
    contextOptions: { colorScheme: appearance, viewport: { width: 1440, height: 900 }, isMobile: false }, readySelector: "[data-settings-page]",
  });
  // Capture the browser's native focus before the product submit handler:
  // Safari pointer activation can blur a field without focusing the button.
  await page.evaluate(() => document.addEventListener("submit", () => {
    (window as unknown as { settingsSubmissionOrigin: Element | null }).settingsSubmissionOrigin = document.activeElement;
  }, true));
  const name = page.getByLabel("Name", { exact: true });
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
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
    { width: 820, height: 1180 },
    { width: 768, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    const nextName = `Pointer ${appearance} ${viewport.width}`;
    await name.fill(nextName);
    await save.click();
    await expectSuccess(page, `Saved “${nextName}”.`);
    await expectSubmissionFocusRetained(page);
    expect(await save.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    })).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("navigation", { name: "Workspace settings" }).getByRole("button", { name: "Tags", exact: true }).click();
  const field = page.getByLabel("Create a tag");
  const create = page.getByRole("button", { name: "Create", exact: true });
  const tag = `notice-${appearance}-${randomUUID().slice(0, 8)}`;
  const draft = `  ${tag.toUpperCase()} `;
  await field.fill(draft);
  await expect(field).toHaveValue(draft);
  await field.press("Enter");
  await expectSuccess(page, `Created “${tag}”.`);
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
  await field.fill(`${tag}-two`);
  await create.click();
  await expectSuccess(page, `Created “${tag}-two”.`);
  await expectSubmissionFocusRetained(page);

  // With the preceding success expired, neither validation failure adds
  // a notice. Field edits clear alerts; later deletion success does too.
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  for (const invalid of ["iOS app", "ios--app"]) {
    await field.fill(invalid);
    await field.press("Enter");
    await expect(page.getByRole("alert")).toHaveText("Use 1–30 letters or numbers, separated by single hyphens.");
    await expect(field).toHaveValue(invalid);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  }
  await field.fill(draft);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await field.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(`“${tag}” is already a tag.`);
  await expect(field).toHaveValue(draft);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

  await page.getByRole("button", { name: `Delete ${tag}`, exact: true }).press("Enter");
  const confirmation = page.getByRole("alertdialog", { name: `Delete “${tag}”?` });
  await confirmation.getByRole("button", { name: "Delete", exact: true }).press("Enter");
  await expectSuccess(page, `Deleted “${tag}”.`);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(field).toBeFocused();
  await field.fill(draft);
  await field.press("Enter");
  await expectSuccess(page, `Created “${tag}”.`);
  await expect(field).toBeFocused();
});
