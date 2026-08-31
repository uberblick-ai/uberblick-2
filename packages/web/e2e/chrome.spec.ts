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
 * - **A surface is measured, not a selector list.** The sidebar's interior is
 *   held to its own strokes and to WCAG AA by walking what the column and its
 *   two menus actually paint — which needs a cascade, a `light-dark()` and a
 *   layout, and is what a list of rules checked one at a time missed (#515).
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

/**
 * The app in its own context, at `path` — `/`, and the workspace the harness
 * configured, unless a test names another address.
 *
 * The address is an argument rather than a second `goto`, because the dev
 * server's module graph is hundreds of requests and loading it twice in one
 * context exhausts the browser's sockets (`ERR_INSUFFICIENT_RESOURCES`) instead
 * of failing on anything the test is about.
 */
async function openApp(
  browser: Browser,
  colorScheme: "light" | "dark",
  path = "",
): Promise<Page> {
  const context = await browser.newContext({ colorScheme });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(new URL(path, harness().appUrl).href);
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

/**
 * A hover ground is an offer, and a disabled control has nothing to offer
 * (#529). Beside the loop above, because it asks the same kind of question of
 * the same column in the same two appearances.
 *
 * The sidebar's four row controls share one hover rule, and `+ new doc` is the
 * one of them that can be disabled: it creates into the directory room, and at
 * an address naming no workspace this client can use there is none. Only a
 * browser can be asked — `:hover` is a state nothing but a pointer sets, and
 * the ground it would paint is a `light-dark()` token — so the enabled control
 * beside it takes the same gesture, which is what makes "unchanged" mean the
 * rule missed it rather than that the measurement cannot see a change.
 */
for (const scheme of ["light", "dark"] as const) {
  test(`a disabled sidebar control keeps its ground under the pointer — ${scheme}`, async ({
    browser,
  }) => {
    const page = await openApp(browser, scheme, "not-a-workspace");
    const create = page.getByRole("button", { name: "+ new doc" });
    await expect(create).toBeDisabled();

    const disabled = await paintedIn(create, "background-color");
    await create.hover();
    expect(await paintedIn(create, "background-color")).toBe(disabled);

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
  const under = srgb(ground);
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

/** One colour a surface paints, and the ground it lands on. */
type Reading = {
  where: string;
  kind: "text" | "stroke";
  colour: string;
  ground: string;
  /**
   * Inside the current workspace's row — the one text this surface may paint in
   * the accent, and only until #569 answers for it. Carried on texts, which are
   * the only readings that exemption applies to.
   */
  current?: boolean;
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
          current: element.closest(".ub-menu-current") !== null,
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
 * paints sits at or under 0.015, and both accents — `--brand` and the 28% edge
 * derived from it — at 0.15 or above. The two populations are a tenfold apart,
 * and the threshold below sits about three times clear of each of them, so it is
 * a gap rather than a number picked to make something pass. What it buys differs
 * by kind, and the difference is #515's:
 *
 * - **A stroke above it is excluded, and the criterion says so** — "a stroke
 *   carrying its own meaning (`--brand`, a focus ring)". Meaning, not a named
 *   token: a list of accent rules would be the selector list this test exists
 *   not to be.
 * - **Ink has no such exclusion, so chroma alone must not let a text through.**
 *   A chromatic text has to *be* the accent, compared against what the wordmark
 *   is painted, *and* be the one text that is allowed to be: `.ub-menu-current`,
 *   the current workspace's row, at 1.93:1 in light. Naming it is the opposite
 *   of the selector list this test exists not to be — a coverage list fails open
 *   and omits silently, an exception list fails closed, so a second brand-inked
 *   text fails here instead of inheriting the carve-out, and the carve-out ends
 *   with the decision rather than outliving it. What reserves that one text is
 *   not #515: the reading is a property of `--brand` rather than of this surface
 *   (2.04 to 2.30:1 against every other light ground in the app), and a
 *   sidebar-private brand ink is what #569's own criterion forbids — open,
 *   `needs-decision`, unanswered.
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

    // And the accent as this page paints it, read off the wordmark — the app's
    // other `--brand` ink, so this is the same property resolved by the same
    // engine. It names the one text the loop below may let through.
    const accent = await painted(page, ".ub-brand", "color");

    // A group, so the header's rule, its count pill and the two quiet actions
    // are on screen. "+ group" makes one and opens its rename field, so the
    // column is read once with the field and once with the header.
    await page.getByRole("button", { name: "+ group" }).click();
    const readings = await surface(page, ".ub-list");
    await page.getByLabel("Group name").press("Enter");
    // `.first()` because the sidebar is one workspace shared by this file's
    // tests, so the appearance before this one has already left a group here.
    await expect(page.locator(".ub-group-toggle").first()).toBeVisible();
    readings.push(...(await surface(page, ".ub-list")));

    // Both anchored menus, each while it is open: they are portalled siblings
    // of the app, so nothing in the column reaches them and they carry their
    // own rules.
    await page.locator(".ub-workspace").click();
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

    for (const { where, kind, colour, ground: under, current } of readings) {
      const ink = oklab(colour);
      const seen = `${where} — ${colour} on ${under}`;
      if (ink.chroma > accentChroma) {
        if (kind === "text") {
          expect(colour, seen).toBe(accent);
          expect(current, seen).toBe(true);
        }
        continue;
      }
      if (kind === "text") {
        expect(contrast(colour, under), seen).toBeGreaterThanOrEqual(4.5);
      } else if (scheme === "dark") {
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

  // "No font CDN" is not checkable by naming CDNs, so it is checked as what it
  // is a case of: every font file this page fetched came from the app's own
  // origin, and Fraunces is among them.
  const fetched = await page.evaluate(() => {
    const fonts = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => /\.(woff2?|otf|ttf)(\?|$)/i.test(url));
    return {
      offOrigin: fonts.filter((url) => new URL(url).origin !== location.origin),
      fraunces: fonts.filter((url) => /fraunces/i.test(url)).length,
    };
  });
  expect(fetched.offOrigin).toEqual([]);
  expect(fetched.fraunces).toBeGreaterThan(0);
});
