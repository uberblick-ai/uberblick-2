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

/**
 * A painted colour in OKLab. Every token measured below is written `oklch()`
 * and Chromium's computed value keeps that space, so this is polar-to-
 * rectangular arithmetic and nothing is quantised on the way. A serialization
 * that is not `oklch()` throws rather than guesses: a wrong number here would
 * look like a passing measurement.
 */
function oklab(painted: string): { L: number; a: number; b: number } {
  // `none` is how an achromatic colour reports the hue it does not have.
  const parts =
    /^oklch\((\d*\.?\d+) (\d*\.?\d+) (\d*\.?\d+|none)\)$/.exec(painted.trim());
  const [, rawL, rawC, rawH] = parts ?? [];
  if (rawL === undefined || rawC === undefined || rawH === undefined) {
    throw new Error(`not an oklch colour: ${painted}`);
  }
  const chroma = Number(rawC);
  const radians = ((rawH === "none" ? 0 : Number(rawH)) * Math.PI) / 180;
  return {
    L: Number(rawL),
    a: chroma * Math.cos(radians),
    b: chroma * Math.sin(radians),
  };
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

for (const scheme of ["light", "dark"] as const) {
  test(`a card-grounded highlight steps off its ground — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openApp(browser, scheme);
    // Under the rail's 1100px breakpoint, which is the only width where the
    // threads handle is on screen to be measured at all.
    await page.setViewportSize({ width: 1000, height: 800 });

    // The header is `--card`, and the toggle that lives in it is the first of
    // the three.
    const header = await painted(page, ".ub-header", "background-color");
    const toggle = await painted(page, ".ub-sidebar-toggle", "background-color");
    expect(separation(toggle, header)).toBeGreaterThanOrEqual(
      cardHighlightFloor[scheme],
    );

    // The second: the block menu is its own `--card` floating over the prose,
    // and one entry carries the highlight from the moment it opens.
    await page.getByRole("button", { name: "+ new doc" }).click();
    await expect(page.locator(".ub-editor .ub-paragraph")).toBeVisible();
    await page.locator(".ub-editor .ProseMirror").click();
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

    // The third: the drawer's handle appears once the document has a thread,
    // so the measurement needs a real one.
    await page.keyboard.type("annotate me", { delay: 15 });
    await page.keyboard.press("Shift+Home");
    await page.locator(".ub-composer-open").click();
    await page.keyboard.type("a thread", { delay: 15 });
    await page.keyboard.press("Enter");
    const handle = page.locator(".ub-threads-toggle");
    await expect(handle).toBeVisible();
    const drawer = await paintedIn(handle, "background-color");
    expect(separation(drawer, header)).toBeGreaterThanOrEqual(
      cardHighlightFloor[scheme],
    );

    // And it is one answer rather than three: the same painted fill, whichever
    // `--card` surface it lands on.
    expect(entry).toBe(toggle);
    expect(drawer).toBe(toggle);
  });
}

/**
 * The copy-link control's touch target (#535).
 *
 * A browser, because both halves of the claim are layout: the identity row is a
 * single fixed line of 0.75rem text, and the control in it has to be big enough
 * for a thumb on an iPad without making that row 44px tall and pushing the
 * title down. The target is therefore a pseudo-element over the button, which
 * is exactly the kind of thing jsdom reports nothing about — it has no layout
 * and no `::after` box to measure, and a click 8px above an element there means
 * nothing.
 */
test("the copy-link control is a 44px target in a row that stays its own height", async ({
  browser,
}) => {
  const page = await openApp(browser, "light");
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-editor .ub-paragraph")).toBeVisible();

  const target = await page.evaluate(() => {
    const button = document.querySelector(".ub-copy-link");
    if (button === null) throw new Error("e2e: no copy-link control on the page");
    const painted = getComputedStyle(button, "::after");
    return {
      width: Number.parseFloat(painted.width),
      height: Number.parseFloat(painted.height),
    };
  });
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);

  const row = await page.locator(".ub-doc-meta").boundingBox();
  const button = await page.locator(".ub-copy-link").boundingBox();
  if (row === null || button === null) throw new Error("e2e: the row has no box");
  // The row is still the single short line it was: the target overhangs it
  // rather than setting its height.
  expect(row.height).toBeLessThan(44);

  // And the overhang is live, not merely painted: a tap above the button's own
  // box still reaches it. Either word in the confirmation proves the click
  // landed — which of the two clipboard paths ran is not what this is about.
  await page.mouse.click(button.x + button.width / 2, button.y - 8);
  await expect(page.locator(".ub-copied")).not.toBeEmpty();
});
