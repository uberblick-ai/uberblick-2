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
 * - **A highlight steps off its ground.** `light-dark()` and `oklch()` are
 *   resolved by the browser and by nothing else, so a contrast floor is only a
 *   number where there is a rendering engine to measure (#516).
 * - **A bundled face is really there.** A `font-family` in a stylesheet is a
 *   wish; only an engine that fetched the woff2 and put it in `document.fonts`
 *   says the title is set in the face the app ships rather than in the serif
 *   behind it (#536).
 * - **The brand's ink is one value, and readable.** Four rules across three
 *   surfaces are meant to resolve to the same colour and clear AA on every
 *   ground they land on; only an engine that ran the cascade can say whether
 *   they did (#569).
 * - **A surface is measured, not a selector list.** The sidebar's interior is
 *   held to its own strokes and to WCAG AA by walking what the column and its
 *   two menus actually paint — which needs a cascade, a `light-dark()` and a
 *   layout, and is what a list of rules checked one at a time missed (#515).
 * - **The document and rail are one composition.** Their fixed insets and
 *   overlay breakpoint are geometry, so only a laid-out browser can prove that
 *   viewport surplus follows them without shifting the prose.
 */

import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  importRootSecret,
  MAX_TOKEN_LIFETIME_SECONDS,
  mintToken,
} from "@uberblick/hub";
import { wrapToken } from "@uberblick/hub/protocol";
import { appendBlock, directoryRoom, getBlocksFragment } from "@uberblick/schema";
import * as Y from "yjs";
import { placeCaret, startHarness } from "./harness.js";
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

/**
 * The app in its own context, at `path` — `/`, and the workspace the harness
 * configured, unless a test names another address.
 *
 * The address is an argument rather than a second `goto`; each proof starts on
 * the production serving path it means to exercise.
 */
async function openApp(
  browser: Browser,
  colorScheme: "light" | "dark",
  path = "",
  hasTouch = false,
): Promise<Page> {
  const context = await browser.newContext({ colorScheme, hasTouch });
  contexts.push(context);
  // This file's synthetic peers exercise direct hub presence. Relaying that
  // presence through `ub open` is #753, so preserve the existing proof by
  // keeping the browser on the same upstream as those peers.
  await context.route("**/uberblick-config.json", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hubUrl: harness().hubUrl,
        workspaces: [harness().workspace],
        hubAuthToken: harness().authSecret,
      }),
    });
  });
  const page = await context.newPage();
  await page.goto(new URL(path, harness().appUrl).href);
  await expect(page.locator(".ub-workspace")).toBeVisible();
  return page;
}

/** Visit the owner surface once so its ordinary example catalog is available. */
async function ensureExampleCatalog(page: Page): Promise<void> {
  await page.goto(
    new URL(`/${harness().workspace}/settings/tags`, harness().appUrl).href,
  );
  await expect(page.getByRole("heading", { name: "Tags", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Active" }).getByRole("listitem"),
  ).toHaveCount(5);
  await page.locator(".ub-settings-back").click();
  await expect(page).toHaveURL(
    new URL(`/${harness().workspace}`, harness().appUrl).href,
  );
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

/** The same, for an element already found rather than named by selector. */
function paintedIn(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (element, prop) => getComputedStyle(element).getPropertyValue(prop),
    property,
  );
}

/** How wide something is laid out, so "full-bleed" is a number, not a look. */
async function width(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`no box for ${selector}`);
  return Math.round(box.width);
}

/**
 * A surface reads as the product's if it is painted on the sidebar's own ground
 * and set in the product's face — the two things `@theme` bridges. Both of
 * these menus belong to that column, which is why it is the sidebar they have
 * to equal and not the card (#480).
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
    const configured = menu.getByRole("menuitem", { name: harness().workspace });
    await expect(configured).toBeVisible();

    // And an item on that surface stays visible when it is the one being
    // chosen. Matching the container is not enough to prove that: the menu now
    // floats the sidebar's ground, and in dark `--accent` *is* that ground, so
    // an item highlighted out of the global palette would paint itself
    // invisible (#480). Radix carries one `data-highlighted` state for the
    // keyboard and the pointer, so this is asserted through each of them.
    const ground = await painted(page, "[data-slot=dropdown-menu-content]", "background-color");
    await page.keyboard.press("ArrowDown");
    const highlighted = menu.locator("[data-highlighted]");
    await expect(highlighted).toHaveCount(1);
    expect(await paintedIn(highlighted, "background-color")).not.toBe(ground);

    await configured.hover();
    await expect(configured).toHaveAttribute("data-highlighted", /.*/);
    expect(await paintedIn(configured, "background-color")).not.toBe(ground);

    // Machine-owned creation stays unavailable; settings is now a route.
    await expect(menu.getByRole("menuitem", { name: "New workspace" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(
      menu.getByRole("menuitem", { name: "Workspace settings" }),
    ).not.toHaveAttribute("aria-disabled", "true");
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

for (const scheme of ["light", "dark"] as const) {
  test(`the selected appearance has one non-hue cue — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openApp(browser, scheme);
    await page.locator(".ub-user-card").click();
    const panel = page.locator("[data-slot=popover-content]");
    await expect(panel).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    const appearance = panel.getByRole("group", { name: "Appearance" });
    const options = appearance.getByRole("button");
    const system = appearance.getByRole("button", { name: "System", exact: true });
    const matching = appearance.getByRole("button", {
      name: scheme === "light" ? "Light" : "Dark",
      exact: true,
    });
    const untouched = appearance.getByRole("button", {
      name: scheme === "light" ? "Dark" : "Light",
      exact: true,
    });
    const boxes = (): Promise<Array<[number, number, number, number]>> =>
      options.evaluateAll((elements) =>
        elements.map((element) => {
          const frame = element.closest<HTMLElement>("[data-slot=popover-content]");
          if (frame === null) {
            throw new Error("e2e: appearance option geometry has no popover frame");
          }
          const box = element.getBoundingClientRect();
          const origin = frame.getBoundingClientRect();
          return [box.x - origin.x, box.y - origin.y, box.width, box.height];
        }),
      );
    const treatment = (option: Locator) =>
      option.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.backgroundColor, style.borderColor, style.color];
      });
    const cue = async (option: Locator): Promise<string> => {
      expect(
        Number.parseFloat(await paintedIn(option, "border-top-width")),
      ).toBeGreaterThan(0);
      const colour = await paintedIn(option, "border-top-color");
      expect(
        contrast(colour, await paintedIn(option, "background-color")),
      ).toBeGreaterThanOrEqual(3);
      return colour;
    };

    const before = await boxes();
    await expect(system).toHaveAttribute("aria-pressed", "true");
    const selectedCue = await cue(system);

    // The state cue and keyboard-focus cue are independent: tabbing onto the
    // selected option must still add the browser's own focus outline.
    await options.nth(1).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(system).toBeFocused();
    expect(await paintedIn(system, "outline-style")).not.toBe("none");

    const rest = await treatment(untouched);
    await untouched.hover();
    const hover = await treatment(untouched);
    await matching.click();

    await expect(matching).toHaveAttribute("aria-pressed", "true");
    expect(await cue(matching)).toBe(selectedCue);
    expect(await paintedIn(system, "border-top-color")).not.toBe(selectedCue);
    expect(await boxes()).toEqual(before);
    expect(await treatment(untouched)).toEqual(rest);
    await untouched.hover();
    expect(await treatment(untouched)).toEqual(hover);
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`presence selection and keyboard focus stay distinct — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openApp(browser, scheme);
    await page.locator(".ub-user-card").click();
    const panel = page.locator("[data-slot=popover-content]");
    await expect(panel).toBeVisible();
    const swatches = panel
      .getByRole("group", { name: "Presence colour" })
      .getByRole("button");
    await expect(swatches).toHaveCount(8);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    const boxes = (): Promise<Array<[number, number, number, number]>> =>
      swatches.evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return [box.x, box.y, box.width, box.height];
        }),
      );
    const focusCue = (swatch: Locator): Promise<string[]> =>
      swatch.evaluate((element) => {
        const style = getComputedStyle(element);
        return [
          style.outlineStyle,
          style.outlineWidth,
          style.outlineColor,
          style.outlineOffset,
        ];
      });

    const before = await boxes();
    for (let index = 0; index < 8; index += 1) {
      const selected = swatches.nth(index);
      await selected.click();
      await expect(selected).toHaveAttribute("aria-pressed", "true");
      const selectionCue = await paintedIn(selected, "border-top-color");
      expect(
        contrast(selectionCue, await paintedIn(selected, "background-color")),
      ).toBeGreaterThanOrEqual(3);
    }

    const selected = swatches.first();
    const neighbour = swatches.nth(1);
    await selected.click();
    const selectionCue = await paintedIn(selected, "border-top-color");
    await neighbour.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(selected).toBeFocused();
    const selectedFocus = await focusCue(selected);
    expect(selectedFocus[0]).not.toBe("none");

    await page.keyboard.press("Tab");
    await expect(neighbour).toBeFocused();
    expect(await focusCue(neighbour)).toEqual(selectedFocus);
    expect(await paintedIn(selected, "outline-style")).toBe("none");
    expect(await paintedIn(selected, "border-top-color")).toBe(selectionCue);
    expect(await boxes()).toEqual(before);
  });
}

test("workspace settings is an address-selected, inert sidebar drill-in", async ({
  browser,
}) => {
  const page = await openApp(browser, "light");
  const workspacePath = `/${harness().workspace}`;
  const settingsPath = `${workspacePath}/settings`;
  const documents = page.locator(".ub-document-sidebar");
  const settings = page.locator(".ub-settings-sidebar");

  const settingsEntry = page.getByRole("button", {
    name: "Workspace settings",
    exact: true,
  });
  await settingsEntry.click();
  await expect(page).toHaveURL(new URL(settingsPath, harness().appUrl).href);
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  const back = settings.getByRole("button", { name: /^Back to / });
  await expect(back).toBeVisible();
  await expect(back).toBeFocused();
  expect(await paintedIn(settings, "transition-duration")).toContain("0.18s");
  expect(
    await documents.evaluate((pane) => ({
      inert: (pane as HTMLElement).inert,
      hidden: pane.getAttribute("aria-hidden"),
      pointer: getComputedStyle(pane).pointerEvents,
    })),
  ).toEqual({ inert: true, hidden: "true", pointer: "none" });

  // The route is the selection: browser Back restores the document sidebar.
  await page.goBack();
  await expect(page).toHaveURL(new URL(workspacePath, harness().appUrl).href);
  await expect(page.getByRole("button", { name: "+ new doc" })).toBeVisible();
  await expect(settingsEntry).toBeFocused();

  // Portalled controls sit outside the pane's inert subtree. Browser Forward
  // changes the address without clicking underneath them, and the mode change
  // must still take each outgoing surface and its focus away.
  await page.locator(".ub-workspace").click();
  const workspaceMenu = page.locator("[data-slot=dropdown-menu-content]");
  await expect(workspaceMenu).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new URL(settingsPath, harness().appUrl).href);
  await expect(workspaceMenu).toBeHidden();
  await expect(back).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(new URL(workspacePath, harness().appUrl).href);
  await expect(settingsEntry).toBeFocused();

  await page.locator(".ub-user-card").click();
  const userPanel = page.locator("[data-slot=popover-content]");
  await expect(userPanel).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new URL(settingsPath, harness().appUrl).href);
  await expect(userPanel).toBeHidden();
  await expect(back).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(new URL(workspacePath, harness().appUrl).href);
  await expect(settingsEntry).toBeFocused();

  // The switcher's existing entry is the second front door, and Back in the
  // settings pane always targets the workspace list rather than a remembered doc.
  await page.locator(".ub-workspace").click();
  await page.getByRole("menuitem", { name: "Workspace settings" }).click();
  await expect(page).toHaveURL(new URL(settingsPath, harness().appUrl).href);
  await settings.getByRole("button", { name: /^Back to / }).click();
  await expect(page).toHaveURL(new URL(workspacePath, harness().appUrl).href);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  expect(await paintedIn(settings, "transition-duration")).toBe("0s");
});

/**
 * A hover ground is an offer, and a disabled control has nothing to offer
 * (#529). Beside the loop above, because it asks the same kind of question of
 * the same column in the same two appearances.
 *
 * The sidebar's row controls share one hover rule, and two of them can be
 * unavailable: `+ new doc`, which creates into the directory room and has none
 * at an address naming no workspace this client can use, and Navigation's
 * placeholder destinations, which are `aria-disabled` rather than `disabled`
 * because they stay in the tab order (#483). Only a browser can be asked —
 * `:hover` is a state nothing but a pointer sets, and the ground it would paint
 * is a `light-dark()` token — so the enabled control beside them takes the same
 * gesture, which is what makes "unchanged" mean the rule missed it rather than
 * that the measurement cannot see a change.
 */
for (const scheme of ["light", "dark"] as const) {
  test(`a disabled sidebar control keeps its ground under the pointer — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openApp(browser, scheme, "not-a-workspace");
    const create = page.getByRole("button", { name: "new doc unavailable" });
    await expect(create).toBeDisabled();

    const disabled = await paintedIn(create, "background-color");
    await create.hover();
    expect(await paintedIn(create, "background-color")).toBe(disabled);

    const soon = page.getByRole("button", { name: "Dashboard" });
    await expect(soon).toHaveAttribute("aria-disabled", "true");
    const placeholder = await paintedIn(soon, "background-color");
    await soon.hover();
    expect(await paintedIn(soon, "background-color")).toBe(placeholder);
    // Muted, in whichever appearance this run is in: an unavailable row reads
    // a step back from the live one it sits beside.
    const mutedInk = oklab(await paintedIn(soon, "color"));
    const liveInk = oklab(await paintedIn(page.locator(".ub-all-open-entry"), "color"));
    expect(
      [mutedInk.L, mutedInk.a, mutedInk.b, mutedInk.alpha < liveInk.alpha],
      "a placeholder reuses the live row's base ink at lower alpha",
    ).toEqual([liveInk.L, liveInk.a, liveInk.b, true]);

    const allDocs = page.locator(".ub-all-open-entry");
    const ground = await paintedIn(allDocs, "background-color");
    await allDocs.hover();
    expect(await paintedIn(allDocs, "background-color")).not.toBe(ground);
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
  expect(
    (await painted(page, "body", "background-image")).match(/oklch\([^)]*\)/g),
    "#617's owner-reviewed near and far page-ground stops",
  ).toEqual(["oklch(0.184 0.022 65)", "oklch(0.094 0.011 65)"]);
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

test("the open document owns the remaining chrome and its one sync-details handle", async ({
  browser,
}) => {
  const page = await openApp(browser, "light");
  const removed = page.locator(".ub-header, .ub-brand, .ub-crumb, .ub-me");
  await expect(removed).toHaveCount(0);
  await expect(page.locator(".ub-sync-toggle")).toHaveCount(0);

  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ub-paragraph")).toBeVisible();
  await expect(page.locator(".ub-title")).toBeVisible();
  await expect(page.locator(".ub-doc-meta")).toBeVisible();
  await expect(page.locator(".ub-doc-ids")).toBeVisible();
  await expect(page.locator(".ub-copy-link")).toBeVisible();
  await expect(page.getByRole("button", { name: "Document actions" })).toBeVisible();
  await expect(page.locator(".ub-threads-toggle")).toHaveCount(0);

  const sync = page.locator(".ub-status .ub-sync-toggle");
  await expect(sync).toHaveCount(1);
  const path = new URL(page.url()).pathname;
  await sync.click();
  await expect(
    page.getByRole("complementary", { name: "Sync and presence" }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(path);
  await page.keyboard.press("Escape");
  await expect(sync).toBeFocused();
  expect(new URL(page.url()).pathname).toBe(path);
});

test("the document and comments rail stay left-anchored as the viewport changes", async ({
  browser,
}) => {
  const page = await openApp(browser, "light");
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ub-paragraph")).toBeVisible();

  type Layout = {
    body: { left: number; right: number };
    sidebar: { right: number } | null;
    pane: { left: number; right: number; width: number };
    column: { left: number; right: number; width: number };
    editor: { left: number };
    rail: { left: number; right: number } | null;
    paneClientWidth: number;
    paneScrollWidth: number;
    bodyClientWidth: number;
    bodyScrollWidth: number;
  };
  const layout = (): Promise<Layout> =>
    page.evaluate(() => {
      const body = document.querySelector<HTMLElement>(".ub-body");
      const sidebar = document.querySelector<HTMLElement>(".ub-list");
      const pane = document.querySelector<HTMLElement>(".ub-document-pane");
      const rail = document.querySelector<HTMLElement>(".ub-rail");
      if (body === null || pane === null) {
        throw new Error("e2e: document composition is incomplete");
      }
      const column = pane.querySelector<HTMLElement>(":scope > .ub-column");
      const editor = pane.querySelector<HTMLElement>(".ub-editor");
      if (column === null || editor === null) {
        throw new Error("e2e: document composition is incomplete");
      }
      const bodyBox = body.getBoundingClientRect();
      const paneBox = pane.getBoundingClientRect();
      const columnBox = column.getBoundingClientRect();
      const editorBox = editor.getBoundingClientRect();
      const sidebarBox = sidebar?.getBoundingClientRect() ?? null;
      const railBox =
        rail === null || getComputedStyle(rail).display === "none"
          ? null
          : rail.getBoundingClientRect();
      return {
        body: { left: bodyBox.left, right: bodyBox.right },
        sidebar: sidebarBox === null ? null : { right: sidebarBox.right },
        pane: { left: paneBox.left, right: paneBox.right, width: paneBox.width },
        column: {
          left: columnBox.left,
          right: columnBox.right,
          width: columnBox.width,
        },
        editor: { left: editorBox.left },
        rail:
          railBox === null ? null : { left: railBox.left, right: railBox.right },
        paneClientWidth: pane.clientWidth,
        paneScrollWidth: pane.scrollWidth,
        bodyClientWidth: body.clientWidth,
        bodyScrollWidth: body.scrollWidth,
      };
    });
  const atWidths = async (widths: number[]): Promise<Layout[]> => {
    const readings: Layout[] = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      readings.push(await layout());
    }
    return readings;
  };
  const firstTwo = (readings: Layout[]): [Layout, Layout] => {
    const [first, second] = readings;
    if (first === undefined || second === undefined) {
      throw new Error("e2e: two viewport readings required");
    }
    return [first, second];
  };
  const shownRail = (reading: Layout): { left: number; right: number } => {
    if (reading.rail === null) throw new Error("e2e: comments rail is hidden");
    return reading.rail;
  };
  const expectFixedOrigins = (
    readings: Layout[],
    edge: (reading: Layout) => number,
  ): void => {
    const [first, second] = firstTwo(readings);
    expect(first.column.left - edge(first)).toBeCloseTo(
      second.column.left - edge(second),
      1,
    );
    expect(first.column.width).toBeCloseTo(second.column.width, 1);
  };

  // With no heading or thread the rail is genuinely absent, but the document
  // origin is already fixed and does not spend a wider viewport on centring.
  const expandedEmpty = await atWidths([1400, 1600]);
  expect(expandedEmpty.every((reading) => reading.rail === null)).toBe(true);
  expectFixedOrigins(expandedEmpty, (reading) => reading.sidebar?.right ?? 0);

  await page.getByRole("button", { name: "Hide document list" }).click();
  await expect(page.locator(".ub-list")).toHaveCount(0);
  const collapsedEmpty = await atWidths([1400, 1600]);
  expectFixedOrigins(collapsedEmpty, (reading) => reading.body.left);

  await page.getByRole("button", { name: "Show document list" }).click();
  await expect(page.locator(".ub-list")).toBeVisible();
  await page.setViewportSize({ width: 1400, height: 800 });
  await placeCaret(page);
  await page.keyboard.type("annotate me", { delay: 15 });
  await page.keyboard.press("Shift+Home");
  await page.locator(".ub-composer-open").click();
  await page.keyboard.type("keep this beside the prose", { delay: 15 });
  await page.keyboard.press("Enter");
  await expect(page.locator(".ub-thread")).toBeVisible();

  const expandedPopulated = await atWidths([1400, 1600]);
  expectFixedOrigins(expandedPopulated, (reading) => reading.sidebar?.right ?? 0);
  for (let index = 0; index < expandedPopulated.length; index += 1) {
    const reading = expandedPopulated[index];
    const empty = expandedEmpty[index];
    if (reading === undefined || empty === undefined) {
      throw new Error("e2e: viewport readings do not line up");
    }
    expect(reading.column.left).toBeCloseTo(empty.column.left, 1);
    expect(reading.rail).not.toBeNull();
  }
  const [firstPopulated, secondPopulated] = firstTwo(expandedPopulated);
  const firstGap = shownRail(firstPopulated).left - firstPopulated.column.right;
  const secondGap = shownRail(secondPopulated).left - secondPopulated.column.right;
  expect(firstGap).toBeGreaterThan(0);
  expect(firstGap).toBeCloseTo(secondGap, 1);
  const firstTail = firstPopulated.body.right - shownRail(firstPopulated).right;
  const secondTail = secondPopulated.body.right - shownRail(secondPopulated).right;
  expect(secondTail - firstTail).toBeCloseTo(200, 1);

  const highlight = page.locator("[data-comment-thread]").first();
  await highlight.click();
  await expect(page.locator('.ub-thread[aria-current="true"]')).toBeVisible();

  await page.getByRole("button", { name: "Hide document list" }).click();
  const collapsedPopulated = await atWidths([1400, 1600]);
  expectFixedOrigins(collapsedPopulated, (reading) => reading.body.left);
  for (let index = 0; index < collapsedPopulated.length; index += 1) {
    const reading = collapsedPopulated[index];
    const empty = collapsedEmpty[index];
    if (reading === undefined || empty === undefined) {
      throw new Error("e2e: viewport readings do not line up");
    }
    expect(reading.column.left).toBeCloseTo(empty.column.left, 1);
  }

  // At the existing breakpoint the same pane shrinks without horizontal
  // overflow. The drawer overlays it, and a keyboard activation still opens
  // and targets the right card without changing document geometry.
  await page.getByRole("button", { name: "Show document list" }).click();
  await page.setViewportSize({ width: 768, height: 720 });
  await page.keyboard.press("Escape");
  await expect(page.locator(".ub-rail")).not.toBeVisible();
  const narrow = await layout();
  expect(narrow.column.width).toBeLessThan(firstPopulated.column.width);
  expect(narrow.column.left).toBeGreaterThanOrEqual(narrow.pane.left);
  expect(narrow.column.right).toBeLessThanOrEqual(narrow.pane.right);
  expect(narrow.editor.left - narrow.column.left).toBeGreaterThan(20);
  expect(narrow.paneScrollWidth).toBe(narrow.paneClientWidth);
  expect(narrow.bodyScrollWidth).toBe(narrow.bodyClientWidth);

  await highlight.focus();
  await page.keyboard.press("Enter");
  const selected = page.locator('.ub-thread[aria-current="true"]');
  await expect(page.locator(".ub-rail")).toBeVisible();
  await expect(selected).toBeFocused();
  const withDrawer = await layout();
  expect(withDrawer.column.left).toBeCloseTo(narrow.column.left, 1);
  expect(withDrawer.column.right).toBeCloseTo(narrow.column.right, 1);
  expect(shownRail(withDrawer).right).toBeCloseTo(withDrawer.body.right, 1);
});

test("document actions stay reachable, close with the route, and archive into Restore", async ({
  browser,
}) => {
  const page = await openApp(browser, "light", "", true);
  await page.getByRole("button", { name: "+ new doc" }).click();
  await page.locator(".ub-title").fill("Lifecycle notes");
  await page.setViewportSize({ width: 360, height: 720 });
  await page.getByRole("button", { name: "Hide document list" }).click();
  await expect(page.locator(".ub-list")).toHaveCount(0);

  const trigger = page.getByRole("button", { name: "Document actions" });
  const uuid = page.locator(".ub-copy-identity .ub-copy-link");
  const title = page.locator(".ub-title");
  for (const [name, control] of [
    ["title", title],
    ["uuid", uuid],
    ["actions", trigger],
  ] as const) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    if (box === null) throw new Error("e2e: narrow document chrome has no box");
    expect(box.x, name).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, name).toBeLessThanOrEqual(360);
  }
  await expect(uuid).toHaveText(/^uuid [0-9a-f]{8}/);
  await expect(page.locator(".ub-doc-meta")).not.toContainText("Copy link");
  expect(
    await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>(".ub-body");
      const pane = document.querySelector<HTMLElement>(".ub-pane");
      if (body === null || pane === null) throw new Error("e2e: no document pane");
      return {
        body: [body.clientWidth, body.scrollWidth],
        pane: [pane.clientWidth, pane.scrollWidth],
      };
    }),
  ).toEqual({ body: [360, 360], pane: [360, 360] });

  await uuid.click();
  await expect(page.locator(".ub-copied")).toHaveText("URL copied to clipboard");

  await trigger.click();
  await page.getByRole("menuitem", { name: "Pin to sidebar" }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(
    page.getByRole("menuitem", { name: "Unpin from sidebar" }),
  ).toBeVisible();

  // The menu is portalled outside the routed pane. The settings route replaces
  // that pane entirely, so the portal must still leave with its document.
  await page.evaluate(() => {
    history.pushState(
      null,
      "",
      `${location.pathname.split("/").slice(0, 2).join("/")}/settings`,
    );
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.locator("[data-slot=dropdown-menu-content]")).toHaveCount(0);
  await page.goBack();
  await expect(trigger).toBeVisible();

  await trigger.click();
  await page.getByRole("menuitem", { name: "Archive document" }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("Archive Lifecycle notes?");
  await expect(confirmation).toContainText("read-only");
  await expect(confirmation).toHaveAccessibleName("Archive Lifecycle notes?");
  await expect(confirmation).toHaveAccessibleDescription(/content is preserved/);
  await expect(page.locator("#root")).toHaveAttribute("aria-hidden", "true");
  const cancel = confirmation.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();

  // Scripted focus stands in for the programmatic/assistive path that escaped
  // the hand-written trap. Radix returns it to the last in-dialog target, while
  // the background remains absent from the accessibility tree.
  await page.locator(".ub-title").evaluate((title) =>
    (title as HTMLInputElement).focus(),
  );
  await expect(cancel).toBeFocused();
  await expect(page.getByRole("textbox")).toHaveCount(0);

  await page.keyboard.press("Tab");
  await expect(
    confirmation.getByRole("button", { name: "Archive document" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // Outside pointer dismissal is a cancelled confirmation and restores the
  // menu trigger through the primitive's own trigger/content relationship.
  await trigger.click();
  await page.getByRole("menuitem", { name: "Archive document" }).click();
  await expect(confirmation).toHaveCount(1);
  await page.locator("[data-slot=dialog-overlay]").click({ position: { x: 4, y: 4 } });
  await expect(confirmation).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // A touch pointer takes the same outside-dismissal path. The dialog layer's
  // first passive effect queues the zero-delay timer that arms its document
  // pointerdown listener. The following timer is scheduled over a later CDP
  // round trip, behind that arming timer. This ordering, not an elapsed
  // interval, makes the single touch tap deterministic.
  await trigger.click();
  await page.getByRole("menuitem", { name: "Archive document" }).click();
  await expect(confirmation).toHaveCount(1);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await page.touchscreen.tap(4, 4);
  await expect(confirmation).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByRole("menuitem", { name: "Archive document" }).click();
  await page.getByRole("button", { name: "Archive document" }).click();
  const restore = page.getByRole("button", { name: "Restore" });
  await expect(restore).toBeVisible();
  await expect(restore).toBeFocused();
  await expect(trigger).toHaveCount(0);
  await expect(page.locator(".ub-editor .ProseMirror")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await page.getByRole("button", { name: "Show document list" }).click();
  await expect(page.getByRole("button", { name: /Lifecycle notes.*archived/ })).toBeVisible();
});

test("MCP connections counts a connected agent session, and stops when it goes", async ({
  browser,
}) => {
  const page = await openApp(browser, "dark");
  const connections = page.locator(".ub-panel-fact", { hasText: "MCP connections" });

  await page.locator(".ub-user-card").click();
  await expect(connections).toContainText("0");

  // An agent, as far as the hub and the awareness map are concerned: a client
  // that publishes a user and says positively that it is an agent (#494). That
  // pair is exactly what the MCP server's replicas publish, in one write
  // (`mcp-server/src/replica.ts`), and the marker is what the count reads —
  // omitting it makes this session a person, which is the whole point of the
  // positive test replacing the old "not this app, therefore an agent" one.
  const doc = new Y.Doc();
  const agent = new HocuspocusProvider({
    url: harness().hubUrl,
    name: directoryRoom(harness().workspaceUuid),
    document: doc,
    // Wrapped like every real client — the hub reads the protocol version out
    // of the auth message before it reads the token.
    token: async () =>
      wrapToken(
        await mintToken(await importRootSecret(harness().authSecret), {
          typ: "room",
          sub: `agent-${randomUUID()}`,
          workspace: harness().workspaceUuid,
          scope: "read-write",
          kid: null,
          lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
        }),
      ),
  });
  agent.setAwarenessField("user", { name: "an agent", color: "#7b5ec7" });
  agent.setAwarenessField("client", "agent");

  try {
    await expect(connections).toContainText("1");
  } finally {
    agent.destroy();
  }
  await expect(connections).toContainText("0");
});

test("the document collaborator cluster stays compact and jumps once without moving selection", async ({
  browser,
}) => {
  const page = await openApp(browser, "light");
  // At this breakpoint the sidebar overlays the full-width document pane,
  // exercising the compact cluster in the narrow shell.
  await page.setViewportSize({ width: 720, height: 640 });
  await page.getByRole("button", { name: "+ new doc" }).click();
  await page.locator(".ub-title").fill("Live collaborators");
  const firstBlock = page.locator(".ub-editor .ProseMirror > *").first();
  await firstBlock.click();
  await page.keyboard.type("start");
  const titleBefore = await page.locator(".ub-title").boundingBox();
  const editorBefore = await page.locator(".ub-editor").boundingBox();
  const status = page.locator(".ub-status");
  const rowBefore = (await status.boundingBox())?.height;

  const uuid = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  if (uuid === undefined) throw new Error("e2e: the document route has no uuid");
  const room = `${harness().workspaceUuid}/${uuid}`;
  const rootSecret = await importRootSecret(harness().authSecret);
  const providers: HocuspocusProvider[] = [];
  const documents: Y.Doc[] = [];

  const openPeer = async (
    name: string,
    kind: "agent" | "human",
    color: string,
  ): Promise<{ provider: HocuspocusProvider; doc: Y.Doc }> => {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: harness().hubUrl,
      name: room,
      document: doc,
      token: async () =>
        wrapToken(
          await mintToken(rootSecret, {
            typ: "room",
            sub: `${kind}-${randomUUID()}`,
            workspace: harness().workspaceUuid,
            scope: "read-write",
            kid: null,
            lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
          }),
        ),
    });
    providers.push(provider);
    documents.push(doc);
    await new Promise<void>((resolve) => provider.on("synced", resolve));
    provider.setAwarenessField("user", { name, color });
    provider.setAwarenessField("client", kind === "agent" ? "agent" : "web");
    if (kind === "agent") provider.setAwarenessField("session", `agent-${uuid}`);
    return { provider, doc };
  };

  const caretAt = (doc: Y.Doc, index: number): { anchor: unknown; head: unknown } => {
    const block = getBlocksFragment(doc).get(index);
    if (!(block instanceof Y.XmlElement) || !(block.firstChild instanceof Y.XmlText)) {
      throw new Error(`e2e: block ${index + 1} has no text`);
    }
    const anchor = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(block.firstChild, 1),
    );
    return { anchor, head: anchor };
  };

  try {
    const ada = await openPeer("Ada", "agent", "#0c853d");
    for (let index = 1; index <= 28; index += 1) {
      appendBlock(ada.doc, {
        type: "paragraph",
        text: `collaboration block ${index}`,
      });
    }
    await expect(page.locator(".ub-editor .ProseMirror > *")).toHaveCount(29);

    const bert = await openPeer("Bert", "agent", "#0675c9");
    const cleo = await openPeer("Cleo", "agent", "#cb26b4");
    const dora = await openPeer("Dora", "agent", "#7b5ec7");
    const eli = await openPeer("Eli", "human", "#ac6008");
    for (const peer of [ada, bert, cleo, dora]) {
      peer.provider.setAwarenessField("cursor", caretAt(peer.doc, 28));
    }
    // Eli deliberately publishes no cursor: identity without a location is
    // still a useful presence fact and must not invent a jump.
    eli.provider.setAwarenessField("cursor", null);

    const visible = page.locator(".ub-peers > .ub-peer-control[data-peer-id]");
    const more = page.locator(".ub-peer-more");
    await expect(visible).toHaveCount(3);
    await expect(more).toHaveText("+2");
    await expect(more).toBeInViewport();
    // Four of the five peers are agents, so sorted client ids still guarantee
    // an agent before the last visible position: the overlap is real here.
    const visibleAgent = visible
      .filter({ has: page.locator(".ub-avatar-agent-badge") })
      .first();
    await expect(visibleAgent.locator(".ub-avatar-agent-badge")).toHaveText("🤖");
    const agentBadgePaint = await visibleAgent.evaluate((control) => {
        const badge = control.querySelector(".ub-avatar-agent-badge");
        if (!(badge instanceof HTMLElement)) return { owned: false };
        const box = badge.getBoundingClientRect();
        const top = document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        );
        return {
          owned: top !== null && control.contains(top),
          top: top?.className ?? top?.nodeName ?? null,
          controlZ: getComputedStyle(control).zIndex,
        };
      });
    expect(agentBadgePaint.owned, JSON.stringify(agentBadgePaint)).toBe(true);
    const titleAfter = await page.locator(".ub-title").boundingBox();
    const editorAfter = await page.locator(".ub-editor").boundingBox();
    expect(titleAfter?.x).toBe(titleBefore?.x);
    expect(titleAfter?.width).toBe(titleBefore?.width);
    expect(editorAfter?.x).toBe(editorBefore?.x);
    expect(editorAfter?.width).toBe(editorBefore?.width);
    // The row reserves its circle's height while it is empty, so the cap and
    // the overflow control beside it leave it exactly as tall (#832). The
    // prose position that follows from it is proven at the transition that
    // would move it, in `collab.spec.ts`.
    expect((await status.boundingBox())?.height).toBe(rowBefore);

    const circles = await visible.evaluateAll((controls) =>
      controls.map((control) => {
        const avatar = control.querySelector<HTMLElement>(".ub-avatar");
        const box = control.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          left: box.left,
          right: box.right,
          avatarWidth: avatar?.getBoundingClientRect().width,
        };
      }),
    );
    expect(circles.map(({ width, height, avatarWidth }) => [width, height, avatarWidth]))
      .toEqual([
        [28, 28, 28],
        [28, 28, 28],
        [28, 28, 28],
      ]);
    const [firstCircle, secondCircle] = circles;
    if (firstCircle === undefined || secondCircle === undefined) {
      throw new Error("e2e: the collaborator cluster did not draw three circles");
    }
    expect(secondCircle.left).toBeLessThan(firstCircle.right);
    await visible.first().focus();
    await expect(visible.first().locator(".ub-peer-tooltip")).toHaveCSS(
      "opacity",
      "1",
    );
    await expect(visible.first()).toHaveCSS("outline-width", "2px");

    const orderBefore = await visible.evaluateAll((controls) =>
      controls.map((control) => (control as HTMLElement).dataset.peerId),
    );
    dora.provider.setAwarenessField("user", { name: "Delta", color: "#e30c4e" });
    dora.provider.setAwarenessField("client", "web");
    dora.provider.setAwarenessField("cursor", caretAt(dora.doc, 0));
    await more.focus();
    await page.keyboard.press("Enter");
    const overflow = page.getByRole("dialog", { name: "More active collaborators" });
    await expect(overflow).toBeVisible();
    await expect(overflow.getByRole("button").first()).toBeFocused();
    expect(await more.getAttribute("aria-controls")).toBe(await overflow.getAttribute("id"));
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const deltaPerson = page.getByRole("button", {
      name: /^Delta · person · .*editing block 1$/,
    });
    await expect(deltaPerson).toBeVisible();
    await expect(deltaPerson.locator(".ub-avatar-agent-badge")).toHaveCount(0);
    dora.provider.setAwarenessField("client", "agent");
    dora.provider.setAwarenessField("cursor", caretAt(dora.doc, 28));
    const deltaAgent = page.getByRole("button", {
      name: /^Delta · agent · .*editing block 29$/,
    });
    await expect(deltaAgent).toBeVisible();
    await expect(deltaAgent.locator(".ub-avatar-agent-badge")).toHaveText("🤖");
    expect(await visible.evaluateAll((controls) =>
      controls.map((control) => (control as HTMLElement).dataset.peerId),
    )).toEqual(orderBefore);

    const deltaCursor = page.locator(".ProseMirror-yjs-cursor > div", {
      hasText: "Delta",
    });
    await expect(deltaCursor).toBeVisible();
    expect(await paintedIn(deltaAgent.locator(".ub-avatar"), "border-color")).toBe(
      await paintedIn(deltaCursor, "background-color"),
    );
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    await more.click();
    await expect(overflow).toBeVisible();
    await page.locator(".ub-title").click();
    await expect(overflow).toHaveCount(0);
    await expect(page.locator(".ub-title")).toBeFocused();
    const pane = page.locator(".ub-pane");
    const waitForPaneScrollToSettle = async (): Promise<void> => {
      let previousScrollTop: number | null = null;
      let stableScrollReads = 0;
      await expect
        .poll(async () => {
          const scrollTop = await pane.evaluate((element) => element.scrollTop);
          stableScrollReads = scrollTop === previousScrollTop ? stableScrollReads + 1 : 0;
          previousScrollTop = scrollTop;
          return stableScrollReads;
        }, { intervals: [100, 100, 100, 100, 100, 100], timeout: 2_000 })
        .toBeGreaterThanOrEqual(5);
    };
    // The title's native focus scroll can outlive the focus transfer. Let the
    // pane settle before resetting it for the independent presence checks.
    await waitForPaneScrollToSettle();

    await page.evaluate(() => {
      const first = document.querySelector(".ub-editor .ProseMirror > *")?.firstChild;
      if (first === undefined || first === null) throw new Error("no first block text");
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(first, 5);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const original = Element.prototype.scrollIntoView;
      (window as unknown as { peerScrollCalls: number }).peerScrollCalls = 0;
      Element.prototype.scrollIntoView = function scrollIntoView(options) {
        if (this.closest(".ub-editor") !== null) {
          (window as unknown as { peerScrollCalls: number }).peerScrollCalls += 1;
        }
        original.call(this, options);
      };
    });
    await pane.evaluate((element) => {
      element.scrollTop = 0;
    });

    const visibleJump = page.locator(
      '.ub-peers > .ub-peer-control[aria-label*="editing block 29"]',
    ).first();
    await visibleJump.click();
    await expect.poll(() => pane.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("start");
    expect(
      await page.evaluate(
        () => (window as unknown as { peerScrollCalls: number }).peerScrollCalls,
      ),
    ).toBe(1);
    await waitForPaneScrollToSettle();

    await pane.evaluate((element) => {
      element.scrollTop = 0;
    });
    await more.focus();
    await page.keyboard.press("Enter");
    // Keyboard activation in the overflow reaches the same current stable
    // block once and leaves the local range untouched.
    const jumpRow = page.locator(
      '.ub-peer-overflow-row[aria-label*="editing block 29"]',
    ).first();
    await expect(jumpRow).toBeVisible();
    await jumpRow.focus();
    await expect(jumpRow).toHaveCSS("outline-width", "2px");
    await page.keyboard.press("Enter");
    await expect.poll(() => pane.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("start");
    expect(
      await page.evaluate(
        () => (window as unknown as { peerScrollCalls: number }).peerScrollCalls,
      ),
    ).toBe(2);
    await expect(more).toBeFocused();
    await waitForPaneScrollToSettle();

    await pane.evaluate((element) => {
      element.scrollTop = 0;
    });
    await more.click();
    const noLocation = page.getByRole("button", { name: "Eli · person" });
    await expect(noLocation).toBeVisible();
    await noLocation.click();
    await waitForPaneScrollToSettle();
    expect(await pane.evaluate((element) => element.scrollTop)).toBe(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { peerScrollCalls: number }).peerScrollCalls,
      ),
    ).toBe(2);

    eli.provider.destroy();
    await expect(more).toHaveText("+1");
  } finally {
    for (const provider of providers) provider.destroy();
    for (const doc of documents) doc.destroy();
  }
});

/**
 * A painted colour in OKLab. Every token measured below is written `oklch()`
 * and Chromium's computed value keeps that space, so this is polar-to-
 * rectangular arithmetic and nothing is quantised on the way. A serialization
 * that is not `oklch()` throws rather than guesses: a wrong number here would
 * look like a passing measurement.
 */
function oklab(painted: string): {
  L: number;
  a: number;
  b: number;
  chroma: number;
  alpha: number;
} {
  // `none` is how an achromatic colour reports the hue it does not have, and
  // the alpha half only appears on the tokens that carry one (#515).
  const parts =
    /^oklch\((\d*\.?\d+) (\d*\.?\d+) (\d*\.?\d+|none)(?: \/ (\d*\.?\d+))?\)$/.exec(
      painted.trim(),
    );
  const [, rawL, rawC, rawH, rawA] = parts ?? [];
  if (rawL === undefined || rawC === undefined || rawH === undefined) {
    throw new Error(`not an oklch colour: ${painted}`);
  }
  const chroma = Number(rawC);
  const radians = ((rawH === "none" ? 0 : Number(rawH)) * Math.PI) / 180;
  return {
    L: Number(rawL),
    a: chroma * Math.cos(radians),
    b: chroma * Math.sin(radians),
    chroma,
    alpha: rawA === undefined ? 1 : Number(rawA),
  };
}

/**
 * The channels of a legacy serialization, or null where the colour is not one.
 *
 * The column paints one ground that is not a token: the user tile's fill is a
 * colour from the awareness palette, which is `#rrggbb` literals because
 * y-prosemirror accepts nothing else (#482, src/collab/identity.ts). Chromium
 * reports it as `rgb(r, g, b)`, already in the space `srgb` returns. Grounds
 * only — an *ink* still has to be a token, so a legacy one reaches `oklab`
 * below and throws rather than being classified by a chroma nobody computed.
 */
function legacySrgb(painted: string): [number, number, number] | null {
  const parts = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(painted.trim());
  if (parts === null) return null;
  const [r, g, b] = parts.slice(1).map((channel) => Number(channel) / 255);
  return [r ?? 0, g ?? 0, b ?? 0];
}

/**
 * The sRGB a browser paints for one of those colours, so an ink with an alpha
 * can be composited onto its ground and read as a contrast ratio (#515). The
 * matrices are the OKLab specification's; the clamp is the gamut Chromium
 * paints into. Nothing here is a second palette — every input is a value read
 * off a rendered element.
 */
function srgb(painted: string): [number, number, number] {
  const { L, a, b } = oklab(painted);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const encoded = linear.map((channel) => {
    const clamped = Math.min(1, Math.max(0, channel));
    return clamped <= 0.0031308
      ? 12.92 * clamped
      : 1.055 * clamped ** (1 / 2.4) - 0.055;
  });
  return [encoded[0] ?? 0, encoded[1] ?? 0, encoded[2] ?? 0];
}

/** WCAG's ratio between an ink — alpha composited where it has one — and its ground. */
function contrast(ink: string, ground: string): number {
  const under = legacySrgb(ground) ?? srgb(ground);
  const alpha = oklab(ink).alpha;
  const over = srgb(ink).map((channel, index) => {
    const beneath = under[index] ?? 0;
    return channel * alpha + beneath * (1 - alpha);
  });
  const luminance = (colour: number[]): number => {
    const [r, g, b] = colour.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  };
  const one = luminance(over) + 0.05;
  const two = luminance(under) + 0.05;
  return one > two ? one / two : two / one;
}

/** How far a fill sits from the ground it is painted on. */
function separation(fill: string, ground: string): number {
  const one = oklab(fill);
  const two = oklab(ground);
  return Math.hypot(one.L - two.L, one.a - two.a, one.b - two.b);
}

/**
 * What a highlight on `--card` has to clear, per appearance (#516).
 *
 * Dark is the contract's own number: 0.064 is what all three of these pairs
 * measured before #480 moved dark's greys onto the scheme's warm hue and
 * narrowed them to 0.018. Light never had it — the pairs sat at 0.005, which is
 * no step at all — so what is owed there is only that the step became real;
 * 0.04 is a regression guard far above what it replaced and far below the 0.051
 * `--card-accent` now gives.
 */
const cardHighlightFloor = { light: 0.04, dark: 0.064 } as const;
const focusedOrphanedChipFloor = { light: 0.0403, dark: 0.0602 } as const;

for (const scheme of ["light", "dark"] as const) {
  test(`a card-grounded highlight steps off its ground — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openApp(browser, scheme);
    // Under the rail's 1100px breakpoint, which is the only width where the
    // threads handle is on screen to be measured at all.
    await page.setViewportSize({ width: 1000, height: 800 });

    // The block menu is its own `--card` floating over the prose, and one entry
    // carries the highlight from the moment it opens.
    await page.getByRole("button", { name: "+ new doc" }).click();
    await expect(page.locator(".ub-editor .ub-paragraph")).toBeVisible();
    await placeCaret(page);
    await page.keyboard.type("/", { delay: 15 });
    await expect(page.locator(".ub-blockmenu")).toBeVisible();
    const card = await painted(page, ".ub-blockmenu", "background-color");
    const entry = await paintedIn(
      page.locator(".ub-blockmenu-on"),
      "background-color",
    );
    expect(separation(entry, card)).toBeGreaterThanOrEqual(
      cardHighlightFloor[scheme],
    );
    await page.keyboard.press("Escape");

    // The drawer's handle appears once the document has a thread, so comparing
    // every card-accent consumer below needs a real one.
    await page.keyboard.type("annotate me", { delay: 15 });
    await page.keyboard.press("Shift+Home");

    // A second client on the same document, because a mention chip is offered
    // for a peer publishing awareness and for nobody else — there is no chip to
    // measure in a room with one client in it.
    await openApp(browser, scheme, new URL(page.url()).pathname);

    await page.locator(".ub-composer-open").click();

    // The open composer is its own `--card`, and the two `--secondary` fills on
    // it are the same pair as the three above (#567).
    const composer = await painted(page, ".ub-composer", "background-color");
    const cancel = page.getByRole("button", { name: "Cancel" });
    for (const fill of [cancel, page.locator(".ub-mention").first()]) {
      const ground = await paintedIn(fill, "background-color");
      expect(separation(ground, composer)).toBeGreaterThanOrEqual(
        cardHighlightFloor[scheme],
      );
      // The ground moved under an ink that did not, so the label is measured on
      // the fill it ended up on rather than on the one it was written for.
      const ink = await paintedIn(fill, "color");
      expect(contrast(ink, ground)).toBeGreaterThanOrEqual(4.5);
    }
    // And the submit beside Cancel keeps the emphasis that is not this repair.
    const submit = await paintedIn(
      page.getByRole("button", { name: "Comment", exact: true }),
      "background-color",
    );
    expect(submit).not.toBe(await paintedIn(cancel, "background-color"));

    await page.keyboard.type("a thread", { delay: 15 });
    await page.keyboard.press("Enter");
    const handle = page.locator(".ub-threads-toggle");
    await expect(handle).toBeVisible();
    const drawer = await paintedIn(handle, "background-color");

    // The fourth: the `resolved` chip, which is inside the card button and so
    // sits on the card's own `--card` (#572).
    await handle.click();
    await expect(page.locator(".ub-thread")).toBeVisible();
    await page.getByRole("button", { name: "Resolve" }).click();

    // A card is focused from the moment its thread is created, and a focused
    // card is grounded `--brand-subtle`. The floor is about the resting pair,
    // so this measures the card a reader finds on opening the document.
    await page.reload();
    await expect(page.locator(".ub-workspace")).toBeVisible();
    await handle.click();
    const thread = page.locator(".ub-thread").first();
    const chip = page.locator(".ub-thread .ub-chip");
    await expect(chip).toBeVisible();
    const resting = await paintedIn(thread, "background-color");
    expect(resting).toBe(card);
    const pill = await paintedIn(chip, "background-color");
    expect(separation(pill, resting)).toBeGreaterThanOrEqual(
      cardHighlightFloor[scheme],
    );
    expect(
      contrast(await paintedIn(chip, "color"), pill),
    ).toBeGreaterThanOrEqual(4.5);

    // And it is one answer rather than per-surface copies: the same painted
    // fill wherever the card accent lands.
    expect(entry).toBe(drawer);
    expect(pill).toBe(entry);

    // Remove the whole annotated range so this same thread becomes orphaned,
    // then arrive again the way a reader does: resting first, focused by its
    // own card click second. The focused status fill may change, but it cannot
    // become less distinct than the shared fill already is on `--card`.
    await thread.click();
    await page.getByRole("button", { name: "Reopen" }).click();
    await placeCaret(page);
    await page.keyboard.press("Shift+Home");
    await page.keyboard.press("Backspace");
    await expect(page.locator(".ub-chip-orphaned")).toBeVisible();

    await page.reload();
    await expect(page.locator(".ub-workspace")).toBeVisible();
    await handle.click();
    const orphaned = page.locator(".ub-thread").first();
    const orphanedChip = orphaned.locator(".ub-chip-orphaned");
    await expect(orphanedChip).toBeVisible();

    const restingGround = await paintedIn(orphaned, "background-color");
    const restingFill = await paintedIn(orphanedChip, "background-color");
    expect(
      contrast(await paintedIn(orphanedChip, "color"), restingFill),
    ).toBeGreaterThanOrEqual(4.5);

    await orphaned.click();
    await expect(orphaned).toHaveAttribute("aria-current", "true");
    const focusedGround = await paintedIn(orphaned, "background-color");
    const focusedFill = await paintedIn(orphanedChip, "background-color");
    expect(separation(focusedFill, focusedGround)).toBeGreaterThanOrEqual(
      focusedOrphanedChipFloor[scheme],
    );
    expect(separation(focusedFill, focusedGround)).toBeGreaterThanOrEqual(
      separation(restingFill, restingGround),
    );
    expect(
      contrast(await paintedIn(orphanedChip, "color"), focusedFill),
    ).toBeGreaterThanOrEqual(4.5);
  });
}

/** One colour a surface paints, and the ground it lands on. */
type Reading = {
  where: string;
  kind: "text" | "stroke";
  colour: string;
  ground: string;
};

/**
 * Everything one rendered surface paints, walked rather than listed.
 *
 * A list of selectors is exactly what went stale between #480 and #515: the
 * column took its own surface tokens and its interior kept reading the page's,
 * and no rule was wrong on its own. So this reads the surface the reader sees —
 * every stroke and every text under a root, against the ground each actually
 * sits on — and a rule added later is measured without anybody remembering to
 * add it.
 *
 * A stroke is a border, an outline, or a hairline element painted with a fill
 * of its own; the menu separator is that third shape. A text is an element with
 * words of its own, so an ancestor's ink is not counted once per descendant.
 * Skipped: anything unrendered, and anything inside an inactive control — WCAG
 * 1.4.3 excepts a disabled component's text, and the vendored menu draws its two
 * unavailable items at half opacity.
 */
function surface(page: Page, root: string): Promise<Reading[]> {
  return page.evaluate((selector) => {
    const start = document.querySelector(selector);
    if (start === null) throw new Error(`no surface for ${selector}`);

    const alphaOf = (colour: string): number => {
      const rgba = /^rgba?\(([^)]*)\)$/.exec(colour);
      if (rgba !== null) {
        const parts = (rgba[1] ?? "").split(",");
        return parts.length === 4 ? Number(parts[3]) : 1;
      }
      const slashed = /\/\s*(\d*\.?\d+)\s*\)$/.exec(colour);
      return slashed === null ? 1 : Number(slashed[1]);
    };

    // The nearest ancestor that actually paints something: a transparent
    // element's ink lands on whatever is behind it, which is the ground the
    // reader compares it against.
    const groundOf = (element: Element | null): string => {
      for (let node = element; node !== null; node = node.parentElement) {
        const colour = getComputedStyle(node).backgroundColor;
        if (alphaOf(colour) === 1) return colour;
      }
      throw new Error(`nothing opaque under ${selector}`);
    };

    const name = (element: Element): string =>
      `${selector} ${element.tagName.toLowerCase()}${element.getAttribute("class") === null ? "" : `.${element.getAttribute("class")?.trim().split(/\s+/).join(".")}`}`;

    const readings: Reading[] = [];
    for (const element of [start, ...start.querySelectorAll("*")]) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (
        element.closest("[data-disabled], [aria-disabled='true'], :disabled") !== null
      ) {
        continue;
      }
      const style = getComputedStyle(element);
      const where = name(element);

      // A field's value is text the reader reads, and it is the one text that
      // is not a child node — without this the rename field's ink is walked
      // past, and only its border is measured.
      const field =
        (element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement) &&
        element.value.trim() !== "";
      const speaks =
        field ||
        [...element.childNodes].some(
          (node) =>
            node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
        );
      if (speaks) {
        readings.push({
          where,
          kind: "text",
          colour: style.color,
          ground: groundOf(element),
        });
      }

      for (const side of ["top", "right", "bottom", "left"] as const) {
        const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`));
        const colour = style.getPropertyValue(`border-${side}-color`);
        // A transparent border reserves geometry; it is not a separator (#515).
        if (width > 0 && alphaOf(colour) > 0) {
          readings.push({
            where: `${where} border-${side}`,
            kind: "stroke",
            colour,
            // The background paints under the border, so an element that has
            // one is its own border's ground.
            ground: groundOf(element),
          });
        }
      }

      // `auto` is the browser's own focus ring, in the browser's own colour —
      // a stroke that carries its own meaning, which #515 excludes by name.
      const outline = Number.parseFloat(style.outlineWidth);
      const drawn = style.outlineStyle !== "none" && style.outlineStyle !== "auto";
      if (outline > 0 && drawn && alphaOf(style.outlineColor) > 0) {
        readings.push({
          where: `${where} outline`,
          kind: "stroke",
          colour: style.outlineColor,
          ground: groundOf(element.parentElement),
        });
      }

      const hairline =
        Math.min(box.width, box.height) <= 2 && Math.max(box.width, box.height) > 2;
      if (hairline && alphaOf(style.backgroundColor) > 0) {
        readings.push({
          where: `${where} fill`,
          kind: "stroke",
          colour: style.backgroundColor,
          ground: groundOf(element.parentElement),
        });
      }
    }
    return readings;
  }, root);
}

/**
 * The sidebar's interior is the sidebar's own surface (#515).
 *
 * #480 gave the column four surface tokens and applied one of them to its outer
 * edge; everything inside kept reading the page's `--border` and
 * `--muted-foreground`, which are tuned for the `--card` ground the column no
 * longer has. Two floors follow, and each is read off the column itself rather
 * than written down here, so neither can drift from what the surface is:
 *
 * - **Light — the strokes.** Every separator or outline reaches at least the
 *   OKLab separation the column's own outer edge has (`--sidebar-border` on
 *   `--sidebar`, ΔE 0.040). `--border` gives half of that, 0.021.
 * - **Dark — the strokes.** They are white at a low alpha there, where a
 *   separation between two opaque colours is not the measurement; the composite
 *   is. No interior stroke is weaker against its ground than that same outer
 *   edge.
 * - **Both — the ink.** Every text reaches WCAG AA's 4.5:1. In light
 *   `--muted-foreground` reached 3.96:1 on `--sidebar` and 3.40:1 on
 *   `--sidebar-accent`, and the group label 4.20:1. `--sidebar-accent` is the
 *   tighter of those two grounds and the resting column paints no text on it —
 *   every row that takes it does so hovered or highlighted — so the walk reaches
 *   it deliberately and then asserts it got there, rather than leaving the
 *   closest call in the change unmeasured while everything else passes.
 *
 * Chroma is what separates an accent from the surface: every neutral this column
 * paints sits at or under 0.015, and the 28% brand edge at 0.15. The two
 * populations are a tenfold apart, and the threshold below sits about three
 * times clear of each of them, so it is a gap rather than a number picked to
 * make something pass. It buys a stroke exactly what #515's criterion says —
 * "a stroke carrying its own meaning (`--brand`, a focus ring)" is excluded.
 * Meaning, not a named token: a list of accent rules would be the selector list
 * this test exists not to be.
 *
 * Ink has no such exclusion, and since #569 no text has one either. The one text
 * that used to be let through — `.ub-menu-current`, the current workspace's row,
 * at 1.93:1 in light — now reads `--brand-ink`, so it is measured like every
 * other text on the surface and the carve-out is gone rather than inherited.
 */
const accentChroma = 0.05;

for (const scheme of ["light", "dark"] as const) {
  test(`the sidebar's interior reads the sidebar's own tokens — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openApp(browser, scheme);

    // The floor is the column's outer edge, whatever it is painted.
    const edge = await painted(page, ".ub-list", "border-right-color");
    const ground = await painted(page, ".ub-list", "background-color");
    const floor =
      scheme === "light" ? separation(edge, ground) : contrast(edge, ground);
    // Reading the floor off the column is what keeps it from drifting away from
    // the surface — but it would also fall with `--sidebar-border` if that token
    // were ever weakened, and every interior stroke would still pass. AC1 names
    // 0.040, so light holds that absolutely too. Dark's floor is relative by the
    // criterion's own construction and has no such number.
    if (scheme === "light") expect(floor).toBeGreaterThanOrEqual(0.04);

    // The workspace header paints the accent ground only while hovered, so the
    // walk has to reach that state rather than proving its resting separator
    // twice. Dark had 1.46:1 here before the light-only repair and must keep it.
    const workspace = page.locator(".ub-workspace");
    const resting = await paintedIn(workspace, "background-color");
    await workspace.hover();
    const workspaceGround = await paintedIn(workspace, "background-color");
    expect(workspaceGround).not.toBe(resting);
    const workspaceEdge = await paintedIn(workspace, "border-bottom-color");
    if (scheme === "dark") {
      expect(contrast(workspaceEdge, workspaceGround)).toBeGreaterThanOrEqual(
        1.46,
      );
    }
    const readings = await surface(page, ".ub-list");

    // A group, so its header rule and two quiet actions are on screen. "+ group"
    // makes one and opens its rename field, so the column is read once with the
    // field and once with the header at rest.
    await page.getByRole("button", { name: "+ group" }).click();
    readings.push(...(await surface(page, ".ub-list")));
    await page.getByLabel("Group name").press("Enter");
    // `.first()` because the sidebar is one workspace shared by this file's
    // tests, so the appearance before this one has already left a group here.
    await expect(page.locator(".ub-group-toggle").first()).toBeVisible();
    readings.push(...(await surface(page, ".ub-list")));

    // Both anchored menus, each while it is open: they are portalled siblings
    // of the app, so nothing in the column reaches them and they carry their
    // own rules.
    await workspace.click();
    await expect(page.locator("[data-slot=dropdown-menu-content]")).toBeVisible();
    readings.push(...(await surface(page, "[data-slot=dropdown-menu-content]")));
    // And once more with the current workspace's row highlighted, which is where
    // `--sidebar-accent` gets under a text: the row's own count keeps the muted
    // ink while the item takes the accent ground, and that pairing — 4.70:1, the
    // worse of the two failures #515 published — is painted nowhere at rest.
    await page.locator(".ub-menu-current").hover();
    const highlight = await painted(page, ".ub-menu-current", "background-color");
    readings.push(...(await surface(page, "[data-slot=dropdown-menu-content]")));
    await page.keyboard.press("Escape");
    await page.locator(".ub-user-card").click();
    await expect(page.locator("[data-slot=popover-content]")).toBeVisible();
    readings.push(...(await surface(page, "[data-slot=popover-content]")));

    // The walk reached that ground — the coverage the change is tightest on, and
    // the same assertion that a silently empty result cannot pass.
    expect(
      readings.filter((one) => one.kind === "text" && one.ground === highlight),
      `no text measured on ${highlight}`,
    ).not.toHaveLength(0);

    for (const { where, kind, colour, ground: under } of readings) {
      const ink = oklab(colour);
      const seen = `${where} — ${colour} on ${under}`;
      if (kind === "text") {
        expect(contrast(colour, under), seen).toBeGreaterThanOrEqual(4.5);
        continue;
      }
      // A stroke above the threshold is the accent, which the criterion excludes.
      if (ink.chroma > accentChroma) continue;
      // Awareness hues are the one legacy-colour ground on this surface. UI
      // component strokes on them have a contrast contract, not an OKLab-token
      // separation to compare with the sidebar edge.
      if (legacySrgb(under) !== null) {
        expect(contrast(colour, under), seen).toBeGreaterThanOrEqual(3);
        continue;
      }
      if (scheme === "dark") {
        expect(contrast(colour, under), seen).toBeGreaterThanOrEqual(floor);
      } else {
        // A separation is between two opaque colours. Light has no translucent
        // stroke today, and one added later must fail here rather than be
        // measured uncomposited and pass on a number nothing paints.
        expect(ink.alpha, seen).toBe(1);
        expect(separation(colour, under), seen).toBeGreaterThanOrEqual(floor);
      }
    }
  });
}

/**
 * Every ground one text is read against: the nearest ancestor that paints an
 * opaque colour, the way `surface()` above finds one — or, where nothing over
 * the page does, `--page-ground`'s own stops, because the page's ground is a
 * gradient rather than a colour and a text on it is read against all of it.
 *
 * Derived rather than named, for the reason the walk exists: a link that lands
 * inside an annotated range or an inline-code span has a ground its rule never
 * mentions, and a list of expected grounds would keep passing after that ground
 * moved.
 */
async function groundsUnder(page: Page, locator: Locator): Promise<string[]> {
  const over = await locator.evaluate((element) => {
    const opaque = (colour: string): boolean => {
      const rgba = /^rgba?\(([^)]*)\)$/.exec(colour);
      if (rgba !== null) {
        const parts = (rgba[1] ?? "").split(",");
        return parts.length !== 4 || Number(parts[3]) === 1;
      }
      const slashed = /\/\s*(\d*\.?\d+)\s*\)$/.exec(colour);
      return slashed === null || Number(slashed[1]) === 1;
    };
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      if (node === document.body) break;
      const style = getComputedStyle(node);
      if (style.backgroundImage !== "none") {
        throw new Error("cannot establish the ground through a painted image");
      }
      const colour = style.backgroundColor;
      if (opaque(colour)) return colour;
    }
    return null;
  });
  if (over !== null) return [over];
  // The stops are the only parenthesised colours in the value — `at 0% 0%`
  // carries none — so matching them is the whole parse.
  const stops = (await painted(page, "body", "background-image")).match(
    /(?:rgba?|oklch)\([^)]*\)/g,
  );
  // A serialization this cannot read must fail here rather than pass as "no
  // ground to check".
  if (stops === null) throw new Error("no ground under this text");
  return stops;
}

/**
 * One brand ink, wherever the brand is text (#569).
 *
 * The walk above measures `.ub-menu-current` on `--sidebar` and on
 * `--sidebar-accent`. It cannot see the other three functional consumers: they
 * live on the document page. So this reads all four as the browser paints them,
 * holds each to AA on the grounds it actually sits on, and asserts they are
 * *one* value — no surface owning a private copy is the criterion, and five
 * rules reading five near-identical ambers would pass every contrast assertion
 * here while failing it.
 *
 * A link is read twice, because a document link is reachable on two very
 * different grounds: on the page's gradient, and inside an annotated range,
 * where `.ub-comment` paints `--brand-subtle` under it. Both are derived from
 * the rendered element rather than named here.
 *
 */
for (const scheme of ["light", "dark"] as const) {
  test(`the brand's functional ink is one readable value — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openApp(browser, scheme);

    // A document carrying the three consumers outside the sidebar. It needs a
    // title before the header offers Pin at all.
    await page.getByRole("button", { name: "+ new doc" }).click();
    await expect(page.locator(".ub-editor .ub-paragraph")).toBeVisible();
    const uuid = new URL(page.url()).pathname.split("/")[2] ?? "";
    await page.locator(".ub-title").fill(`brand ink ${scheme}`);

    // Two links in one paragraph, and a thread over the second of them: the
    // external link stays on the page's own ground, the reference ends up on
    // `--brand-subtle`, and neither ground is named below.
    const label = "reference";
    await placeCaret(page);
    await page.keyboard.type(`[a page](https://example.com/) and [${label}](${uuid})`);
    const reference = page.locator(".ub-editor a.ub-doclink");
    // An unresolved reference is painted `--muted-foreground` instead, so the
    // resolved state is what makes this a reading of the brand ink at all.
    await expect(reference).toHaveAttribute("data-doc-link-state", "resolved");
    // Back over the reference's own label, which the caret is sitting after —
    // Home would take the external link with it and leave nothing on the page's
    // ground.
    for (let back = 0; back < label.length; back += 1) {
      await page.keyboard.press("Shift+ArrowLeft");
    }
    await page.locator(".ub-composer-open").click();
    await page.keyboard.type("a thread", { delay: 15 });
    await page.keyboard.press("Enter");
    await expect(page.locator(".ub-editor .ub-comment a.ub-doclink")).toBeVisible();

    const actions = page.getByRole("button", { name: "Document actions" });
    await actions.click();
    await page.getByRole("menuitem", { name: "Pin to sidebar" }).click();
    await actions.click();
    const pin = page.getByRole("menuitem", { name: "Unpin from sidebar" });
    await expect(pin).toBeVisible();

    const consumers: Array<[string, Locator]> = [
      [".ub-link", page.locator(".ub-editor a.ub-link")],
      [".ub-doclink, annotated", reference],
    ];

    const inks = new Set<string>();
    const grounds = new Map<string, string[]>();
    for (const [where, locator] of [...consumers, [".ub-action-pinned", pin] as const]) {
      const ink = await paintedIn(locator, "color");
      inks.add(ink);
      const under = await groundsUnder(page, locator);
      grounds.set(where, under);
      for (const ground of under) {
        expect(
          contrast(ink, ground),
          `${where} — ${ink} on ${ground}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(grounds.get(".ub-link"), "the two link consumers sit on distinct grounds").not.toEqual(
      grounds.get(".ub-doclink, annotated"),
    );
    if (scheme === "light") {
      await page.locator("body").evaluate((body) => {
        const layer = document.createElement("span");
        layer.style.backgroundImage = "linear-gradient(red, red)";
        const text = document.createElement("span");
        text.id = "painted-ground-probe";
        layer.append(text);
        body.append(layer);
      });
      await expect(groundsUnder(page, page.locator("#painted-ground-probe"))).rejects.toThrow(
        "cannot establish the ground through a painted image",
      );
    }
    await page.keyboard.press("Escape");

    // And the fourth rule, in the switcher the walk above opens for its own
    // reasons.
    await page.locator(".ub-workspace").click();
    await expect(page.locator("[data-slot=dropdown-menu-content]")).toBeVisible();

    const currentInk = await paintedIn(page.locator(".ub-menu-current"), "color");
    inks.add(currentInk);
    for (const ground of await groundsUnder(page, page.locator(".ub-menu-current"))) {
      expect(contrast(currentInk, ground)).toBeGreaterThanOrEqual(4.5);
    }
    expect([...inks], "the functional brand ink is one value").toHaveLength(1);
  });
}

test("the document title is set in the bundled Fraunces, and nothing else moved", async ({
  browser,
}) => {
  const page = await openApp(browser, "light");
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ub-paragraph")).toBeVisible();

  expect(await painted(page, ".ub-title", "font-family")).toBe(
    'Fraunces, Georgia, "Times New Roman", serif',
  );

  // The stack above is satisfied by Georgia too, so it is not evidence on its
  // own. A title that reaches into all three vendored cuts is: the engine only
  // fetches a face whose characters it has to paint, so three `loaded` faces
  // is three files it found and used. Polish and Turkish are the latin-ext
  // cut, Vietnamese the third, and the rest of the line the first — a title
  // this face could not cover would be quietly half Georgia.
  await page.locator(".ub-title").fill("Łódź, Ağrı, Việt — a title");
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.fonts]
          .filter((face) => face.family === "Fraunces")
          .map((face) => face.status),
      ),
    )
    .toEqual(["loaded", "loaded", "loaded"]);

  // Title-only: the prose it sits above and the column beside it keep Geist,
  // and the title is not in it.
  const prose = await painted(page, ".ub-editor .ub-paragraph", "font-family");
  expect(prose).toBe(await painted(page, ".ub-list", "font-family"));
  expect(prose).toContain("Geist");
  expect(prose).not.toContain("Fraunces");

  // The face changed and the setting did not: same size and weight as the h1
  // it is matched to, and a box still as wide as the column rather than as
  // wide as its own text — a serif is wider than Geist per character, and an
  // input that sized itself would take the layout with it.
  expect(await painted(page, ".ub-title", "font-size")).toBe("32.8px");
  expect(await painted(page, ".ub-title", "font-weight")).toBe("500");
  expect(await width(page, ".ub-title")).toBe(await width(page, ".ub-editor"));

  // No font file comes from outside the app, and the Google Fonts stylesheet
  // endpoint the feature replaced is absent too. Fraunces itself was fetched.
  const fetched = await page.evaluate(() => {
    const resources = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name);
    const fonts = resources.filter((url) => /\.(woff2?|otf|ttf)(\?|$)/i.test(url));
    return {
      googleStylesheets: resources.filter(
        (url) => new URL(url).hostname === "fonts.googleapis.com",
      ),
      offOrigin: fonts.filter((url) => new URL(url).origin !== location.origin),
      fraunces: fonts.filter((url) => /fraunces/i.test(url)).length,
    };
  });
  expect(fetched.googleStylesheets).toEqual([]);
  expect(fetched.offOrigin).toEqual([]);
  expect(fetched.fraunces).toBeGreaterThan(0);
});

/**
 * The copy-link control's touch target (#535).
 *
 * A browser, because the claim is layout and nothing else. The target used to
 * be a pseudo-element overhanging a 25px row, and both directions it could
 * overhang were already spoken for: `.ub-title` is full-bleed a few pixels
 * below and lost the taps a target reaching down took from it (Codex round 1),
 * and above is `.ub-pane`'s top padding, which scrolls away — the same target
 * measured 44px at rest and 25px once the pane had scrolled 20px, with the
 * button itself still fully visible and unchanged (Opus round 1). The target is
 * the control's own box now, and this asks the only question that settles it:
 * at both offsets where a reader can see the whole control, does the whole
 * 44x44 take a click?
 */
test("the copy-link control is a 44px target, at rest and once the pane has scrolled", async ({
  browser,
}) => {
  const page = await openApp(browser, "light");
  await ensureExampleCatalog(page);
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ub-paragraph")).toBeVisible();

  // Prose enough that the pane really scrolls: the defect this replaced was
  // invisible in a document short enough to sit still.
  await placeCaret(page);
  await page.keyboard.type("a line of prose\n".repeat(24));

  // A long tag selection, because that is what pushes this row around.
  const editTags = page.getByRole("button", { name: "Edit tags" });
  await editTags.click();
  for (const tag of ["auth", "billing", "mcp", "permissions", "sync"]) {
    await page.getByRole("option", { name: tag, exact: true }).click();
  }
  await editTags.click();

  /**
   * The live target, hit-tested rather than computed. Reading the rule's own
   * offsets back out only re-states what the stylesheet says, and the
   * arithmetic that turns them into a rectangle is wrong for any other way of
   * writing the same target — a wrong number there would look like a passing
   * measurement. `contains` answers what matters: does this control take the
   * click?
   */
  const probe = (
    toClipEdge: boolean,
  ): Promise<{
    liveHeight: number;
    liveWidth: number;
    takesTheRevision: boolean;
    takesTheTitle: boolean;
    scrolled: number;
  }> =>
    page.evaluate((flush) => {
      const control = document.querySelector(".ub-copy-link");
      const revision = document.querySelector(".ub-doc-rev");
      const title = document.querySelector(".ub-title");
      const pane = document.querySelector(".ub-pane");
      if (control === null || revision === null || title === null || pane === null) {
        throw new Error("e2e: no document identity line");
      }
      if (flush) {
        // The last offset at which all of the control is still on screen: its
        // top edge resting on the pane's clip edge. A target spent in the
        // padding above the row is entirely gone here, while the control a
        // reader is aiming at has not moved a pixel.
        pane.scrollTop += Math.floor(
          control.getBoundingClientRect().top - pane.getBoundingClientRect().top,
        );
      }
      const box = control.getBoundingClientRect();
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height / 2);
      const answers = (px: number, py: number): boolean =>
        control.contains(document.elementFromPoint(px, py));
      // Swept outward from the centre, the one point inside the target however
      // the target is drawn.
      let top = y;
      let bottom = y;
      let left = x;
      let right = x;
      while (answers(x, top - 1)) top -= 1;
      while (answers(x, bottom + 1)) bottom += 1;
      while (answers(left - 1, y)) left -= 1;
      while (answers(right + 1, y)) right += 1;
      const revisionBox = revision.getBoundingClientRect();
      return {
        liveHeight: bottom - top + 1,
        liveWidth: right - left + 1,
        takesTheRevision: answers(
          Math.round(revisionBox.x + revisionBox.width / 2),
          Math.round(revisionBox.y + revisionBox.height / 2),
        ),
        takesTheTitle: answers(x, title.getBoundingClientRect().top + 1),
        scrolled: pane.scrollTop,
      };
    }, toClipEdge);

  // The three widths the layout has to hold at, including the iPad width the
  // 44px is *for*.
  for (const width of [1280, 1100, 768]) {
    await page.setViewportSize({ width, height: 620 });
    // Typing left the pane scrolled to the caret; the first reading is of the
    // header at rest.
    await page.evaluate(() => {
      const pane = document.querySelector(".ub-pane");
      if (pane !== null) pane.scrollTop = 0;
    });

    const rest = await probe(false);
    // The target a thumb needs is really there, not merely declared…
    expect(rest.liveHeight).toBeGreaterThanOrEqual(44);
    expect(rest.liveWidth).toBeGreaterThanOrEqual(44);
    // …and it is not paid for with either adjacent fact.
    expect(rest.takesTheRevision).toBe(false);
    expect(rest.takesTheTitle).toBe(false);

    // Then again with the header scrolled up against the clip edge. A
    // measurement taken where the pane could not scroll proves nothing, so the
    // offset it reached is asserted too.
    const scrolled = await probe(true);
    expect(scrolled.scrolled).toBeGreaterThan(0);
    expect(scrolled.liveHeight).toBeGreaterThanOrEqual(44);
    expect(scrolled.liveWidth).toBeGreaterThanOrEqual(44);
    expect(scrolled.takesTheRevision).toBe(false);
    expect(scrolled.takesTheTitle).toBe(false);
  }

  // The identity confirmation uses the target's lower half: it neither moves
  // nor intersects the uuid, revision, title or actions when it appears.
  await page.setViewportSize({ width: 360, height: 620 });
  await page.getByRole("button", { name: "Hide document list" }).click();
  const headerRects = (): Promise<Record<string, DOMRect>> =>
    page.evaluate(() => {
      const selectors = {
        uuid: ".ub-copy-link",
        revision: ".ub-doc-rev",
        title: ".ub-title",
        actions: ".ub-actions-trigger",
      } as const;
      return Object.fromEntries(
        Object.entries(selectors).map(([name, selector]) => {
          const element = document.querySelector(selector);
          if (element === null) throw new Error(`e2e: missing ${selector}`);
          return [name, element.getBoundingClientRect().toJSON()];
        }),
      );
    });
  const beforeCopy = await headerRects();
  await page.locator(".ub-copy-link").click();
  await expect(page.locator(".ub-copied")).toHaveText("URL copied to clipboard");
  expect(await headerRects()).toEqual(beforeCopy);
  expect(
    await page.evaluate(() => {
      const rangeFor = (selector: string): DOMRect => {
        const element = document.querySelector(selector);
        if (element === null) throw new Error(`e2e: missing ${selector}`);
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect();
      };
      const feedback = rangeFor(".ub-copied");
      const separatedFrom = [
        rangeFor(".ub-copy-link"),
        rangeFor(".ub-doc-rev"),
        document.querySelector(".ub-title")?.getBoundingClientRect(),
        document.querySelector(".ub-actions-trigger")?.getBoundingClientRect(),
      ];
      return separatedFrom.every(
        (box) =>
          box !== undefined &&
          (feedback.right <= box.left ||
            feedback.left >= box.right ||
            feedback.bottom <= box.top ||
            feedback.top >= box.bottom),
      );
    }),
  ).toBe(true);

  // The waiting screen still carries the explicit text control. Its feedback
  // remains inside that button because there is no hydrated identity to hide.
  const confirmationIsContained = async (open: Page): Promise<boolean> => {
    await open.locator(".ub-copy-link").click();
    await expect(open.locator(".ub-copied")).toHaveText("URL copied to clipboard");
    return open.evaluate(() => {
      const control = document.querySelector(".ub-copy-link");
      const note = document.querySelector(".ub-copied");
      if (control === null || note === null) throw new Error("e2e: no control");
      const box = control.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(note);
      const shown = range.getBoundingClientRect();
      return (
        shown.left >= box.left - 0.5 &&
        shown.right <= box.right + 0.5 &&
        shown.top >= box.top - 0.5 &&
        shown.bottom <= box.bottom + 0.5
      );
    });
  };

  const waiting = await openApp(
    browser,
    "light",
    `/${harness().workspace}/${randomUUID()}`,
  );
  await expect(waiting.locator(".ub-notice")).toContainText("Waiting for sync");
  expect.soft(await confirmationIsContained(waiting)).toBe(true);
});
