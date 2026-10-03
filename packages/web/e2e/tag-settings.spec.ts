/** Workspace settings through the real browser, serving replica, and hub. */

import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

test.describe.configure({ mode: "serial" });

let started: Harness | null = null;
const contexts: BrowserContext[] = [];

function harness(): Harness {
  if (started === null) throw new Error("e2e: the harness is not running");
  return started;
}

test.beforeAll(async () => {
  started = await startHarness();
});

test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

test.afterAll(async () => {
  const running = started;
  started = null;
  await running?.stop();
});

test("a workspace rename reaches another page live and preserves its document links", async ({
  browser,
}) => {
  const settingsPath = `/${harness().workspace}/settings`;
  const open = async (): Promise<Page> => {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(new URL(settingsPath, harness().appUrl).href);
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    return page;
  };
  const first = await open();
  const second = await open();
  const name = first.getByLabel("Workspace name");
  const save = first.getByRole("button", { name: "Save", exact: true });

  await name.fill("Product Research");
  await save.click();
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
  const open = async (): Promise<Page> => {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(new URL(path, harness().appUrl).href);
    return page;
  };
  const first = await open();
  const second = await open();
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
  await expect(second.getByRole("button", { name: "Retire product" })).toBeVisible();

  // Curated from the keyboard, so focus has to survive the entry moving lists:
  // the control that took its place, and its own new control once the list it
  // left is empty.
  await first.getByRole("button", { name: "Retire product" }).press("Enter");
  await expect(second.getByRole("button", { name: "Restore product" })).toBeVisible();
  await expect(first.getByRole("button", { name: "Retire sync" })).toBeFocused();
  await first.getByRole("button", { name: "Restore product" }).press("Enter");
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
