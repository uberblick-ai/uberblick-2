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

  await first.getByRole("button", { name: "Retire product" }).click();
  await expect(second.getByRole("button", { name: "Restore product" })).toBeVisible();
  await first.getByRole("button", { name: "Restore product" }).click();
  await expect(second.getByRole("button", { name: "Retire product" })).toBeVisible();

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
});
