/**
 * The sidebar's two anchored menus, in a real browser (#74) — and with them the
 * claim the vendored chrome rests on (#27).
 *
 * These assertions used to run against a demo page, because when the chrome was
 * adopted there was nowhere in the product that opened a Radix surface. There
 * is now, so they point at it and the demo is gone.
 *
 * What earns a browser here, and nothing else does:
 *
 * - **The bridge resolves.** The whole adoption rests on one claim: shadcn
 *   surfaces read the same custom properties the plain-CSS surfaces do, so
 *   there is no second palette to drift. That is testable — a menu's painted
 *   background and its font have to *equal* the sidebar's, in both colour
 *   schemes, and they only can if `@theme` resolved to the product's tokens
 *   rather than to Tailwind's defaults.
 * - **The primitives behave.** They portal out of the app's subtree, take the
 *   keyboard and close on Escape. jsdom will happily let all of that be broken.
 * - **The theme is real.** `data-theme` re-themes the editor and the sidebar
 *   from tokens alone, and survives a reload. A stylesheet is exactly what
 *   jsdom does not have.
 * - **A connected agent is counted.** The count reads awareness over a real
 *   hub, and the session it counts is a client that is not a browser at all.
 */

import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { mintToken } from "@uberblick/hub";
import { directoryRoom } from "@uberblick/schema";
import * as Y from "yjs";
import { startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

test.describe.configure({ mode: "serial" });

let started: Harness | null = null;
const contexts: BrowserContext[] = [];

function harness(): Harness {
  if (started === null) {
    throw new Error("e2e: the harness is not running — its bootstrap failed");
  }
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

async function openApp(
  browser: Browser,
  colorScheme: "light" | "dark",
): Promise<Page> {
  const context = await browser.newContext({ colorScheme });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(harness().appUrl);
  await expect(page.locator(".ub-workspace")).toBeVisible();
  return page;
}

/** What a browser actually paints for one property of one element. */
function painted(page: Page, selector: string, property: string): Promise<string> {
  return page.evaluate(
    ([sel, prop]) => {
      const element = document.querySelector(sel as string);
      if (element === null) throw new Error(`no element for ${sel}`);
      return getComputedStyle(element).getPropertyValue(prop as string);
    },
    [selector, property] as const,
  );
}

/** How wide something is laid out, so "full-bleed" is a number, not a look. */
async function width(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`no box for ${selector}`);
  return Math.round(box.width);
}

/**
 * A surface reads as the product's if it is painted on the product's card and
 * set in the product's face — the two things `@theme` bridges.
 */
async function matchesTheSidebar(page: Page, selector: string): Promise<void> {
  expect(await painted(page, selector, "background-color")).toBe(
    await painted(page, ".ub-list", "background-color"),
  );
  expect(await painted(page, selector, "font-family")).toBe(
    await painted(page, ".ub-list", "font-family"),
  );
}

for (const scheme of ["light", "dark"] as const) {
  test(`the sidebar's menus are the product's own surface — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openApp(browser, scheme);

    // The switcher: anchored to the sidebar's header and as wide as it.
    await page.locator(".ub-workspace").click();
    const menu = page.locator("[data-slot=dropdown-menu-content]");
    await expect(menu).toBeVisible();
    await matchesTheSidebar(page, "[data-slot=dropdown-menu-content]");
    expect(await width(page, "[data-slot=dropdown-menu-content]")).toBe(
      await width(page, ".ub-workspace"),
    );

    // The configured workspace, with the count the directory reports.
    await expect(menu.getByRole("menuitem", { name: harness().workspace })).toBeVisible();
    // Management is on the menu and unavailable — not hidden.
    for (const name of ["New workspace", "Workspace settings"]) {
      await expect(menu.getByRole("menuitem", { name })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    // The user panel: the same surface, opened from the foot of the column.
    await page.locator(".ub-user-card").click();
    const panel = page.locator("[data-slot=popover-content]");
    await expect(panel).toBeVisible();
    await matchesTheSidebar(page, "[data-slot=popover-content]");
    await expect(panel.getByRole("group", { name: "Presence colour" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });
}

test("the appearance choice re-themes the app from tokens alone, and survives a reload", async ({
  browser,
}) => {
  // A browser whose system preference is light: everything that follows is the
  // reader overruling it, which is the whole point of the setting.
  const page = await openApp(browser, "light");
  // A document, so there is an editor on screen to re-theme — its ink comes
  // from `--prose-text`, a token nothing else in the app reads.
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ub-paragraph")).toBeVisible();
  const sidebar = await painted(page, ".ub-list", "background-color");
  const prose = await painted(page, ".ub-editor .ub-paragraph", "color");

  await page.locator(".ub-user-card").click();
  await page.getByRole("button", { name: "Dark", exact: true }).click();

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // Two surfaces, neither of which knows a theme exists: both are painted from
  // tokens, and both moved.
  expect(await painted(page, ".ub-list", "background-color")).not.toBe(sidebar);
  expect(await painted(page, ".ub-editor .ub-paragraph", "color")).not.toBe(prose);
  const dark = await painted(page, ".ub-list", "background-color");
  // And the vendored surface came with them, over a scheme it was not given.
  await matchesTheSidebar(page, "[data-slot=popover-content]");

  await page.reload();
  await expect(page.locator(".ub-editor .ub-paragraph")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await painted(page, ".ub-list", "background-color")).toBe(dark);

  // Back to the system's answer, which is this context's light.
  await page.locator(".ub-user-card").click();
  await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
  expect(await painted(page, ".ub-list", "background-color")).toBe(sidebar);
});

test("MCP connections counts a connected agent session, and stops when it goes", async ({
  browser,
}) => {
  const page = await openApp(browser, "dark");
  const connections = page.locator(".ub-panel-fact", { hasText: "MCP connections" });

  await page.locator(".ub-user-card").click();
  await expect(connections).toContainText("0");

  // An agent, as far as the hub and the awareness map are concerned: a client
  // that publishes a user and does not claim to be this app. That is exactly
  // what the MCP server's replicas publish (`mcp-server/src/replica.ts`).
  const doc = new Y.Doc();
  const agent = new HocuspocusProvider({
    url: harness().hubUrl,
    name: directoryRoom(harness().workspaceUuid),
    document: doc,
    token: () =>
      mintToken(harness().authSecret, {
        sub: `agent-${randomUUID()}`,
        workspace: harness().workspaceUuid,
        scope: "read-write",
      }),
  });
  agent.setAwarenessField("user", { name: "an agent", color: "#7b5ec7" });

  try {
    await expect(connections).toContainText("1");
  } finally {
    agent.destroy();
  }
  await expect(connections).toContainText("0");
});
