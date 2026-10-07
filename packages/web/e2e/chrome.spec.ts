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
 *   background and its font have to *equal* the sidebar's, in a representative
 *   scheme, and they only can if `@theme` resolved to the product's tokens
 *   rather than to Tailwind's defaults.
 *   The source-token table checks palette ratios in both colour schemes.
 * - **The product wiring works.** Uberblick's triggers open its content and
 *   actions write or refuse as promised; accessibility scans cover primitives.
 * - **The theme is real.** `data-theme` re-themes the editor and the sidebar
 *   from tokens alone, and survives a reload. A stylesheet is exactly what
 *   jsdom does not have.
 * - **A connected agent is counted.** The count reads awareness over a real
 *   hub, and the session it counts is a client that is not a browser at all.
 * - **The cascade wires the highlight.** The token table holds palette floors;
 *   rendered consumers must still share one card accent, including the focused
 *   orphan chip whose actual ground changes with state (#516).
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
 * - **Settings follow browser history.** Back and Forward retire the outgoing
 *   pane from hit testing and close its portalled controls. jsdom holds the
 *   panes' inert and ARIA state; the browser holds history focus and motion.
 */

import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createDoc, editor, setupHarness } from "./app-helpers.js";
import type { Browser, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  importRootSecret,
  MAX_TOKEN_LIFETIME_SECONDS,
  mintToken,
} from "@uberblick/hub";
import { wrapToken } from "@uberblick/hub/protocol";
import {
  appendBlock,
  assignDocumentTags,
  createAnnotation,
  createGroup,
  createTagCatalogEntry,
  decisionDirectoryFields,
  deleteBlock,
  directoryRoom,
  getBlocksFragment,
  getDirectoryEntry,
  getDirectoryMap,
  initDoc,
  MAX_TAG_NAME_LENGTH,
  retireTagCatalogEntry,
  pinDoc,
  readSidebar,
  roomForDoc,
  seedTagCatalog,
  setAnnotationResolved,
  setKind,
  settingsRoom,
  sidebarRoom,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import * as Y from "yjs";
import { placeCaret } from "./harness.js";
import { renderedText, strokeSeparation } from "./contrast-helpers.js";
import { alphaOf, composite, contrast, legacySrgb, lightnessLimit, oklab, pageGrounds, separation } from "../test/colour.js";
import { cardHighlightFloor, focusedOrphanedChipFloor } from "../test/contrast-contract.js";

const { harness, openApp } = setupHarness();

/** The appearance and input context required by this file's CSS proofs. */
async function openAppearanceApp(
  browser: Browser,
  colorScheme: "light" | "dark",
  path = "",
  hasTouch = false,
  contextOptions: BrowserContextOptions = {},
): Promise<Page> {
  return openApp(browser, path, {
    upstream: true,
    contextOptions: { colorScheme, hasTouch, ...contextOptions },
    readySelector: path.includes("/settings") ? "[data-settings-page]" : ".ub-workspace",
  });
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

/** A keyboard focus cue must be painted, regardless of its chosen thickness. */
async function expectFocusIndicator(control: Locator): Promise<void> {
  await expect(control).toBeFocused();
  expect(await control.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  expect(await paintedIn(control, "outline-style")).not.toBe("none");
  expect(Number.parseFloat(await paintedIn(control, "outline-width"))).toBeGreaterThan(0);
  expect(alphaOf(await paintedIn(control, "outline-color"))).toBeGreaterThan(0);
}

/** jsdom owns inert/ARIA state; the browser owns the pane's hit testing. */
async function expectPaneRejectsPointer(pane: Locator): Promise<void> {
  expect(await pane.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(
      box.left + box.width / 2, box.top + box.height / 2,
    ));
  })).toBe(false);
}

async function expectNoSidebarMotion(page: Page): Promise<void> {
  expect(await page.locator(".ub-list").evaluate((sidebar) =>
    sidebar.getAnimations({ subtree: true }).filter((animation) =>
      animation.playState === "running" || animation.pending,
    ).length,
  )).toBe(0);
}

/**
 * What the identity row's tag strip does with the width it was given (#958).
 *
 * The strip's own box says nothing about this: a pill wider than its strip
 * escapes it without moving it, so the hit test is the *painted* rectangle of
 * every pill against the machine facts and the actions beside them. Clipping
 * and the row's height come back with it, because containment bought with a
 * sideways scroller or a silent clip is the thing criterion 3 rejects. One
 * helper serves both headers: `.ub-tags` is the writable trigger and the
 * read-only span alike, and only one of them is on screen at a time.
 */
function tagStripGeometry(page: Page): Promise<{
  overlaps: string[];
  clipped: number;
  strip: number;
  row: number;
}> {
  return page.evaluate(() => {
    const strip = document.querySelector(".ub-tags");
    const row = document.querySelector(".ub-doc-meta");
    if (strip === null || row === null) {
      throw new Error("e2e: no tag strip in the identity line");
    }
    const neighbours = [".ub-doc-ids", ".ub-document-actions"].flatMap((selector) => {
      const element = document.querySelector(selector);
      return element === null ? [] : [[selector, element.getBoundingClientRect()] as const];
    });
    const overlaps: string[] = [];
    for (const pill of document.querySelectorAll(".ub-tag")) {
      const box = pill.getBoundingClientRect();
      for (const [selector, beside] of neighbours) {
        if (
          box.left < beside.right &&
          box.right > beside.left &&
          box.top < beside.bottom &&
          box.bottom > beside.top
        ) {
          overlaps.push(`${pill.textContent ?? ""} over ${selector}`);
        }
      }
    }
    return {
      overlaps,
      clipped: strip.scrollWidth - strip.clientWidth,
      strip: strip.getBoundingClientRect().height,
      row: row.getBoundingClientRect().height,
    };
  });
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

for (const scheme of ["dark"] as const) {
  test(`the sidebar's menus are the product's own surface — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openAppearanceApp(browser, scheme);

    // The switcher: anchored to the sidebar's header and as wide as it.
    await page.locator(".ub-workspace").click();
    const menu = page.locator("[data-slot=dropdown-menu-content]");
    await expect(menu).toBeVisible();
    await matchesTheSidebar(page, "[data-slot=dropdown-menu-content]");
    expect(await width(page, "[data-slot=dropdown-menu-content]")).toBe(
      await width(page, ".ub-workspace"),
    );

    // The configured workspace uses its shared display-name reading.
    const configured = menu.getByRole("menuitem", { name: /^Unnamed workspace · / });
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

    // Settings stays in the fixed footer; the switcher only lists workspaces.
    await expect(menu.getByRole("menuitem", { name: "New workspace" })).toHaveCount(0);
    await expect(menu.locator('[data-slot="dropdown-menu-separator"]')).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Workspace settings" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // The user panel: the same surface, opened from the foot of the column.
    await page.getByTestId("account-menu").click();
    const panel = page.locator("[data-slot=popover-content]");
    await expect(panel).toBeVisible();
    await matchesTheSidebar(page, "[data-slot=popover-content]");
    await expect(panel.getByRole("group", { name: "Presence colour" })).toBeVisible();
  });
}

for (const scheme of ["light"] as const) {
  test(`the selected appearance has one non-hue cue — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openAppearanceApp(browser, scheme);
    await page.getByTestId("account-menu").click();
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
    // Token ratios and axe cannot see which border carries selection after the cascade.
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
    const page = await openAppearanceApp(browser, scheme);
    await page.getByTestId("account-menu").click();
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
      // The awareness palette and selected border are consumer wiring, beyond the token table and axe.
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

test("settings panes reject the pointer and follow browser history", async ({
  browser,
}) => {
  const page = await openAppearanceApp(browser, "light");
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
  await expectPaneRejectsPointer(documents);

  // The route is the selection: browser Back restores the document sidebar.
  await page.goBack();
  await expect(page).toHaveURL(new URL(workspacePath, harness().appUrl).href);
  await expect(page.getByRole("button", { name: "+ new doc" })).toBeVisible();
  await expect(settingsEntry).toBeFocused();
  await expectPaneRejectsPointer(settings);

  // Browser Forward retires the outgoing document pane's portalled menu.
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

  await page.getByTestId("account-menu").click();
  const userPanel = page.locator("[data-slot=popover-content]");
  await expect(userPanel).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new URL(settingsPath, harness().appUrl).href);
  // The shared account control stays available in both modes. Radix dismisses
  // its popover when the sidebar hands focus to the incoming header.
  await expect(userPanel).toBeHidden();
  await expect(back).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(new URL(workspacePath, harness().appUrl).href);
  await expect(settingsEntry).toBeFocused();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await expectNoSidebarMotion(page);
});

test("the settings drawer retires the outgoing pane and respects reduced motion", async ({ browser }) => {
  const page = await openAppearanceApp(browser, "light");
  await page.setViewportSize({ width: 820, height: 832 });
  await page.getByRole("button", { name: "Show document list", exact: true }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await expectPaneRejectsPointer(page.locator(".ub-document-sidebar"));

  // History switches modes while the drawer remains open, so the reduced
  // motion proof observes the drill-in itself rather than a fresh mount.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ new doc" })).toBeVisible();
  await expectPaneRejectsPointer(page.locator(".ub-settings-sidebar"));
  await expectNoSidebarMotion(page);
  await page.goForward();
  await expectPaneRejectsPointer(page.locator(".ub-document-sidebar"));
  await expectNoSidebarMotion(page);
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
for (const scheme of ["light"] as const) {
  test(`a disabled sidebar control keeps its ground under the pointer — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openAppearanceApp(browser, scheme, "not-a-workspace");
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

for (const scheme of ["light"] as const) {
  test(`sidebar controls keep their treatment after touch — ${scheme}`, { tag: "@webkit-touch" }, async ({ browser }, info) => {
    const page = await openApp(browser, "/", {
      upstream: true,
      readySelector: ".ub-pane",
      contextOptions: {
        colorScheme: scheme,
        hasTouch: true,
        ...(info.project.name === "chromium" ? { viewport: { width: 390, height: 844 } } : {}),
      },
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);

    const treatment = (control: Locator): Promise<string[]> => control.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.color, style.borderTopColor];
    });
    const openSidebar = async (settings = false): Promise<void> => {
      if ((page.viewportSize()?.width ?? 1280) < 1280) {
        await page.getByRole("button", { name: settings ? "Show sidebar" : "Show document list", exact: true }).tap();
        await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toBeVisible();
      }
    };
    const checkHoverAndFocus = async (control: Locator, ring: "native" | "shadcn" = "native"): Promise<string[]> => {
      await expect(control).toBeVisible();
      await page.mouse.move(0, 0);
      const rest = await treatment(control);
      // Force :hover without activating navigation. A selected destination's
      // real tap changes its ground independently of input capability.
      await control.hover();
      expect(await treatment(control)).toEqual(rest);

      // Unchanged controls retain this engine's native ring; the standard
      // sidebar button supplies its own visible ring through shadcn.
      // The reference stays inside the active focus scope of the drawer/panel.
      await control.evaluate((element) => {
        const reference = document.createElement("button");
        reference.type = "button";
        reference.dataset.hoverProofReference = "";
        reference.textContent = "Focus reference";
        element.after(reference);
      });
      const reference = page.locator("[data-hover-proof-reference]");
      const outline = (one: Locator) => one.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.outlineStyle, style.outlineWidth, style.outlineOffset];
      });
      try {
        await control.focus();
        // iOS does not put every button in desktop Tab order. A harmless key
        // establishes keyboard modality; direct focus measures the ring alone.
        await page.keyboard.press("ArrowRight");
        await reference.focus();
        await expect(reference).toBeFocused();
        expect(await reference.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        const native = await outline(reference);
        await control.focus();
        await expect(control).toBeFocused();
        expect(await control.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        const actual = await outline(control);
        if (ring === "shadcn") {
          expect(actual[0]).not.toBe("none");
          expect(Number.parseFloat(actual[1] ?? "0")).toBeGreaterThan(0);
          expect(Number.parseFloat(actual[2] ?? "0")).toBeGreaterThanOrEqual(0);
          expect(oklab(await paintedIn(control, "outline-color")).alpha).toBeGreaterThan(0);
        } else {
          expect(actual).toEqual(native);
        }
      } finally {
        await reference.evaluate((element) => element.remove());
      }
      return rest;
    };

    await openSidebar();
    const create = page.getByRole("button", { name: "+ new doc", exact: true });
    await expect(create).toBeEnabled();
    const createRest = await checkHoverAndFocus(create);
    await create.tap();
    await expect(page.locator(".ub-editor .ProseMirror")).toBeVisible();
    await openSidebar();
    expect(await treatment(create)).toEqual(createRest);

    const addGroup = page.locator(".ub-group-add");
    const addRest = await checkHoverAndFocus(addGroup);
    await addGroup.tap();
    await expect(page.getByLabel("Group name")).toBeVisible();
    expect(await treatment(addGroup)).toEqual(addRest);
    await page.getByLabel("Group name").fill(`Touch hover ${scheme}`);
    await page.getByLabel("Group name").press("Enter");

    const user = page.getByTestId("account-menu");
    const userRest = await checkHoverAndFocus(user, "shadcn");
    await user.tap();
    const panel = page.locator(".ub-user-panel");
    await expect(panel).toBeVisible();
    expect(await treatment(user)).toEqual(userRest);
    const appearance = panel.getByRole("group", { name: "Appearance" });
    const system = appearance.getByRole("button", { name: "System", exact: true });
    await expect(system).toHaveAttribute("aria-pressed", "true");
    const selected = await checkHoverAndFocus(system);
    const matching = appearance.getByRole("button", { name: scheme === "light" ? "Light" : "Dark", exact: true });
    await checkHoverAndFocus(matching);
    await matching.tap();
    await expect(matching).toHaveAttribute("aria-pressed", "true");
    expect(await treatment(matching)).toEqual(selected);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    const allDocs = page.locator(".ub-all-open-entry");
    await checkHoverAndFocus(allDocs);
    await allDocs.tap();
    await openSidebar();
    await expect(allDocs).toHaveAttribute("aria-current", "page");

    const settings = page.locator(".ub-settings-entry");
    await checkHoverAndFocus(settings);
    await settings.tap();
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await openSidebar(true);
    const navigation = page.locator(".ub-settings-nav");
    const tags = navigation.getByRole("button", { name: "Tags", exact: true });
    await checkHoverAndFocus(tags);
    await tags.tap();
    await expect(page.getByRole("heading", { name: "Tags", exact: true })).toBeVisible();
    await openSidebar(true);
    await expect(tags).toHaveAttribute("aria-current", "page");
    const general = navigation.getByRole("button", { name: "General", exact: true });
    await checkHoverAndFocus(general);
    await general.tap();
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await openSidebar(true);
    await expect(general).toHaveAttribute("aria-current", "page");

    await page.goto(new URL("/not-a-workspace", harness().appUrl).href);
    await openSidebar();
    for (const disabled of [page.getByRole("button", { name: "new doc unavailable", exact: true }), page.locator(".ub-group-add")]) {
      await expect(disabled).toBeDisabled();
      const rest = await treatment(disabled);
      await disabled.hover();
      expect(await treatment(disabled)).toEqual(rest);
      // Native disabled buttons still receive touch hit testing, but no action.
      await disabled.tap({ force: true });
      expect(await treatment(disabled)).toEqual(rest);
    }
  });
}

test("the appearance choice re-themes the app from tokens alone, and survives a reload", async ({
  browser,
}) => {
  // A browser whose system preference is light: everything that follows is the
  // reader overruling it, which is the whole point of the setting.
  const page = await openAppearanceApp(browser, "light");
  // A document, so there is an editor on screen to re-theme — its ink comes
  // from `--prose-text`, a token nothing else in the app reads.
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ub-paragraph")).toBeVisible();
  const sidebar = await painted(page, ".ub-list", "background-color");
  const prose = await painted(page, ".ub-editor .ub-paragraph", "color");

  await page.getByTestId("account-menu").click();
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
  await page.getByTestId("account-menu").click();
  await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
  expect(await painted(page, ".ub-list", "background-color")).toBe(sidebar);
});

test("the TL;DR callout keeps its hierarchy, themes and wrapping at both reading widths", async ({
  browser,
}) => {
  const page = await openAppearanceApp(browser, "light");
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ub-paragraph")).toBeVisible();
  await page.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Add TL;DR" }).click();
  await page
    .getByLabel(
      "Write one or two plain-English sentences that help a reader understand this document.",
    )
    .fill("Summary without layout surprises. ".repeat(9).slice(0, 300));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Hide document list" }).click();

  const callout = page.locator(".ub-tldr");
  const title = callout.getByRole("heading", { name: "TL;DR" });
  const summary = callout.locator(".ub-tldr-body > p");
  await expect(callout).toBeVisible();
  expect(await paintedIn(title, "font-family")).toBe(
    await painted(page, ".ub-title", "font-family"),
  );

  const cardPaint = () =>
    callout.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundImage,
        border: style.borderColor,
        accentColor: getComputedStyle(element, "::before").backgroundColor,
      };
    });
  const light = await cardPaint();

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  const dark = await cardPaint();
  expect(dark.background).not.toBe(light.background);
  expect(dark.border).not.toBe(light.border);
  expect(dark.accentColor).not.toBe(light.accentColor);

  const titleSizes: number[] = [];
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    titleSizes.push(Number.parseFloat(await paintedIn(title, "font-size")));
    expect(Number.parseFloat(await paintedIn(title, "font-size"))).toBeGreaterThan(
      Number.parseFloat(await paintedIn(summary, "font-size")),
    );
    // Pseudo-elements have no DOM rectangle. The engine's resolved height and
    // inset place the accent in the card's padding box, inside its border.
    const accent = await callout.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element, "::before");
      const border = getComputedStyle(element);
      const cardTop = box.top + Number.parseFloat(border.borderTopWidth);
      const cardLeft = box.left + Number.parseFloat(border.borderLeftWidth);
      const top = cardTop + Number.parseFloat(style.top);
      return {
        cardTop,
        cardBottom: box.bottom - Number.parseFloat(border.borderBottomWidth),
        cardLeft,
        left: cardLeft + Number.parseFloat(style.left),
        top,
        bottom: top + Number.parseFloat(style.height),
        width: Number.parseFloat(style.width),
      };
    });
    expect(accent.top).toBeCloseTo(accent.cardTop, 1);
    expect(accent.bottom).toBeCloseTo(accent.cardBottom, 1);
    expect(accent.left).toBeCloseTo(accent.cardLeft, 1);
    expect(accent.width).toBeGreaterThan(0);
    const geometry = await callout.evaluate((element) => {
      const header = element.querySelector<HTMLElement>(".ub-tldr-header");
      const mark = element.querySelector<HTMLElement>(".ub-tldr-mark");
      const label = element.querySelector<HTMLElement>(".ub-tldr-label");
      const heading = element.querySelector<HTMLElement>("h2");
      const text = element.querySelector<HTMLElement>(".ub-tldr-body > p");
      if (header === null || mark === null || label === null || heading === null || text === null) {
        throw new Error("TL;DR layout is incomplete");
      }
      const headerBox = header.getBoundingClientRect();
      const markBox = mark.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      const headingBox = heading.getBoundingClientRect();
      const textBox = text.getBoundingClientRect();
      return {
        aligned: Math.round(markBox.left) === Math.round(textBox.left),
        labelAboveTitle: labelBox.bottom <= headingBox.top,
        bodyBelowHeader: textBox.top >= headerBox.bottom,
        wraps: textBox.height > Number.parseFloat(getComputedStyle(text).lineHeight),
        fitsCard: element.scrollWidth <= element.clientWidth,
        fitsBody: text.scrollWidth <= text.clientWidth,
      };
    });
    expect(geometry).toEqual({
      aligned: true,
      labelAboveTitle: true,
      bodyBelowHeader: true,
      wraps: true,
      fitsCard: true,
      fitsBody: true,
    });
  }
  expect(titleSizes[1]).toBeGreaterThan(titleSizes[0] ?? 0);
});

test("the open document owns the remaining chrome and its one sync-details handle", async ({
  browser,
}) => {
  const page = await openAppearanceApp(browser, "light");
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
    page.getByRole("dialog", { name: "Sync and presence" }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(path);
  await page.keyboard.press("Escape");
  await expect(sync).toBeFocused();
  expect(new URL(page.url()).pathname).toBe(path);
});

test("a multiline comment composer stays above its selected passage", async ({ browser }) => {
  const page = await openAppearanceApp(browser, "light");
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ub-paragraph")).toBeVisible();
  await placeCaret(page);
  for (let index = 1; index <= 10; index += 1) {
    await page.keyboard.type(`Passage ${index}`);
    if (index < 10) await page.keyboard.press("Enter");
  }
  const selectedPassage = "Passage 10";
  // Shift+Home selects to the document start on macOS. Keep this keyboard
  // selection within the final passage on both macOS and Linux.
  for (let character = 0; character < selectedPassage.length; character += 1) {
    await page.keyboard.press("Shift+ArrowLeft");
  }
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selectedPassage);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const composer = page.locator('[data-slot="selection-composer"]');
  await expect(composer.locator('[data-slot="selection-excerpt"]')).toHaveText(selectedPassage);
  await expect(composer.locator('[data-slot="selection-clamp"]')).toHaveCount(0);
  await expect(composer).toHaveAttribute("data-placement", "above");
  const field = composer.locator("textarea");
  const lines = Array.from({ length: 8 }, (_, index) => `Comment line ${index + 1}`);
  for (const [index, line] of lines.entries()) {
    if (index > 0) await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(line);
  }
  await expect(field).toHaveValue(lines.join("\n"));
  const card = await composer.boundingBox();
  const passage = await page.locator(".ub-editor .ub-paragraph").nth(9).boundingBox();
  if (card === null || passage === null) throw new Error("e2e: comment geometry is missing");
  expect(card.y).toBeGreaterThanOrEqual(0);
  expect(card.y + card.height).toBeLessThanOrEqual(passage.y);
  expect(await field.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  for (const name of ["Comment", "Cancel"]) {
    const button = await composer.getByRole("button", { name, exact: true }).boundingBox();
    if (button === null) throw new Error("e2e: comment action is missing");
    expect(button.y + button.height).toBeLessThanOrEqual(800);
  }
  await page.keyboard.press("Enter");
  await expect(page.locator(".ub-thread")).toContainText("Comment line 8");
});

test("document actions stay reachable, close with the route, and archive into Restore", async ({
  browser,
}) => {
  const page = await openApp(browser, "", {
    upstream: true,
    contextOptions: { colorScheme: "light" },
    readySelector: ".ub-workspace",
  });
  await page.getByRole("button", { name: "+ new doc" }).click();
  await page.locator(".ub-title").fill("Lifecycle notes");
  await page.setViewportSize({ width: 375, height: 720 });
  await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show document list", exact: true })).toBeVisible();

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
    expect(box.x + box.width, name).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  }
  await expect(uuid).toHaveText(/^uuid [0-9a-f]{8}/);
  await expect(page.locator(".ub-doc-meta")).not.toContainText("Copy link");
  const layout = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>(".ub-body");
      const pane = document.querySelector<HTMLElement>(".ub-pane");
      if (body === null || pane === null) throw new Error("e2e: no document pane");
      return {
        viewport: innerWidth,
        body: [body.clientWidth, body.scrollWidth],
        pane: [pane.clientWidth, pane.scrollWidth],
      };
    });
  for (const [client, scroll] of [layout.body, layout.pane]) {
    expect(client).toBe(layout.viewport);
    expect(scroll).toBeLessThanOrEqual(client ?? 0);
  }

  await uuid.click();
  await expect(page.locator(".ub-copied")).toHaveText("URL copied to clipboard");

  await trigger.click();
  await page.getByRole("menuitem", { name: "Pin to sidebar" }).click();
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
  await page.keyboard.press("Escape");
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
  // The archive took the pin with it (#957), so the sidebar stops listing the
  // document altogether rather than carrying it with an archived marker.
  await page.getByRole("button", { name: "Show document list" }).click();
  await expect.poll(async () => (await page.locator(".ub-list").boundingBox())?.x).toBe(0);
  await expect(page.locator(".ub-list")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Lifecycle notes/ }),
  ).toHaveCount(0);
});

/**
 * The archive confirmation is a surface, and a destructive one, so it owes the
 * proof a dialog owes: opaque over the page. Only a browser can settle
 * it — `light-dark()` resolves in the engine, and an undefined custom property
 * (which is what `--popover` was here) computes to `transparent` rather than
 * failing anywhere jsdom could see.
 */
for (const scheme of ["light"] as const) {
  test(`the archive confirmation is opaque over the page — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openAppearanceApp(browser, scheme);
    await page.getByRole("button", { name: "+ new doc" }).click();
    await page.locator(".ub-title").fill("Lifecycle notes");
    await page.getByRole("button", { name: "Document actions" }).click();
    await page.getByRole("menuitem", { name: "Archive document" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();

    // Fully opaque: any alpha below 1 is the page showing through, and
    // `rgba(0, 0, 0, 0)` is what an undefined custom property computes to.
    const background = await painted(page, "[data-slot=alert-dialog-content]", "background-color");
    expect(alphaOf(background), background).toBe(1);

    // Opaque paint is not enough on its own: the panel has to cover the page
    // rather than sit over a hole in itself, so nothing behind it is readable.
    // The overlay is the dimmed page; this asks what a point inside the panel
    // actually hits.
    expect(
      await page.evaluate(() => {
        const panel = document.querySelector("[data-slot=alert-dialog-content]");
        if (panel === null) throw new Error("no confirmation panel");
        const box = panel.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        );
        return panel.contains(hit);
      }),
    ).toBe(true);
  });
}

test("MCP connections counts a connected agent session, and stops when it goes", async ({
  browser,
}) => {
  const page = await openAppearanceApp(browser, "dark");
  const connections = page.locator(".ub-panel-fact", { hasText: "MCP connections" });

  await page.getByTestId("account-menu").click();
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

for (const viewport of [720, 1280]) {
test(`the document collaborator cluster stays compact and jumps once without moving selection — ${viewport}px`, async ({
  browser,
}) => {
  const page = await openAppearanceApp(browser, "light");
  // The narrow drawer closes on creation, leaving the full-width document pane.
  await page.setViewportSize({ width: viewport, height: 640 });
  if (viewport < 1280) await page.getByRole("button", { name: "Show document list", exact: true }).click();
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
    expect(titleAfter?.y).toBe(titleBefore?.y);
    expect(titleAfter?.width).toBe(titleBefore?.width);
    expect(editorAfter?.x).toBe(editorBefore?.x);
    expect(editorAfter?.width).toBe(editorBefore?.width);
    // The row reserves its circle's height while it is empty, so the cap and
    // the overflow control beside it leave it exactly as tall (#832). The
    // prose position that follows from it is proven at the transition that
    // would move it, in `collab.spec.ts`.
    expect((await status.boundingBox())?.height).toBe(rowBefore);

    const circles = await page.locator(".ub-peers > .ub-peer-control").evaluateAll((controls) =>
      controls.map((control) => {
        const avatar = control.querySelector<HTMLElement>(".ub-avatar");
        const box = control.getBoundingClientRect();
        const avatarBox = avatar?.getBoundingClientRect();
        const round = (element: Element, bounds: DOMRect): boolean => {
          const style = getComputedStyle(element);
          return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].every((corner) => {
            const [horizontal = "0", vertical = horizontal] = corner.split(" ");
            const radius = (value: string, diameter: number) => value.endsWith("%")
              ? Number.parseFloat(value) * diameter / 100 : Number.parseFloat(value);
            return radius(horizontal, bounds.width) >= bounds.width / 2 && radius(vertical, bounds.height) >= bounds.height / 2;
          });
        };
        return {
          width: box.width,
          height: box.height,
          top: box.top,
          left: box.left,
          right: box.right,
          avatarWidth: avatarBox?.width,
          avatarHeight: avatarBox?.height,
          round: round(control, box) && (avatar === null || avatarBox === undefined || round(avatar, avatarBox)),
        };
      }),
    );
    const firstCircle = circles[0];
    if (firstCircle === undefined) throw new Error("e2e: no collaborator circles");
    for (const [index, circle] of circles.entries()) {
      expect(circle.width).toBeGreaterThanOrEqual(24);
      expect(circle.width).toBe(circle.height);
      expect(circle.width).toBe(firstCircle.width);
      expect(circle.top).toBe(firstCircle.top);
      expect(circle.round).toBe(true);
      if (circle.avatarWidth !== undefined) {
        expect(circle.avatarWidth).toBe(circle.width);
        expect(circle.avatarHeight).toBe(circle.height);
      }
      const previous = circles[index - 1];
      if (previous !== undefined) {
        const overlap = previous.right - circle.left;
        expect(overlap).toBeGreaterThan(0);
        expect(overlap).toBeLessThan(previous.width / 2);
      }
    }
    await visible.first().focus();
    await page.keyboard.press("ArrowRight");
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText(
      (await visible.first().getAttribute("aria-label"))?.split(" · ").slice(0, 2).join(" · ") ?? "",
    );
    await expect(page.locator('[data-slot="tooltip-content"]')).toBeVisible();
    await expectFocusIndicator(visible.first());

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
    await expectFocusIndicator(jumpRow);
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
type GroundLayer = { colour: string; image: string; body: boolean };

/** Resolve raw ancestor paint in Node, through the shared colour module. */
function groundsFromLayers(layers: GroundLayer[]): string[] {
  const fills: string[] = [];
  const over = (ground: string): string => fills.toReversed().reduce(
    (under, fill) => composite(fill, under), ground,
  );
  for (const layer of layers) {
    if (layer.image !== "none") {
      if (!layer.body) throw new Error("cannot establish the ground through a painted image");
      return pageGrounds(layer.image, layer.colour).map(over);
    }
    const alpha = alphaOf(layer.colour);
    if (alpha === 1) return [over(layer.colour)];
    if (alpha > 0) fills.push(layer.colour);
  }
  throw new Error("nothing opaque under this surface");
}

async function surface(page: Page, root: string): Promise<Reading[]> {
  const raw = await page.evaluate((selector) => {
    const start = document.querySelector(selector);
    if (start === null) throw new Error(`no surface for ${selector}`);
    const layers = (element: Element | null): GroundLayer[] => {
      const result: GroundLayer[] = [];
      for (let node = element; node !== null; node = node.parentElement) {
        const style = getComputedStyle(node);
        result.push({ colour: style.backgroundColor, image: style.backgroundImage, body: node === document.body });
      }
      return result;
    };
    const readings: Array<Omit<Reading, "ground"> & { layers: GroundLayer[] }> = [];
    for (const element of [start, ...start.querySelectorAll("*")]) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (element.closest("[data-disabled], [aria-disabled='true'], :disabled") !== null) continue;
      const style = getComputedStyle(element);
      const where = `${selector} ${element.tagName.toLowerCase()}${element.getAttribute("class") === null ? "" : `.${element.getAttribute("class")?.trim().split(/\s+/).join(".")}`}`;
      const field = (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.value.trim() !== "";
      const speaks = field || [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
      );
      if (speaks) readings.push({ where, kind: "text", colour: style.color, layers: layers(element) });
      for (const side of ["top", "right", "bottom", "left"] as const) {
        if (Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0) {
          readings.push({ where: `${where} border-${side}`, kind: "stroke", colour: style.getPropertyValue(`border-${side}-color`), layers: layers(element) });
        }
      }
      // The browser's automatic ring carries its own meaning; author outlines
      // are measured against the ground outside the element.
      if (Number.parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== "none" && style.outlineStyle !== "auto") {
        readings.push({ where: `${where} outline`, kind: "stroke", colour: style.outlineColor, layers: layers(element.parentElement) });
      }
      if (Math.min(box.width, box.height) <= 2 && Math.max(box.width, box.height) > 2) {
        readings.push({ where: `${where} fill`, kind: "stroke", colour: style.backgroundColor, layers: layers(element.parentElement) });
      }
    }
    return readings;
  }, root);
  return raw.flatMap(({ layers, ...reading }) => {
    if (reading.kind === "stroke" && alphaOf(reading.colour) === 0) return [];
    return groundsFromLayers(layers).map((ground) => ({ ...reading, ground }));
  });
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

for (const scheme of ["light"] as ReadonlyArray<"light" | "dark">) {
  test(`the sidebar's interior reads the sidebar's own tokens — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openAppearanceApp(browser, scheme);

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

    // Include the standard header menu button's hover ground in the token walk.
    const workspace = page.locator(".ub-workspace");
    // Put the pointer outside the sidebar before reading its resting ground.
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error("e2e: no viewport");
    await page.mouse.move(viewport.width - 1, viewport.height - 1);
    const resting = await paintedIn(workspace, "background-color");
    await workspace.hover();
    const workspaceGround = await paintedIn(workspace, "background-color");
    expect(workspaceGround).not.toBe(resting);
    const readings = await surface(page, ".ub-list");

    // A group, so its header rule and two quiet actions are on screen. "+ group"
    // makes one and opens its rename field, so the column is read once with the
    // field and once with the header at rest.
    await page.getByRole("button", { name: "+ group" }).click();
    readings.push(...(await surface(page, ".ub-list")));
    const groupName = `Sidebar tokens ${scheme}`;
    await page.getByLabel("Group name").fill(groupName);
    await page.getByLabel("Group name").press("Enter");
    await expect(page.locator(".ub-group-label").filter({ hasText: groupName })).toBeVisible();
    readings.push(...(await surface(page, ".ub-list")));

    // Both anchored menus, each while it is open: they are portalled siblings
    // of the app, so nothing in the column reaches them and they carry their
    // own rules.
    await workspace.click();
    await expect(page.locator("[data-slot=dropdown-menu-content]")).toBeVisible();
    readings.push(...(await surface(page, "[data-slot=dropdown-menu-content]")));
    // Include the current row's name and visible checkmark on the highlight ground.
    await page.locator(".ub-menu-current").hover();
    const highlight = await painted(page, ".ub-menu-current", "background-color");
    readings.push(...(await surface(page, "[data-slot=dropdown-menu-content]")));
    await page.keyboard.press("Escape");
    await page.getByTestId("account-menu").click();
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

    // Settings uses the same sidebar ground. Its Back control is a native
    // button, so its utilities must carry both the hover and inherited face.
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
    const back = page.locator(".ub-settings-back");
    await expect(back).toBeVisible();
    expect(await paintedIn(back, "font-family")).toBe(
      await painted(page, ".ub-settings-sidebar", "font-family"),
    );
    await page.mouse.move(viewport.width - 1, viewport.height - 1);
    const backResting = await paintedIn(back, "background-color");
    await back.hover();
    const backGround = await paintedIn(back, "background-color");
    expect(backGround).not.toBe(backResting);
    expect(contrast(await paintedIn(back, "color"), backGround)).toBeGreaterThanOrEqual(4.5);
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
async function groundsUnder(_page: Page, locator: Locator): Promise<string[]> {
  const layers = await locator.evaluate((element) => {
    const result: GroundLayer[] = [];
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      result.push({ colour: style.backgroundColor, image: style.backgroundImage, body: node === document.body });
    }
    return result;
  });
  return groundsFromLayers(layers);
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
for (const scheme of ["light"] as const) {
  test(`the brand's functional ink is one readable value — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openAppearanceApp(browser, scheme);

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
    await page.getByRole("button", { name: "Comment", exact: true }).click();
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

test("the document title uses the bundled Fraunces while prose keeps its own face", async ({
  browser,
}) => {
  const page = await openAppearanceApp(browser, "light");
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ub-paragraph")).toBeVisible();

  // A title that reaches into all three vendored cuts proves more than a
  // declared stack: the engine only
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

  const applied = await page.locator(".ub-title").evaluate((title) => {
    const firstFamily = getComputedStyle(title).fontFamily.split(",")[0]?.trim().replace(/^["']|["']$/g, "");
    const bundled = [...document.fonts].filter((face) => face.family === "Fraunces");
    return { firstFamily, bundledFamily: bundled[0]?.family };
  });
  expect(applied.firstFamily).toBe(applied.bundledFamily);

  // Title-only: prose and sidebar share their own face.
  const prose = await painted(page, ".ub-editor .ub-paragraph", "font-family");
  expect(prose).toBe(await painted(page, ".ub-list", "font-family"));
  expect(prose.split(",").map((family) => family.trim().replace(/^["']|["']$/g, ""))).not.toContain(applied.bundledFamily);

  // The title remains as wide as the editor, regardless of its type size.
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
  const page = await openAppearanceApp(browser, "light");
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

  // The target holds in one docked and one narrow layout.
  for (const width of [1280, 768]) {
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
  await page.setViewportSize({ width: 375, height: 620 });
  await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show document list", exact: true })).toBeVisible();
  await page.locator(".ub-body").evaluate(async (body) => {
    await Promise.all(
      body.getAnimations({ subtree: true }).map((animation) =>
        animation.finished.catch(() => undefined),
      ),
    );
  });
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

  const waiting = await openAppearanceApp(
    browser,
    "light",
    `/${harness().workspace}/${randomUUID()}`,
  );
  await expect(waiting.locator(".ub-notice")).toContainText("Waiting for sync");
  expect.soft(await confirmationIsContained(waiting)).toBe(true);
});
/**
 * The document's tags read as tags rather than as a form field (#958).
 *
 * The token table cannot see the tag field's cascade or focus state, and axe
 * cannot measure their separation. The browser also observes what
 * the trigger paints, whether pills wrap or scroll out of sight, where the
 * keyboard lands when the panel has no field to enter it through, and whether
 * the field — once ten entries earn one — steps down from the panel it sits on
 * or washes over it. Dark, because the wash this replaces was `--input` as a
 * ground, which is 15% white and only visible where `light-dark()` resolved.
 */
test("the document's tags are wrapping pills, and the panel earns its search field — dark", async ({
  browser,
}) => {
  const page = await openAppearanceApp(browser, "dark");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureExampleCatalog(page);
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ub-paragraph")).toBeVisible();
  const documentUrl = page.url();
  const trigger = page.getByRole("button", { name: "Edit tags" });

  // Nothing assigned: the fallback stands where the pills will, before the same
  // chevron, and the control itself draws no box around them.
  await expect(trigger).toContainText("Add tags");
  await expect(page.locator(".ub-tag-chevron")).toHaveCount(1);
  expect(alphaOf(await paintedIn(trigger, "background-color"))).toBe(0);
  for (const edge of ["top", "right", "bottom", "left"]) {
    expect(Number.parseFloat(await paintedIn(trigger, `border-${edge}-width`))).toBe(0);
  }

  // Five entries is under the threshold, so the panel is a list: no field, and
  // the keyboard enters the list itself.
  await trigger.focus();
  await trigger.press("Enter");
  await expect(page.getByRole("searchbox", { name: "Search tags" })).toHaveCount(0);
  const first = page.getByRole("option").first();
  await expect(first).toBeFocused();

  // That focus is the only thing saying the keyboard is in the list, so the
  // highlight has to step off the panel's own ground — `--accent` and
  // `--sidebar` are one value in dark, and a cue drawn in it shows nothing.
  const panelFill = await painted(page, ".ub-tag-picker-panel", "background-color");
  expect(
    separation(await paintedIn(first, "background-color"), panelFill),
  ).toBeGreaterThan(0.02);

  // A comfortable list rather than a narrow box.
  const comfortableList = () => page.locator(".ub-tag-picker-panel").evaluate((panel) => {
    const box = panel.getBoundingClientRect();
    return {
      inside: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
      names: [...panel.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => {
        const name = option.querySelector<HTMLElement>(":scope > span:nth-child(2)");
        if (name === null) throw new Error("e2e: tag option has no name");
        const range = document.createRange();
        range.selectNodeContents(name);
        const lines = [...range.getClientRects()];
        const row = option.getBoundingClientRect();
        return lines.length === 1 && lines.every((line) =>
          line.left >= Math.max(row.left, box.left) && line.right <= Math.min(row.right, box.right) &&
          line.top >= Math.max(row.top, box.top) && line.bottom <= Math.min(row.bottom, box.bottom),
        ) && name.scrollWidth <= name.clientWidth;
      }),
    };
  });
  for (const viewport of [375, 1280]) {
    await page.setViewportSize({ width: viewport, height: 620 });
    await expect.poll(comfortableList).toEqual({ inside: true, names: [true, true, true, true, true] });
  }

  for (const tag of ["auth", "billing", "mcp", "permissions", "sync"]) {
    await page.getByRole("option", { name: tag, exact: true }).click();
  }
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  // Narrow enough that five pills cannot sit on one line. They take a second
  // line inside the row and the row grows to hold them; the scroller that used
  // to hide the overflow is gone, so nothing is out of sight.
  await page.getByRole("button", { name: "Hide document list" }).click();
  await page.setViewportSize({ width: 420, height: 620 });
  const strip = await page.evaluate(() => {
    const selected = document.querySelector(".ub-tag-selected");
    const pill = document.querySelector(".ub-tag");
    const row = document.querySelector(".ub-doc-meta");
    if (selected === null || pill === null || row === null) {
      throw new Error("e2e: no tag strip in the identity line");
    }
    return {
      clipped: selected.scrollWidth - selected.clientWidth,
      height: selected.getBoundingClientRect().height,
      pill: pill.getBoundingClientRect().height,
      row: row.getBoundingClientRect().height,
    };
  });
  expect(strip.height).toBeGreaterThan(strip.pill * 1.5);
  expect(strip.clipped).toBeLessThanOrEqual(1);
  expect(strip.row).toBeGreaterThanOrEqual(strip.height);

  // Past ten entries the field appears — and it is a bordered field carrying a
  // search icon, on a ground no lighter than the panel under it.
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.goto(
    new URL(`/${harness().workspace}/settings/tags`, harness().appUrl).href,
  );
  for (const name of ["design", "hub", "release", "schema", "storage"]) {
    await page.getByLabel("Create a tag").fill(name);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("button", { name: `Retire ${name}` })).toBeVisible();
  }
  await page.goto(documentUrl);

  const search = page.getByRole("searchbox", { name: "Search tags" });
  await trigger.click();
  await expect(search).toBeFocused();
  await expect(page.locator(".ub-tag-search-icon")).toHaveCount(1);
  const field = page.locator(".ub-tag-search-field");
  expect(Number.parseFloat(await paintedIn(field, "border-top-width"))).toBeGreaterThan(0);
  const fieldFill = await paintedIn(field, "background-color");
  const panel = await painted(page, ".ub-tag-picker-panel", "background-color");
  // Opaque *and* darker: the two halves of "no lighter than the panel". An
  // alpha wash reads a lightness of its own while painting the panel brighter,
  // so the opacity is what makes the lightness answer the question.
  expect(oklab(fieldFill).alpha).toBe(1);
  expect(oklab(fieldFill).L).toBeLessThanOrEqual(oklab(panel).L);
  expect(separation(fieldFill, panel)).toBeGreaterThan(0.02);

  // The wrap between pills cannot answer a single legal name. The catalog
  // allows 30 characters and a name is one unbroken token of letters, digits
  // and hyphens, so `aaa…` offers the line breaker nothing and is wider on its
  // own than the width this row can spare. Criterion 3 rules out both other
  // ways to contain it, so what has to happen is that the name wraps inside its
  // own pill.
  const longest = "a".repeat(MAX_TAG_NAME_LENGTH);
  await page.goto(
    new URL(`/${harness().workspace}/settings/tags`, harness().appUrl).href,
  );
  await page.getByLabel("Create a tag").fill(longest);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("button", { name: `Retire ${longest}` })).toBeVisible();
  // On its own, because one name is the case: with the five short ones beside
  // it the oversized pill is carried onto a line of its own below the machine
  // facts, and misses them without being any better contained.
  await page.goto(documentUrl);
  await trigger.click();
  await page.getByRole("option", { name: longest, exact: true }).click();
  for (const tag of ["auth", "billing", "mcp", "permissions", "sync"]) {
    await page.getByRole("option", { name: tag, exact: true }).click();
  }
  await page.keyboard.press("Escape");
  await expect(trigger).toContainText(longest);
  await expect(page.locator(".ub-tag")).toHaveCount(1);

  // The document list is still hidden from the wrap check above, so this is
  // the pane width the reader actually gets.
  for (const viewport of [375]) {
    await page.setViewportSize({ width: viewport, height: 620 });
    const geometry = await tagStripGeometry(page);
    expect(geometry.overlaps, `writable header at ${viewport}px`).toEqual([]);
    expect(geometry.clipped, `writable header at ${viewport}px`).toBeLessThanOrEqual(1);
    expect(geometry.row).toBeGreaterThanOrEqual(geometry.strip);
  }

  // The read-only header draws the same pills from the same rule, and it is the
  // surface criterion 2 owns. An archived document is how a reader reaches it;
  // the actions go with the archive, so the machine facts are the only
  // neighbour left to paint over.
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Archive document" }).click();
  await page.getByRole("button", { name: "Archive document" }).click();
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(page.locator(".ub-tags-readonly")).toContainText(longest);
  for (const viewport of [375]) {
    await page.setViewportSize({ width: viewport, height: 620 });
    const geometry = await tagStripGeometry(page);
    expect(geometry.overlaps, `read-only header at ${viewport}px`).toEqual([]);
    expect(geometry.clipped, `read-only header at ${viewport}px`).toBeLessThanOrEqual(1);
    expect(geometry.row).toBeGreaterThanOrEqual(geometry.strip);
  }

  // Leave the seeded catalog as this file's other tests expect to find it.
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.goto(
    new URL(`/${harness().workspace}/settings/tags`, harness().appUrl).href,
  );
  for (const name of ["design", "hub", "release", "schema", "storage", longest]) {
    await page.getByRole("button", { name: `Retire ${name}` }).click();
    await expect(page.getByRole("button", { name: `Restore ${name}` })).toBeVisible();
  }
  await expect(
    page.getByRole("region", { name: "Active" }).getByRole("listitem"),
  ).toHaveCount(5);
});

test("Workspace Settings uses the shared touch floors in narrow and wide layouts", async ({ browser }) => {
  for (const width of [375, 1366]) {
    const page = await openAppearanceApp(browser, "light", `/${harness().workspace}/settings/tags`, true, {
      isMobile: true,
      viewport: { width, height: 900 },
    });
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await expect(page.getByLabel("Create a tag")).toBeEnabled();
    const controls = await page.locator("[data-settings-page] [data-slot]").evaluateAll((elements) =>
      elements.map((element) => ({
        slot: element.getAttribute("data-slot"),
        height: element.getBoundingClientRect().height,
        font: Number.parseFloat(getComputedStyle(element).fontSize),
      })),
    );
    expect(new Set(controls.map((one) => one.slot))).toEqual(new Set(["button", "input"]));
    for (const one of controls) {
      expect(one.height, `${one.slot} at ${width}px`).toBeGreaterThanOrEqual(44);
      if (one.slot === "input") expect(one.font).toBeGreaterThanOrEqual(16);
    }
    const geometry = await page.locator("[data-settings-page]").evaluate((element) => ({
      visible: element.clientWidth,
      content: element.scrollWidth,
    }));
    expect(geometry.content, `settings overflow at ${width}px`).toBeLessThanOrEqual(geometry.visible);
  }
});

for (const scheme of ["light"] as const) {
  // Tokens cannot see later rules across settings states; axe cannot read text on the page gradient.
  test(`both settings pages keep every text readable through curation states — ${scheme}`, async ({ browser }) => {
    const path = `/${harness().workspace}/settings/tags`;
    const page = await openAppearanceApp(browser, scheme, `/${harness().workspace}/settings`);
    const readings = await surface(page, "[data-settings-page]");
    expect(readings.filter((one) => one.kind === "text")).not.toHaveLength(0);
    await page.goto(new URL(path, harness().appUrl).href);
    const field = page.getByLabel("Create a tag");
    await expect(field).toBeEnabled();
    readings.push(...await surface(page, "[data-settings-page]"));

    const name = `proof-${scheme}-${randomUUID().slice(0, 8)}`;
    await field.fill("Invalid Name");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    readings.push(...await surface(page, "[data-settings-page]"));
    await field.fill(name);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("button", { name: `Retire ${name}` })).toBeVisible();
    readings.push(...await surface(page, "[data-settings-page]"));

    // The field's value, both action variants on their hover grounds, and the
    // active/retired duplicate feedback all paint text beyond the resting page.
    await field.fill(name);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("already an active tag");
    readings.push(...await surface(page, "[data-settings-page]"));
    for (const variant of ["default", "outline"]) {
      const button = page.locator(`[data-settings-page] button[data-variant=${variant}]`).first();
      await button.hover();
      await expect.poll(() => button.evaluate((element) => element.getAnimations().length)).toBe(0);
      readings.push(...await surface(page, "[data-settings-page]"));
    }
    await page.getByRole("button", { name: `Retire ${name}` }).click();
    await expect(page.getByRole("button", { name: `Restore ${name}` })).toBeVisible();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("is retired");
    readings.push(...await surface(page, "[data-settings-page]"));

    // A connected client becomes read-only; a fresh replica waits for the
    // catalog. Both are ordinary product states, reached through real transport.
    await harness().stopHub();
    try {
      await expect(page.getByText("Tag changes are unavailable while this page is disconnected.")).toBeVisible();
      readings.push(...await surface(page, "[data-settings-page]"));
      const waiting = await openAppearanceApp(browser, scheme, path);
      await expect(waiting.getByText("Waiting for the tag catalog…")).toBeVisible();
      readings.push(...await surface(waiting, "[data-settings-page]"));
    } finally {
      await harness().startHub();
    }

    for (const { where, kind, colour, ground } of readings) {
      if (kind === "text") {
        expect(contrast(colour, ground), `${where} — ${colour} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
}

/** Real document, catalog and presence state; all peers end with the proof. */
async function contrastDocument(
  page: Page,
  scheme: "light" | "dark",
  prove: () => Promise<void>,
  preserveViewport = false,
): Promise<void> {
  if (!preserveViewport) await page.setViewportSize({ width: 1400, height: 1000 });
  else if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await page.getByRole("button", { name: "+ new doc" }).click();
  await page.locator(".ub-title").fill(`Contrast ${scheme}`);
  const uuid = new URL(page.url()).pathname.split("/")[2];
  const secret = await importRootSecret(harness().authSecret);
  const peers: Array<{ doc: Y.Doc; provider: HocuspocusProvider }> = [];
  const peer = async (room: string) => {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: harness().hubUrl,
      name: room,
      document: doc,
      token: async () => wrapToken(await mintToken(secret, {
        typ: "room", sub: randomUUID(), workspace: harness().workspaceUuid,
        scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      })),
    });
    peers.push({ doc, provider });
    await new Promise<void>((resolve) => provider.on("synced", resolve));
    return { doc, provider };
  };
  try {
    const { doc } = await peer(`${harness().workspaceUuid}/${uuid}`);
    appendBlock(doc, { type: "heading", level: 1, text: "Overview" });
    appendBlock(doc, { type: "heading", level: 2, text: "Details" });
    const resolved = appendBlock(doc, { type: "paragraph", text: "resolved range" });
    const thread = createAnnotation(doc, resolved, 0, 8, "Reviewer", "Resolved conversation");
    setAnnotationResolved(doc, thread.id, true);
    const orphan = appendBlock(doc, { type: "paragraph", text: "deleted range" });
    createAnnotation(doc, orphan, 0, 7, "Reviewer", "Orphaned conversation");
    deleteBlock(doc, orphan);
    appendBlock(doc, { type: "paragraph", inline: [
      { text: "waiting reference", marks: { docLink: randomUUID() } },
      { text: " on the page", marks: {} },
    ] });
    appendBlock(doc, { type: "code", language: "ts", text: "const answer = 42;" });
    appendBlock(doc, { type: "mermaid", text: "graph TD; A-->B" });
    appendBlock(doc, { type: "terminal", text: "$ ub init\nworkspace ready" });
    await expect(page.locator(".ub-terminal-screen")).toBeVisible();
    if ((page.viewportSize()?.width ?? 1280) >= 1280) {
      await expect(page.locator(".ub-thread")).toHaveCount(2);
    }
    const catalog = (await peer(settingsRoom(harness().workspaceUuid))).doc;
    seedTagCatalog(catalog);
    for (let index = 0; index < 6; index += 1) createTagCatalogEntry(catalog, `contrast-${index}`);
    const retired = createTagCatalogEntry(catalog, `retired-${scheme}-${randomUUID().slice(0, 8)}`);
    assignDocumentTags(doc, catalog, [retired.id]);
    retireTagCatalogEntry(catalog, retired.id);
    for (let index = 0; index < 4; index += 1) {
      const { provider } = await peer(`${harness().workspaceUuid}/${uuid}`);
      provider.setAwarenessField("user", { name: `Contrast peer ${index}`, color: "#0675c9" });
      provider.setAwarenessField("client", "agent");
    }
    await expect(page.locator(".ub-peer-more")).toBeVisible();
    await page.mouse.move(1399, 999);
    await prove();
  } finally {
    for (const { provider, doc } of peers) {
      provider.destroy();
      doc.destroy();
    }
  }
}

/** Compare states against their own rendering, without pinning theme values. */
function controlPaint(control: Locator): Promise<Record<string, string>> {
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    return Object.fromEntries([
      "background-color", "color", "border-color", "text-decoration-line",
      "opacity", "z-index", "outline-color", "outline-style", "outline-width",
    ].map((property) => [property, style.getPropertyValue(property)]));
  });
}

/** A touch engine need not synthesize :hover for a tap. Check its active rules too. */
function activeHoverRules(control: Locator): Promise<string[]> {
  return control.evaluate((element) => {
    const found: string[] = [];
    const inspect = (rules: CSSRuleList, parent?: string): void => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule && !matchMedia(rule.conditionText).matches) continue;
        if (rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue;
        if (rule instanceof CSSStyleRule) {
          const selector = parent === undefined ? rule.selectorText
            : rule.selectorText.replace(/&/g, `:is(${parent})`);
          if (rule.style.length > 0 && /(?<!\\):hover\b/.test(selector) &&
            element.matches(selector.replace(/(?<!\\):hover\b/g, ""))) {
            found.push(selector);
          }
          inspect(rule.cssRules, selector);
        } else if ("cssRules" in rule) inspect((rule as CSSGroupingRule).cssRules, parent);
      }
    };
    for (const sheet of document.styleSheets) inspect(sheet.cssRules);
    return found;
  });
}

for (const scheme of ["light"] as const) {
  test(`document and document-list controls keep resting paint after a touch tap — ${scheme}`, { tag: "@webkit-touch" }, async ({ browser }, info) => {
    const input = info.project.name === "chromium"
      ? { hasTouch: true, viewport: { width: 390, height: 844 } }
      : {};
    const page = await openApp(browser, "/", {
      upstream: true, contextOptions: { colorScheme: scheme, ...input }, readySelector: ".ub-docs",
    });
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    if (info.project.name !== "chromium") expect(page.viewportSize()).toEqual(info.project.use.viewport);
    await contrastDocument(page, scheme, async () => {
      await page.addStyleTag({ content: "* { transition: none !important; }" });
      const check = async (tap: Locator, paint = tap): Promise<void> => {
        await tap.scrollIntoViewIfNeeded();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        const before = await controlPaint(paint);
        const beforeFocus = await controlPaint(tap);
        // Keep this stylesheet proof independent of navigation, copy feedback,
        // pressed modes and open-menu paint. The input remains a real touch tap.
        await tap.evaluate((element) => {
          // DropdownMenu activates on pointerdown; leave the native default
          // intact while isolating both primitive and product activation.
          element.addEventListener("pointerdown", (event) => event.stopImmediatePropagation(), { capture: true, once: true });
          element.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
          }, { capture: true, once: true });
        });
        await tap.tap();
        await tap.evaluate((element) => (element as HTMLElement).blur());
        await expect.poll(() => controlPaint(paint)).toEqual(before);
        expect(await activeHoverRules(paint)).toEqual([]);
        // Keyboard focus remains visible on the same touch-capable context.
        await page.keyboard.press("ArrowRight");
        await tap.focus();
        expect(await tap.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        expect(await controlPaint(tap)).not.toEqual(beforeFocus);
        if (await tap.evaluate((element) => element.matches(".ub-copy, .ub-terminal-toggle"))) {
          expect((await controlPaint(tap)).color).not.toBe(beforeFocus.color);
        }
      };
      for (const selector of [".ub-sync-toggle", ".ub-copy-link", ".ub-actions-trigger"]) {
        await check(page.locator(selector));
      }
      await check(page.getByRole("button", { name: "Edit tags" }), page.locator(".ub-tag-chevron"));
      for (const peer of await page.locator(".ub-peer-control").all()) await check(peer);
      await page.locator(".ub-peer-more").tap();
      await check(page.locator(".ub-peer-overflow-row").first());
      await page.keyboard.press("Escape");
      for (const selector of [".ub-code .ub-copy", ".ub-mermaid .ub-copy", ".ub-terminal .ub-copy", ".ub-terminal-toggle"]) {
        await check(page.locator(selector));
      }
      if ((page.viewportSize()?.width ?? 1280) < 1280) {
        await page.getByRole("button", { name: "Show document list", exact: true }).click();
      }
      await page.getByRole("button", { name: "All docs", exact: true }).click();
      for (const selector of [".ub-docs-mode", ".ub-docs-sort"]) {
        for (const control of await page.locator(selector).all()) await check(control);
      }
      const row = page.locator(".ub-docs-row").first();
      // The pin's hover/reveal treatment belongs to #1108 and is not sampled.
      await check(row.locator(".ub-docs-open"), row);
    }, true);
    const waiting = await openApp(browser, `/${harness().workspace}/${randomUUID()}`, {
      upstream: true, contextOptions: { colorScheme: scheme, ...input }, readySelector: ".ub-notice",
    });
    expect(await waiting.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    const copy = waiting.getByRole("button", { name: /^Copy link/ });
    const before = await controlPaint(copy);
    await copy.tap();
    await expect(waiting.locator(".ub-copied")).not.toHaveText("");
    await copy.evaluate((element) => (element as HTMLElement).blur());
    await expect.poll(() => controlPaint(copy)).toEqual(before);
    expect(await activeHoverRules(copy)).toEqual([]);
  });

  test(`document hover cues still respond to a pointer — ${scheme}`, async ({ browser }) => {
    const page = await openAppearanceApp(browser, scheme);
    await contrastDocument(page, scheme, async () => {
      expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(true);
      await page.addStyleTag({ content: "* { transition: none !important; }" });
      for (const selector of [".ub-sync-toggle", ".ub-copy-link", ".ub-actions-trigger", ".ub-tag-chevron"]) {
        const control = page.locator(selector);
        await page.mouse.move(1399, 999);
        const before = await controlPaint(control);
        await control.hover();
        expect(await controlPaint(control)).not.toEqual(before);
      }
      const actions = page.locator(".ub-actions-trigger");
      await actions.hover();
      const hoveredAction = await controlPaint(actions);
      await actions.click();
      await expect(actions).toHaveAttribute("data-state", "open");
      await page.mouse.move(1399, 999);
      expect(await controlPaint(actions)).toEqual(hoveredAction);
      await page.keyboard.press("Escape");
      await actions.evaluate((element) => (element as HTMLElement).blur());
      const peers = page.locator(".ub-peer-control");
      await page.mouse.move(1399, 999);
      const stacking = await peers.evaluateAll((elements) => elements.slice(0, 3).map((element) => Number(getComputedStyle(element).zIndex)));
      expect(stacking[0]).toBeGreaterThan(stacking[1] ?? Infinity);
      expect(stacking[1]).toBeGreaterThan(stacking[2] ?? Infinity);
      const second = peers.nth(1);
      await second.hover();
      expect(Number(await paintedIn(second, "z-index"))).toBeGreaterThan(Math.max(...stacking));
      await page.mouse.move(1399, 999);
      await second.focus();
      await page.keyboard.press("ArrowRight");
      expect(Number(await paintedIn(second, "z-index"))).toBeGreaterThan(Math.max(...stacking));
      await second.evaluate((element) => (element as HTMLElement).blur());
      for (const selector of [".ub-code", ".ub-mermaid", ".ub-terminal"]) {
        const block = page.locator(selector);
        const copy = block.locator(".ub-copy");
        await page.mouse.move(1399, 999);
        const before = await controlPaint(copy);
        await block.hover();
        const revealed = await controlPaint(copy);
        expect(revealed).not.toEqual(before);
        await copy.hover();
        expect(await controlPaint(copy)).toEqual(revealed);
      }
      await page.getByRole("button", { name: "All docs", exact: true }).click();
      const selected = page.locator(".ub-docs-mode[aria-pressed=true]");
      await page.mouse.move(1399, 999);
      const selectedPaint = await controlPaint(selected);
      await selected.hover();
      expect(await controlPaint(selected)).toEqual(selectedPaint);
      for (const selector of [".ub-docs-mode[aria-pressed=false]", ".ub-docs-sort", ".ub-docs-row"]) {
        const control = page.locator(selector).first();
        await page.mouse.move(1399, 999);
        const before = await controlPaint(control);
        await control.hover();
        expect(await controlPaint(control)).not.toEqual(before);
      }
    });
  });
}

/**
 * The table holds token floors. Only rendered state can show the one card fill
 * reaching every consumer, or a later rule changing a chip's focused ground.
 * Seed both thread states through schema operations; no reload or key deletion
 * is needed to make an orphan, the intermittent setup removed before v0.3.
 */
for (const scheme of ["light"] as const) {
  test(`card highlights share one fill and keep their rendered floors — ${scheme}`, async ({ browser }) => {
    const page = await openAppearanceApp(browser, scheme);
    await page.setViewportSize({ width: 1000, height: 1000 });
    await contrastDocument(page, scheme, async () => {
      await page.addStyleTag({ content: "* { transition: none !important; }" });
      const tokens = await page.evaluate(() => {
        const probe = document.createElement("span");
        document.body.append(probe);
        probe.style.backgroundColor = "var(--card)";
        const card = getComputedStyle(probe).backgroundColor;
        probe.style.backgroundColor = "var(--card-accent)";
        const accent = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { card, accent };
      });
      const check = async (control: Locator, ground = tokens.card) => {
        await expect(control).toBeVisible();
        const fill = await paintedIn(control, "background-color");
        expect(fill, "one card-accent fill").toBe(tokens.accent);
        expect(separation(fill, ground)).toBeGreaterThanOrEqual(cardHighlightFloor[scheme]);
        const text = await renderedText(page, await control.evaluate((element) => {
          element.setAttribute("data-contrast-highlight", "");
          return "[data-contrast-highlight]";
        }));
        await control.evaluate((element) => element.removeAttribute("data-contrast-highlight"));
        expect(text.length).toBeGreaterThan(0);
        for (const reading of text) expect(reading.ratio, JSON.stringify(reading)).toBeGreaterThanOrEqual(4.5);
      };
      const handle = page.locator(".ub-threads-toggle");
      await check(handle);
      await handle.click();
      const resolved = page.locator(".ub-thread-resolved");
      await expect(resolved).toBeVisible();
      const card = await paintedIn(resolved, "background-color");
      expect(card).toBe(tokens.card);
      await check(resolved.locator(".ub-chip"), card);
      const orphan = page.locator(".ub-thread-orphaned");
      const chip = orphan.locator(".ub-chip-orphaned");
      await expect(chip).toBeVisible();
      const restingGround = await paintedIn(orphan, "background-color");
      const restingFill = await paintedIn(chip, "background-color");
      expect(contrast(await paintedIn(chip, "color"), restingFill)).toBeGreaterThanOrEqual(4.5);
      await orphan.click();
      await expect(orphan).toHaveAttribute("aria-current", "true");
      const focusedGround = await paintedIn(orphan, "background-color");
      const focusedFill = await paintedIn(chip, "background-color");
      const focusedStep = separation(focusedFill, focusedGround);
      expect(focusedStep).toBeGreaterThanOrEqual(focusedOrphanedChipFloor[scheme]);
      expect(focusedStep).toBeGreaterThanOrEqual(separation(restingFill, restingGround));
      expect(contrast(await paintedIn(chip, "color"), focusedFill)).toBeGreaterThanOrEqual(4.5);
      await page.getByRole("button", { name: "Close threads", exact: true }).click();
      await expect(handle).toBeFocused();

      await page.locator(".ub-editor .ub-paragraph").first().click();
      await placeCaret(page);
      await page.keyboard.type("/");
      const menu = page.getByRole("listbox", { name: "Block types" });
      await expect(menu).toBeVisible();
      const menuGround = await paintedIn(page.locator('[data-slot="caret-menu-content"]').filter({ has: menu }), "background-color");
      expect(menuGround).toBe(tokens.card);
      await check(menu.getByRole("option", { selected: true }), menuGround);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Backspace");
      await page.keyboard.type("highlight range");
      for (let index = 0; index < "highlight range".length; index += 1) await page.keyboard.press("Shift+ArrowLeft");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      const composer = page.locator('[data-slot="selection-composer"]');
      await expect(composer).toBeVisible();
      const composerGround = await paintedIn(composer, "background-color");
      expect(composerGround).toBe(tokens.card);
      await check(composer.getByRole("button", { name: "Cancel", exact: true }), composerGround);
      await check(composer.locator(".ub-mention").first(), composerGround);
      // The submit keeps the separate brand emphasis.
      expect(await paintedIn(composer.getByRole("button", { name: "Comment", exact: true }), "background-color")).not.toBe(tokens.accent);
      await composer.getByRole("button", { name: "Cancel", exact: true }).click();
    }, true);
  });
}

for (const scheme of ["light"] as const) {
  // Tokens cannot observe later panel overrides; axe omits strokes, placeholders and highlight steps.
  test(`document menus keep sidebar contrast and a full-row highlight — ${scheme}`, async ({ browser }) => {
    const page = await openAppearanceApp(browser, scheme);
    await contrastDocument(page, scheme, async () => {
      const ground = await painted(page, ".ub-list", "background-color");
      const edge = await painted(page, ".ub-list", "border-right-color");
      await page.locator(".ub-workspace").hover();
      const sidebarHighlight = await painted(page, ".ub-workspace", "background-color");
      const step = separation(sidebarHighlight, ground);
      const floor = scheme === "light" ? separation(edge, ground) : contrast(edge, ground);
      const check = async (root: string) => {
        expect(await painted(page, root, "background-color")).toBe(ground);
        // The cascade constraint is stronger than today's colour ratios: no
        // unlayered product paint may override a vendored panel state later.
        const overrides = await page.locator(root).evaluate((panel) => {
          const elements = [panel, ...panel.querySelectorAll("*")];
          const found: string[] = [];
          const inspect = (rules: CSSRuleList): void => {
            for (const rule of rules) {
              if (rule.cssText.startsWith("@layer")) continue;
              if (rule instanceof CSSMediaRule && !matchMedia(rule.conditionText).matches) continue;
              if (rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue;
              if (rule instanceof CSSStyleRule) {
                const selector = rule.selectorText.replace(/::(?:before|after|placeholder|marker)\b/g, "");
                if (!elements.some((element) => element.matches(selector))) continue;
                const paint = [...rule.style].filter((property) =>
                  property === "color" || property === "fill" || property === "stroke" ||
                  property.startsWith("background") || property.startsWith("border") ||
                  property.startsWith("outline"),
                );
                if (paint.length > 0) found.push(`${rule.selectorText}: ${paint.join(", ")}`);
              } else if ("cssRules" in rule) {
                inspect((rule as CSSGroupingRule).cssRules);
              }
            }
          };
          for (const sheet of document.styleSheets) inspect(sheet.cssRules);
          return found;
        });
        expect(overrides, "unlayered paint inside the panel").toEqual([]);
        const text = await renderedText(page, root);
        expect(text.length).toBeGreaterThan(0);
        for (const reading of text) expect(reading.ratio, JSON.stringify(reading)).toBeGreaterThanOrEqual(4.5);
        for (const reading of (await surface(page, root)).filter((one) => one.kind === "stroke")) {
          if (oklab(reading.colour).chroma > accentChroma || reading.where.endsWith(" outline")) continue;
          const strength = scheme === "light"
            ? await strokeSeparation(page, reading.colour, reading.ground) : contrast(reading.colour, reading.ground);
          expect(strength, JSON.stringify(reading)).toBeGreaterThanOrEqual(floor);
        }
        // Borders alone miss the search icon's neutral SVG strokes.
        for (const shape of await page.locator(`${root} svg [stroke]`).all()) {
          const ink = await paintedIn(shape, "stroke");
          if (ink === "none" || oklab(ink).chroma > accentChroma) continue;
          for (const under of await groundsUnder(page, shape)) {
            const strength = scheme === "light"
              ? await strokeSeparation(page, ink, under) : contrast(ink, under);
            expect(strength, `SVG ${ink} on ${under}`).toBeGreaterThanOrEqual(floor);
          }
        }
      };
      const contents = page.getByRole("button", { name: "Contents 2" });
      await contents.click();
      await expect(page.locator(".ub-outline-panel")).toBeVisible();
      await check(".ub-outline-panel");
      const row = page.locator(".ub-outline-panel [role=menuitem]").first();
      await row.hover();
      expect(separation(await paintedIn(row, "background-color"), ground)).toBeGreaterThanOrEqual(step);
      const [rowBox, listBox] = await Promise.all([row.boundingBox(), page.locator(".ub-outline-panel ul").boundingBox()]);
      expect(rowBox?.width).toBeCloseTo(listBox?.width ?? 0, 1);
      await check(".ub-outline-panel");
      await page.keyboard.press("Escape");
      await page.mouse.move(1399, 999);
      await contents.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
      const keyboardRow = page.locator(".ub-outline-panel [role=menuitem]").nth(1);
      await expect.poll(async () => {
        const fill = await paintedIn(keyboardRow, "background-color");
        return alphaOf(fill) === 0 ? 0 : separation(fill, ground);
      }).toBeGreaterThanOrEqual(step);
      await check(".ub-outline-panel");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Document actions" }).click();
      await page.getByRole("menuitem", { name: "Pin to sidebar" }).click();
      await page.getByRole("button", { name: "Document actions" }).click();
      const actions = "[data-slot=dropdown-menu-content]";
      await check(actions);
      for (const item of await page.locator(`${actions} [role=menuitem]`).all()) {
        await item.hover();
        await check(actions);
      }
      const danger = await painted(page, ".ub-action-danger", "color");
      const red = oklab(danger);
      expect(red.a).toBeGreaterThan(0.05);
      expect(red.b).toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await page.locator(".ub-tags").click();
      const picker = ".ub-tag-picker-panel";
      await expect(page.getByPlaceholder("Search tags")).toBeVisible();
      await check(picker);
      // Include every option's neutral check box over the highlighted ground,
      // and the retired small text, rather than only reading a panel at rest.
      for (const option of await page.locator(`${picker} [role=option]`).all()) {
        await option.hover();
        await check(picker);
      }
      await page.getByPlaceholder("Search tags").fill("no matching tag");
      await expect(page.locator(".ub-tag-empty")).toBeVisible();
      await check(picker);
    });
  });

  // Actual grounds and CSS opacity can change without any token changing; axe omits gradient/pseudo text.
  test(`muted text and enabled dimmed consumers meet their rendered floors — ${scheme}`, async ({ browser }, testInfo) => {
    const page = await openAppearanceApp(browser, scheme);
    await contrastDocument(page, scheme, async () => {
      await page.addStyleTag({ content: "* { transition: none !important; }" });
      const readings: Awaited<ReturnType<typeof renderedText>> = [];
      const collect = async (root = "body") => readings.push(...await renderedText(page, root, { mutedOnly: true }));
      await collect();
      await page.getByRole("button", { name: "Contents 2" }).click();
      await collect();
      await page.keyboard.press("Escape");
      await page.locator(".ub-sync-toggle").click();
      await collect();
      await page.locator(".ub-sync-toggle").click();
      await page.locator(".ub-peer-more").click();
      await collect();
      for (const row of await page.locator(".ub-peer-overflow-row").all()) {
        await row.hover();
        await collect();
      }
      await page.keyboard.press("Escape");
      await page.locator(".ub-editor .ub-paragraph").first().hover();
      await page.getByRole("button", { name: "Insert block below" }).click();
      await collect();
      for (const option of await page.locator(".ub-blockmenu [role=option]").all()) {
        await option.hover();
        await collect();
      }
      await page.keyboard.press("Escape");
      const enabled: Awaited<ReturnType<typeof renderedText>> = [];
      for (const kind of ["code", "mermaid"]) {
        const copy = `.ub-${kind} .ub-copy`;
        await page.mouse.move(1399, 999);
        enabled.push(...await renderedText(page, copy));
      }
      for (const state of ["resolved", "orphaned"]) {
        const root = `.ub-thread-card:has(.ub-thread-${state})`;
        const card = page.locator(`.ub-thread-${state}`);
        await page.mouse.move(1399, 999);
        enabled.push(...await renderedText(page, root));
        await card.hover();
        enabled.push(...await renderedText(page, root));
        await card.click();
        await card.focus();
        await expect(card).toHaveAttribute("aria-current", "true");
        enabled.push(...await renderedText(page, root));
        await collect();
        if (state === "resolved") {
          // Keep the conversation expanded while removing its selected ground,
          // so enabled author/time/body text is also read at rest and hovered.
          await page.locator(".ub-thread-orphaned").click();
          await page.mouse.move(1399, 999);
          enabled.push(...await renderedText(page, root));
          await card.hover();
          enabled.push(...await renderedText(page, root));
        }
      }
      await page.getByRole("button", { name: "All docs", exact: true }).click();
      await collect();
      for (const row of await page.locator(".ub-docs-row").all()) {
        await row.hover();
        await collect();
      }
      await testInfo.attach(`rendered-${scheme}`, { body: JSON.stringify({ muted: readings, enabled }, null, 2), contentType: "application/json" });
      const minima = new Map<string, (typeof readings)[number]>();
      for (const reading of readings) {
        const key = `${reading.ground} / ${reading.opacity}`;
        if ((minima.get(key)?.ratio ?? Infinity) > reading.ratio) minima.set(key, reading);
      }
      console.log(`Rendered ${scheme} minima: ${JSON.stringify([...minima.values()])}`);
      if (scheme === "light") {
        const fullStrength = readings.filter((one) => one.opacity === 1 &&
          (legacySrgb(one.ground) ?? []).every((channel) => channel > 0.7));
        const limits = fullStrength.map((reading) => {
          return { where: reading.where, ground: reading.ground, lightness: lightnessLimit(reading.ground) };
        }).sort((one, two) => one.lightness - two.lightness);
        console.log(`Rendered light limiting reading: ${JSON.stringify(limits[0])}`);
        const current = fullStrength[0];
        if (current === undefined || limits[0] === undefined) throw new Error("no full-strength light muted reading");
        // Choose only the darkening the rendered grounds require, at the
        // token's thousandth precision. Consumer opacity cannot choose it.
        const extra = limits[0].lightness - oklab(current.colour).L;
        expect(extra).toBeGreaterThanOrEqual(0);
        expect(extra).toBeLessThan(0.001);
      }
      expect(readings.length).toBeGreaterThan(0);
      expect(enabled.length).toBeGreaterThan(0);
      // Dark global ink is intentionally unchanged; its enabled opacity
      // consumers still have the same AA requirement as light's.
      for (const reading of [...(scheme === "light" ? readings : []), ...enabled]) {
        expect(reading.ratio, JSON.stringify(reading)).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
}

// Tokens and axe cannot observe a positioned sibling screen or the controls' opacity/focus cascade.
// The screen is deliberately dark in both appearances. Compare each light
// control to the corresponding dark rendering, including opacity and focus.
test("terminal controls keep their dark-screen contrast in either appearance", async ({ browser }, testInfo) => {
  const page = await openAppearanceApp(browser, "dark");
  await contrastDocument(page, "dark", async () => {
    await page.addStyleTag({ content: "* { transition: none !important; }" });
    const readings: Record<string, Awaited<ReturnType<typeof renderedText>>> = {};
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const selector of [".ub-terminal-toggle", ".ub-terminal .ub-copy"]) {
        const control = page.locator(selector);
        for (const state of ["rest", "hover", "focus"] as const) {
          await page.mouse.move(1399, 999);
          await page.locator(".ub-title").focus();
          if (state === "hover") await control.hover();
          if (state === "focus") {
            await control.focus();
            await page.keyboard.press("ArrowRight");
            expect(await control.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
          }
          readings[`${scheme} ${selector} ${state}`] = await renderedText(page, selector);
        }
      }
    }
    console.log(`Terminal readings: ${JSON.stringify(readings)}`);
    await testInfo.attach("terminal-controls", { body: JSON.stringify(readings, null, 2), contentType: "application/json" });
    for (const [key, values] of Object.entries(readings)) {
      const floor = key.endsWith("rest")
        ? key.includes("ub-copy") ? 3.317915 : 7.054520
        : 17.521906;
      expect(values[0]?.ratio, key).toBeGreaterThanOrEqual(floor);
    }
    for (const [key, light] of Object.entries(readings).filter(([key]) => key.startsWith("light"))) {
      const dark = readings[key.replace(/^light/, "dark")];
      expect(light.length).toBe(1);
      expect(dark?.length).toBe(1);
      expect(legacySrgb(light[0]?.ground ?? "")).toEqual(legacySrgb(await painted(page, ".ub-terminal-screen", "background-color")));
      expect(light[0]?.ratio).toBeGreaterThanOrEqual(dark?.[0]?.ratio ?? Infinity);
    }
  });
});

/** Touch paths for information formerly available only on hover (#1071). */
const LONG_NAME = "Alexandria Montgomery · Engineering collaboration session on the production workspace";
const UNBROKEN_NAME = "Collaborator".repeat(12);

for (const [device, width, hasTouch] of [
  ["iPhone", 375, true],
  ["MacBook", 1366, false],
] as const) {
  test(`hover information has a ${device} path`, async ({ browser }) => {
    const page = await openApp(browser, "/", {
      upstream: true,
      contextOptions: { viewport: { width, height: 900 }, hasTouch },
    });
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(hasTouch);
    if (width < 1280) {
      await page.getByRole("button", { name: "Show document list", exact: true }).click();
    }
    for (const destination of ["Dashboard", "Product requirements"]) {
      const row = page.getByRole("button", { name: new RegExp(`${destination}.*coming soon`, "i") });
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("aria-disabled", "true");
    }
    const uuid = await createDoc(page, `Hover paths ${device}`);
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: harness().hubUrl,
      name: `${harness().workspaceUuid}/${uuid}`,
      document: doc,
      token: async () => wrapToken(await mintToken(await importRootSecret(harness().authSecret), {
        typ: "room",
        sub: "hover-proof-agent",
        workspace: harness().workspaceUuid,
        scope: "read-write",
        kid: null,
        lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      })),
    });
    try {
      await new Promise<void>((resolve) => provider.on("synced", resolve));
      for (let index = 0; index < 28; index += 1) {
        appendBlock(doc, { type: "paragraph", text: `Collaboration paragraph ${index}` });
      }
      await expect(page.locator(".ub-editor .ProseMirror > *")).toHaveCount(29);
      provider.setAwarenessField("user", { name: LONG_NAME, color: "#0675c9" });
      provider.setAwarenessField("client", "agent");
      const block = getBlocksFragment(doc).get(28);
      if (!(block instanceof Y.XmlElement) || !(block.firstChild instanceof Y.XmlText)) {
        throw new Error("last block has no text");
      }
      const anchor = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(block.firstChild, 1));
      provider.setAwarenessField("cursor", { anchor, head: anchor });
      // Match the product's complete label without depending on punctuation.
      const peer = page.locator(".ub-peer-control[data-peer-id]").filter({ has: page.locator(".ub-avatar-agent-badge") });
      await expect(peer).toHaveCount(1);
      await expect(peer).toHaveAccessibleName(/Alexandria Montgomery.*agent.*29/);
      if (hasTouch) {
        await peer.tap();
        await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
        await expect.poll(() => page.locator(".ub-pane").evaluate((pane) => pane.scrollTop)).toBeGreaterThan(0);
        await page.locator(".ub-pane").evaluate((pane) => { pane.scrollTop = 0; });
      }
      const updated = page.locator(".ub-last-updated time");
      await expect(updated).toBeVisible();
      const exact = await updated.getAttribute("title");
      const stamp = await updated.getAttribute("datetime");
      const sync = page.getByRole("button", { name: /^Sync details/ });
      if (hasTouch) await sync.tap();
      else { await sync.focus(); await page.keyboard.press("Enter"); }
      const panel = page.getByRole("dialog", { name: "Sync and presence" });
      await expect(panel).toBeVisible();
      await expect(panel.locator("dt", { hasText: "Last updated" }).locator("..").locator("time")).toHaveText(exact ?? "");
      await expect(panel.locator("time")).toHaveAttribute("datetime", stamp ?? "");
      const checkName = async (name: string): Promise<void> => {
        const text = panel.locator(".ub-presence-name");
        await expect(text).toHaveText(name);
        const layout = await text.evaluate((element) => {
          const nameBox = element.getBoundingClientRect();
          const panel = element.closest('[role="dialog"]');
          if (panel === null) throw new Error("name has no panel");
          const panelBox = panel.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          const blockBox = element.nextElementSibling?.getBoundingClientRect();
          return {
            fits: element.scrollWidth <= element.clientWidth + 1,
            wraps: range.getClientRects().length > 1,
            inside: nameBox.right <= panelBox.right && (blockBox === undefined || blockBox.right <= panelBox.right),
          };
        });
        expect(layout).toEqual({ fits: true, wraps: true, inside: true });
      };
      await checkName(LONG_NAME);
      await expect(panel.getByText("block 29", { exact: true })).toBeVisible();
      // The same panel is also the full-name path when there is no caret to reveal.
      provider.setAwarenessField("cursor", null);
      provider.setAwarenessField("user", { name: UNBROKEN_NAME, color: "#0675c9" });
      await checkName(UNBROKEN_NAME);
      await expect(panel.getByText("block 29", { exact: true })).toHaveCount(0);
      // The popover stays contained at each device width, including a reduced
      // available height where its unchanged facts and names need to scroll.
      for (const height of [900, 430]) {
        await page.setViewportSize({ width, height });
        await expect.poll(async () => {
          const box = await panel.boundingBox();
          return box !== null && box.x >= 0 && box.y >= 0 &&
            box.x + box.width <= width && box.y + box.height <= height;
        }).toBe(true);
      }
      await expect.poll(() => panel.evaluate((element) =>
        element.scrollHeight > element.clientHeight,
      )).toBe(true);
      await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      expect(await panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    } finally {
      provider.destroy();
      doc.destroy();
    }
  });
}

test("unavailable Restore and pin reasons are visible on touch", async ({ browser }) => {
  const page = await openApp(browser, "/", {
    upstream: true,
    contextOptions: { viewport: { width: 375, height: 900 }, hasTouch: true },
  });
  await page.getByRole("button", { name: "Show document list", exact: true }).click();
  await createDoc(page, "Still listed");
  await page.getByRole("button", { name: "Show document list", exact: true }).click();
  await createDoc(page, "Archived reason");
  await page.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Archive document" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive document" }).click();
  await expect(page.locator(".ub-archived-banner")).toBeVisible();
  await harness().stopHub();
  try {
    await expect(page.getByRole("button", { name: "Restore unavailable" })).toBeDisabled();
    await expect(page.locator(".ub-restore-unavailable")).toBeVisible();
    await expect(page.locator(".ub-restore-unavailable")).toContainText("directory is not ready to write");
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
    await page.getByRole("button", { name: "All docs", exact: true }).click();
    await expect(page.locator(".ub-docs-pin-unavailable")).toBeVisible();
    await expect(page.locator(".ub-docs-pin-unavailable")).toContainText("sidebar is not ready to write");
    await expect(page.locator(".ub-docs-pin").first()).toBeDisabled();
  } finally {
    await harness().startHub();
  }
});

test("decision archive and restore follow the whole topic and its first record", async ({ browser }) => {
  const first = randomUUID();
  const successor = randomUUID();
  const running = harness();
  const secret = await importRootSecret(running.authSecret);
  const peers: Array<{ doc: Y.Doc; provider: HocuspocusProvider }> = [];
  async function peer(room: string): Promise<Y.Doc> {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: running.hubUrl,
      name: room,
      document: doc,
      token: async () => wrapToken(await mintToken(secret, {
        typ: "room", sub: randomUUID(), workspace: running.workspaceUuid,
        scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      })),
    });
    peers.push({ doc, provider });
    await new Promise<void>((resolve) => provider.on("synced", resolve));
    return doc;
  }
  try {
    const directory = await peer(directoryRoom(running.workspaceUuid));
    const sidebar = await peer(sidebarRoom(running.workspaceUuid));
    for (const uuid of [first, successor]) {
      const doc = await peer(roomForDoc(running.workspaceUuid, uuid));
      initDoc(doc, {
        uuid, title: uuid === first ? "Original lease" : "Proposed lease",
        topic: first,
        ...(uuid === successor ? { supersedes: first } : {}),
      });
      setKind(doc, "decision");
      appendBlock(doc, { type: "paragraph", text: "Lease reasoning stays readable." });
      upsertDirectoryEntry(directory, {
        uuid, title: uuid === first ? "Original lease" : "Proposed lease",
        kind: "decision", status: "open", ...decisionDirectoryFields(doc),
      });
    }
    const group = createGroup(sidebar, "Reading");
    pinDoc(sidebar, group, first);
    pinDoc(sidebar, group, successor);
    const page = await openApp(browser, `/${running.workspace}/${successor}`);
    const earlier = await openApp(browser, `/${running.workspace}/${first}`);
    const map = getDirectoryMap(directory);

    // A mirror-only tombstone leaves a successor writable and archivable.
    map.set(successor, { ...(map.get(successor) as object), deleted: true });
    await expect(page.getByRole("button", { name: "Document actions" })).toBeVisible();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await page.getByRole("button", { name: "Document actions" }).click();
    await page.getByRole("menuitem", { name: "Archive document" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Archive document" }).click();
    await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
    await expect(earlier.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
    await expect.poll(() => readSidebar(sidebar).find((entry) => entry.id === group)?.docs).toEqual([]);
    await expect.poll(() => getDirectoryEntry(directory, first)?.deleted).toBe(true);
    await expect.poll(() => getDirectoryEntry(directory, successor)?.deleted).toBe(true);
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");

    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await expect(editor(earlier)).toHaveAttribute("contenteditable", "true");
    await expect.poll(() => getDirectoryEntry(directory, first)?.deleted).toBeUndefined();
    await expect.poll(() => getDirectoryEntry(directory, successor)?.deleted).toBeUndefined();

    // A partial archive's first tombstone alone gates every record's writes.
    map.set(first, { ...(map.get(first) as object), deleted: true });
    await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await expect(page.locator(".ub-title")).toHaveAttribute("readonly", "");
    expect(getDirectoryEntry(directory, successor)?.deleted).toBeUndefined();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await expect(editor(earlier)).toHaveAttribute("contenteditable", "true");
  } finally {
    for (const { provider, doc } of peers.reverse()) {
      provider.destroy();
      doc.destroy();
    }
  }
});
