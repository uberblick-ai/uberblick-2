/** Workspace tag curation through the real browser, serving replica, and hub. */

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
  const search = first.getByRole("searchbox", { name: "Search tags" });
  await expect(search).toBeFocused();
  await search.fill("PRO");
  await search.press("ArrowDown");
  const product = first.getByRole("option", { name: "product", exact: true });
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
