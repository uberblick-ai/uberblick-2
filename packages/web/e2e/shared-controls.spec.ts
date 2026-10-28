/** Production CSS over the real components, including the unconsumed Textarea. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devices, expect, test } from "@playwright/test";
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { build, preview } from "vite";
import type { PreviewServer } from "vite";
import { activateControl } from "./input-helpers.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let scratch: string | null = null;
let server: PreviewServer | null = null;
let fixtureUrl = "";
let calloutFixtureUrl = "";
const contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  const started = performance.now();
  scratch = mkdtempSync(join(tmpdir(), `uberblick-controls-${process.env.UB_AGENTS_RUN ?? "local"}-`));
  const configFile = join(packageRoot, "vite.config.ts");
  await build({
    configFile,
    root: packageRoot,
    logLevel: "error",
    build: {
      outDir: scratch,
      emptyOutDir: true,
      rolldownOptions: { input: [
        join(packageRoot, "e2e/fixtures/controls.html"),
        join(packageRoot, "e2e/fixtures/callout-controls.html"),
      ] },
    },
  });
  server = await preview({
    configFile,
    root: packageRoot,
    logLevel: "error",
    build: { outDir: scratch },
    preview: { host: "127.0.0.1", port: 0 },
  });
  const base = server.resolvedUrls?.local[0];
  if (base === undefined) throw new Error("e2e: no fixture serving address");
  fixtureUrl = new URL("e2e/fixtures/controls.html", base).href;
  calloutFixtureUrl = new URL("e2e/fixtures/callout-controls.html", base).href;
  console.log(`e2e timing: controls fixture startup ${Math.round(performance.now() - started)} ms`);
});

test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

test.afterAll(async () => {
  const running = server;
  server = null;
  try {
    if (running !== null) {
      await new Promise<void>((resolveClose, reject) => {
        running.httpServer.close((error) => error === undefined ? resolveClose() : reject(error));
      });
    }
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  }
});

async function openFixture(browser: Browser, coarse: boolean, width: number): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    hasTouch: coarse,
    isMobile: coarse,
  });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(fixtureUrl);
  await expect(page.getByRole("button", { name: "default default", exact: true })).toBeVisible();
  // A touch-capable context alone is not a proof of the primary-pointer variant.
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(coarse);
  return page;
}

async function openCalloutFixture(browser: Browser, options: BrowserContextOptions): Promise<Page> {
  const context = await browser.newContext(options);
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(calloutFixtureUrl);
  await expect(page.locator("[data-callout-controls-ready=true]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Callout variant", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

function documentListUrl(scenario = "controls", state = "all"): string {
  const url = new URL(fixtureUrl);
  url.searchParams.set("document-list", scenario);
  url.searchParams.set("state", state);
  return url.href;
}

async function openDocumentListFixture(browser: Browser, touch: boolean, scenario = "controls", width = 1440): Promise<Page> {
  const context = await browser.newContext(touch ? devices["iPad (gen 7) landscape"] : {
    viewport: { width, height: 1000 }, hasTouch: false, isMobile: false,
  });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(documentListUrl(scenario));
  await expect(page.locator("[data-document-list-fixture] .ub-docs-heading")).toBeVisible();
  expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(touch);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function expectListTarget(control: Locator, floor: number): Promise<void> {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(floor);
  expect(box?.height).toBeGreaterThanOrEqual(floor);
}

test("tag overflow recalculates when the bundled UI font loads in the list fixture @webkit", async ({ browser }) => {
  let releaseFont = (): void => {};
  const fontGate = new Promise<void>((resolveGate) => { releaseFont = resolveGate; });
  let fontRequested = false;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(context);
  const page = await context.newPage();
  const tags = ["billing", "permissions", "auth", "mcp", "rfc", "sync"];
  try {
    await page.route(/\/Geist-Variable[^/]*\.woff2(?:\?|$)/, async (route) => {
      fontRequested = true;
      await fontGate;
      await route.continue();
    });
    // WebKit's load event waits for fonts, so inspect its fallback first paint.
    await page.goto(documentListUrl("font"), { waitUntil: "domcontentloaded" });
    await expect(page.locator(".ub-docs-heading")).toBeVisible();
    await expect.poll(() => fontRequested).toBe(true);
    await page.evaluate(async () => {
      await document.fonts.load('400 12px "Geist Mono"');
      document.documentElement.style.setProperty("--font-sans", '"Geist", "Geist Mono", monospace');
    });
    expect(await page.evaluate(() => Array.from(document.fonts).find((font) => font.family === "Geist Mono")?.status)).toBe("loaded");
    const row = page.locator(".ub-docs-row");
    await expect(row).toHaveCount(1);
    const columnWidth = await row.locator(".ub-docs-tags-cell").evaluate((cell) => {
      const wrapper = cell.querySelector<HTMLElement>(".ub-docs-tags");
      const probe = cell.querySelector<HTMLElement>(".ub-docs-tag-measure");
      if (wrapper === null || probe === null) throw new Error("e2e: the tag row is missing");
      const chips = Array.from(probe.children, (chip) => chip.getBoundingClientRect().width);
      const gap = Number.parseFloat(getComputedStyle(wrapper).columnGap);
      const padding = getComputedStyle(cell);
      return chips.slice(0, 3).reduce((sum, width) => sum + width, 0)
        + (chips.at(-1) ?? 0) + 3 * gap - 1
        + Number.parseFloat(padding.paddingLeft) + Number.parseFloat(padding.paddingRight);
    });
    await page.locator(".ub-docs-tags-column").evaluate((column, width) => {
      (column as HTMLElement).style.width = `${width}px`;
    }, columnWidth);
    const controls = row.locator(".ub-docs-tags > button");
    await expect(controls).toHaveText([...tags.slice(0, 2), "+4"]);
    const before = await row.locator(".ub-docs-tags").boundingBox();
    releaseFont();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => Array.from(document.fonts).find((font) => font.family === "Geist")?.status)).toBe("loaded");
    const loadedPrefixWidth = await row.locator(".ub-docs-tag-measure").evaluate((probe) => {
      const chips = Array.from(probe.children, (chip) => chip.getBoundingClientRect().width);
      return chips.slice(0, 3).reduce((sum, width) => sum + width, 0)
        + (chips.at(-1) ?? 0) + 3 * Number.parseFloat(getComputedStyle(probe).columnGap);
    });
    expect(loadedPrefixWidth).toBeLessThan(before?.width ?? 0);
    await expect(controls).toHaveText([...tags.slice(0, 3), "+3"]);
    const after = await row.locator(".ub-docs-tags").boundingBox();
    expect(after?.width).toBe(before?.width);
    expect(after?.height).toBe(before?.height);
    expect(await row.locator(".ub-docs-tags").evaluate((wrapper) => {
      const edge = wrapper.getBoundingClientRect().right;
      return Array.from(wrapper.querySelectorAll(":scope > button"), (chip) => chip.getBoundingClientRect().right <= edge);
    })).toEqual([true, true, true, true]);
  } finally {
    releaseFont();
    await page.unrouteAll({ behavior: "wait" });
  }
});

for (const touch of [false, true]) test(`tag measurement contains overflow with ${touch ? "iPad touch" : "desktop keyboard and pointer"} in the list fixture @webkit`, async ({ browser }) => {
  const page = await openDocumentListFixture(browser, touch, "overflow", 1024);
  const row = page.locator(".ub-docs-row");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".ub-docs-tags-cell")).toBeVisible();
  const pane = page.locator(".ub-pane");
  const dimensions = await pane.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  const measuredWidth = await row.locator(".ub-docs-tag-measure").evaluate((element) =>
    Array.from(element.children).reduce((width, chip) => width + chip.getBoundingClientRect().width, 0));
  expect(measuredWidth).toBeGreaterThan(dimensions.client);
  expect(dimensions.scroll).toBe(dimensions.client);
  const tags = Array.from({ length: 8 }, (_, index) => `measure-${index}-long-overflow-tags`);
  const firstTag = "measure-0-long-overflow-tags";
  const more = row.getByRole("button", { name: "Show all tags for Long tags", exact: true });
  await expect(more).toHaveText("+8");
  if (touch) await more.tap();
  else {
    await more.hover();
    await expect(page.getByRole("tooltip")).toContainText(tags.join(", "));
    await more.focus();
    await more.press("Enter");
  }
  const disclosure = page.getByRole("dialog", { name: "All tags for Long tags", exact: true });
  await expect(disclosure.getByRole("button")).toHaveText(tags);
  await activateControl(disclosure.getByRole("button", { name: firstTag, exact: true }), { touch });
  await expect(disclosure).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filter by tags", exact: true })).toContainText(firstTag);
  await expect(page.locator(".ub-docs-title")).toHaveText(["Long tags"]);
  await expect(page.getByLabel("Opened document", { exact: true })).toHaveText("");
});

for (const touch of [false, true]) {
  const input = touch ? "iPad touch" : "desktop keyboard and pointer";
  const tag = touch ? "@webkit-touch" : [];
  test(`document list filters take native ${input} and keep their paint in both appearances`, { tag }, async ({ browser, browserName }) => {
    const page = await openDocumentListFixture(browser, touch);
    const type = page.getByRole("tab", { name: /^Decisions/ });
    await activateControl(type, { touch });
    const search = page.getByRole("searchbox", { name: "Search", exact: true });
    await activateControl(search, { touch });
    await search.fill("current");
    const tags = page.getByRole("button", { name: "Filter by tags", exact: true });
    const state = page.getByRole("combobox", { name: "Decision state", exact: true });
    const row = page.locator(".ub-docs-row", { hasText: "Current topic" });
    await expect(row).toHaveCount(1);
    if (!touch) {
      await type.focus();
      for (const next of [search, tags, state, page.getByRole("button", { name: "Title", exact: true })]) {
        await page.keyboard.press("Tab");
        await expect(next).toBeFocused();
      }
      await tags.focus();
      await tags.press("Enter");
    } else await tags.tap();
    const auth = page.getByRole("option", { name: "auth", exact: true });
    if (touch) await auth.tap();
    else { await auth.focus(); await auth.press("Space"); }
    await expect(auth).toHaveAttribute("aria-selected", "true");
    const rfc = page.getByRole("option", { name: "rfc", exact: true });
    await activateControl(rfc, { touch });
    await expect(rfc).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(tags).toBeFocused();
    await activateControl(row.getByRole("button", { name: "auth", exact: true }), { touch });
    await expect(tags).toContainText("auth");
    await expect(tags).not.toContainText("rfc");
    await expect(page.getByLabel("Opened document", { exact: true })).toHaveText("");
    if (!touch) {
      await type.focus();
      for (const [key, name] of [["ArrowLeft", /^Documents/], ["ArrowRight", /^Decisions/], ["Home", /^Documents/], ["End", /^Decisions/]] as const) {
        await page.keyboard.press(key);
        const selected = page.getByRole("tab", { name });
        await expect(selected).toBeFocused();
        await expect(selected).toHaveAttribute("aria-selected", "true");
        await expect(search).toHaveValue("current");
        await expect(tags).toContainText("auth");
      }
    }
    const chevron = await page.locator(".ub-docs-state-filter svg").boundingBox();
    if (chevron === null) throw new Error("e2e: the State chevron is missing");
    const point = { x: chevron.x + chevron.width / 2, y: chevron.y + chevron.height / 2 };
    expect(await state.evaluate((select, hit) => document.elementFromPoint(hit.x, hit.y) === select, point)).toBe(true);
    if (touch) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await expect(state).toBeFocused();
    // WebKit does not expose its native select picker through :open.
    if (browserName === "chromium") await expect.poll(() => state.evaluate((select) => select.matches(":open"))).toBe(true);
    if (touch) {
      await state.selectOption("under-review");
      await page.keyboard.press("Escape");
    } else {
      await page.keyboard.press("u");
      await page.keyboard.press("Enter");
    }
    await expect(state).toHaveValue("under-review");
    await expect(row).toHaveCount(1);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const field = page.locator(".ub-docs-search-label");
      const fieldBox = await field.boundingBox();
      const tagBox = await tags.boundingBox();
      const stateBox = await page.locator(".ub-docs-state-filter").boundingBox();
      expect(fieldBox?.height).toBe(touch ? 44 : 32);
      expect(tagBox?.y).toBeCloseTo(fieldBox?.y ?? 0, 0);
      expect(tagBox?.height).toBe(fieldBox?.height);
      expect(stateBox?.height).toBe(fieldBox?.height);
      expect((await state.boundingBox())?.height).toBe(stateBox?.height);
      expect(stateBox?.x).toBeGreaterThan(tagBox?.x ?? 0);
      expect((await type.boundingBox())?.y).toBeLessThan(fieldBox?.y ?? 0);
      if (touch) expect((await search.boundingBox())?.height).toBe(44);
      await expect(field).toHaveCSS("border-top-width", "1px");
      await expect(search).toHaveCSS("font-size", touch ? "16px" : "14px");
      await expect(search).toHaveCSS("line-height", touch ? "27px" : "20px");
      await expect(search).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(row.locator(".ub-docs-title")).toHaveCSS("white-space", "nowrap");
      await expect(row.locator(".ub-docs-stage")).toHaveCSS("border-top-style", "dashed");
      await expect(row.locator("time")).toBeVisible();
      await expect(row.locator("time")).toHaveCSS("font-variant-numeric", "tabular-nums");
      await expect(row.locator(".ub-docs-age-cell")).toHaveCSS("text-align", "right");
      await expect(row.locator(".ub-docs-pin svg")).toBeVisible();
      const borders = await page.locator(".ub-docs-table th, .ub-docs-table td").evaluateAll((cells) =>
        cells.map((cell) => [getComputedStyle(cell).borderLeftWidth, getComputedStyle(cell).borderRightWidth]));
      expect(borders.every(([left, right]) => left === "0px" && right === "0px")).toBe(true);
    }
    await activateControl(page.getByRole("tab", { name: /^Documents/ }), { touch });
    await expect(type).toHaveAttribute("aria-selected", "false");
    await activateControl(type, { touch });
    await expect(type).toHaveAttribute("aria-selected", "true");
    await activateControl(tags, { touch });
    await activateControl(page.getByRole("button", { name: "Clear tags", exact: true }), { touch });
    await expect(page.getByRole("option", { name: "auth", exact: true })).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("Escape");
    await expect(tags).toBeFocused();
  });

  test(`document list sort and open targets take native ${input}`, { tag }, async ({ browser }) => {
    const page = await openDocumentListFixture(browser, touch);
    const floor = touch ? 44 : 24;
    const rows = page.locator(".ub-docs-row");
    await expect(rows).toHaveCount(2);
    if (!touch) {
      for (const height of await rows.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))) {
        expect(height, "compact desktop document row").toBeLessThanOrEqual(41);
      }
    }
    for (const [name, initial] of [["Title", "ascending"], ["Changed", "descending"]] as const) {
      const heading = page.getByRole("columnheader", { name: new RegExp(`^${name}`) });
      const sort = heading.getByRole("button", { name, exact: true });
      await expectListTarget(sort, floor);
      if (touch) await sort.tap();
      else { await sort.focus(); await sort.press("Enter"); }
      await expect(heading).toHaveAttribute("aria-sort", initial);
      if (name === "Title") await expect(page.locator(".ub-docs-title")).toHaveText(["Document A", "Document Z"]);
      if (touch) await sort.tap();
      else await sort.press("Space");
      await expect(heading).toHaveAttribute("aria-sort", initial === "ascending" ? "descending" : "ascending");
      if (name === "Title") await expect(page.locator(".ub-docs-title")).toHaveText(["Document Z", "Document A"]);
    }
    const field = await page.locator(".ub-docs-search-label").boundingBox();
    const last = await page.getByRole("button", { name: "Filter by tags", exact: true }).boundingBox();
    const table = await page.getByRole("table").boundingBox();
    expect(field?.x).toBeCloseTo(table?.x ?? 0, 0);
    expect((last?.x ?? 0) + (last?.width ?? 0)).toBeCloseTo((table?.x ?? 0) + (table?.width ?? 0), 0);
    for (const title of ["Document A", "Document Z"]) {
      const open = rows.filter({ hasText: title }).locator(".ub-docs-open");
      await expectListTarget(open, floor);
      if (touch) await open.tap();
      else { await open.focus(); await open.press("Enter"); }
      await expect(page.getByLabel("Opened document", { exact: true })).toHaveText(await open.getAttribute("title") ?? "missing UUID");
    }
  });

  test(`decision filters wrap below full-width Search with ${input}`, { tag }, async ({ browser }) => {
    const page = await openDocumentListFixture(browser, touch, "wrap");
    for (const [width, value, rows] of [
      [1440, "all", "one"], [1440, "changed-after-approval", "one"],
      [600, "changed-after-approval", "two"], [520, "all", "two"], [375, "changed-after-approval", "three"],
    ] as const) {
      await test.step(`${width}px with ${value}`, async () => {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(documentListUrl("wrap", value));
        await page.evaluate(() => document.fonts.ready);
        await expect(async () => {
          const { row, search, tag: tagBox, picker } = await page.locator(".ub-docs-filters").evaluate((filters) => {
            const bounds = (element: Element | null) => {
              if (element === null) throw new Error("e2e: a list filter is missing");
              const { x, y, width, height } = element.getBoundingClientRect();
              return { x, y, width, height };
            };
            return { row: bounds(filters), search: bounds(filters.querySelector(".ub-docs-search-label")),
              tag: bounds(filters.querySelector(".ub-docs-tag-filter")), picker: bounds(filters.querySelector(".ub-docs-state-filter")) };
          });
          expect(search.x).toBeCloseTo(row.x, 0);
          for (const control of [search, tagBox, picker]) expect(control.x + control.width).toBeLessThanOrEqual(row.x + row.width + 1);
          if (rows === "one") {
            expect(tagBox.y).toBeCloseTo(search.y, 0);
            expect(picker.y).toBeCloseTo(search.y, 0);
            expect(picker.x + picker.width).toBeCloseTo(row.x + row.width, 0);
          } else {
            expect(search.width).toBeCloseTo(row.width, 0);
            expect(tagBox.x).toBeCloseTo(row.x, 0);
            expect(tagBox.y).toBeGreaterThanOrEqual(search.y + search.height);
            if (rows === "two") {
              expect(picker.y).toBeCloseTo(tagBox.y, 0);
              expect(picker.x).toBeGreaterThanOrEqual(tagBox.x + tagBox.width);
            } else {
              expect(picker.x).toBeCloseTo(row.x, 0);
              expect(picker.y).toBeGreaterThanOrEqual(tagBox.y + tagBox.height);
            }
          }
        }).toPass({ timeout: 20_000 });
      });
    }
  });
}

function calloutEditor(page: Page): Locator {
  return page.locator(".ub-editor .ProseMirror");
}

function calloutMenu(page: Page): Locator {
  return page.getByRole("menu", { name: "Callout variant", exact: true });
}

async function openCalloutIcons(page: Page, touch: boolean): Promise<Locator> {
  await activateControl(page.getByRole("button", { name: "Callout variant", exact: true }), { touch });
  await activateControl(calloutMenu(page).getByRole("menuitem", { name: "Change icon…", exact: true }), { touch });
  const search = page.getByRole("combobox", { name: "Search icons", exact: true });
  await expect(search).toBeFocused();
  return search;
}

test("callout captions take native desktop keyboard input and return focus to the editor", async ({ browser }) => {
  const page = await openCalloutFixture(browser, { viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false });
  const frame = page.getByRole("note");
  await frame.locator(".ub-callout-body").click();
  await expect(calloutEditor(page)).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await expect(calloutMenu(page).getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("w");
  await expect(calloutMenu(page).getByRole("menuitem", { name: "Warning", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(frame).toHaveAccessibleName("Warning");
  await expect(calloutEditor(page)).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await expect(calloutMenu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(calloutMenu(page)).toHaveCount(0);
  await expect(calloutEditor(page)).toBeFocused();
});

test("callout caption and icon menus fit both appearances with native pointer or iPad touch", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const touch = info.project.use.hasTouch === true;
  const page = await openCalloutFixture(browser, touch ? devices["iPad (gen 7)"] : {
    viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false,
  });
  const frame = page.getByRole("note");
  await activateControl(frame.locator(".ub-callout-body"), { touch });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await activateControl(page.getByRole("button", { name: "Callout variant", exact: true }), { touch });
    await expect(calloutMenu(page)).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Escape");
    await expect(calloutMenu(page)).toHaveCount(0);
    await expect(calloutEditor(page)).toBeFocused();
  }

  const search = await openCalloutIcons(page, touch);
  await expect(search).toBeInViewport({ ratio: 1 });
  if (touch) expect(await search.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  await search.fill("cla");
  const claude = page.getByRole("option", { name: "Claude", exact: true });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(claude).toBeInViewport();
    await expect(claude.locator("svg")).toBeVisible();
    await expect(claude.locator("svg")).toBeInViewport({ ratio: 1 });
  }
  await activateControl(claude, { touch });
  await expect(frame).toHaveAttribute("data-icon", ":claude:");
  await expect(calloutEditor(page)).toBeFocused();
  await openCalloutIcons(page, touch);
  await search.fill("smi");
  await expect(page.getByRole("option", { name: "smiley", exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(frame).toHaveAttribute("data-icon", "😃");
  await expect(calloutEditor(page)).toBeFocused();
  await openCalloutIcons(page, touch);
  await activateControl(page.getByRole("button", { name: "Use default icon", exact: true }), { touch });
  await expect(frame).not.toHaveAttribute("data-icon");
  await expect(frame.locator(".ub-callout-icon svg")).toBeVisible();
  await expect(calloutEditor(page)).toBeFocused();
});

for (const { coarse, widths } of [
  { coarse: true, widths: [1366] },
  { coarse: false, widths: [1280] },
]) {
  for (const width of widths) {
    test(`shared controls meet the ${coarse ? "touch" : "pointer"} floors at ${width}px`, async ({ browser }) => {
      const page = await openFixture(browser, coarse, width);
      const floor = coarse ? 44 : 24;
      const readings = await page.locator("[data-slot]").evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return {
            name: element.getAttribute("aria-label") ?? element.textContent,
            slot: element.getAttribute("data-slot"),
            icon: element.getAttribute("data-size") === "icon",
            height: box.height,
            width: box.width,
            font: Number.parseFloat(getComputedStyle(element).fontSize),
          };
        }),
      );
      expect(new Set(readings.map((one) => one.slot))).toEqual(new Set(["button", "input", "textarea"]));
      for (const one of readings) {
        expect(one.height, `${one.name} height`).toBeGreaterThanOrEqual(floor);
        if (one.icon || !coarse) expect(one.width, `${one.name} width`).toBeGreaterThanOrEqual(floor);
        if (coarse && one.slot !== "button") {
          expect(one.font, `${one.name} field text`).toBeGreaterThanOrEqual(16);
        }
      }
    });
  }
}

async function focusFromKeyboard(page: Page, control: Locator): Promise<string[]> {
  await control.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(control).toBeFocused();
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    // Chromium serializes auto's colour from the control ink. The browser
    // chooses the ring colour; compare its native geometry and auto style.
    return [style.outlineStyle, style.outlineWidth, style.outlineOffset];
  });
}

test("custom rows keep their left alignment, wrapping and normal weight", async ({ browser }) => {
  const page = await openFixture(browser, false, 1280);
  const row = page.getByRole("button", { name: "A full width row keeps its own layout", exact: true });
  await expect(row).toHaveCSS("display", "flex");
  await expect(row).toHaveCSS("justify-content", "normal");
  await expect(row).toHaveCSS("text-align", "left");
  await expect(row).toHaveCSS("white-space", "normal");
  await expect(row).toHaveCSS("font-weight", "400");
});

test("regular and invalid controls keep the browser's keyboard outline", async ({ browser }) => {
  const page = await openFixture(browser, false, 1280);
  const destructive = await page.evaluate(() => {
    const reference = document.createElement("span");
    reference.style.borderColor = "var(--destructive)";
    document.body.append(reference);
    const colour = getComputedStyle(reference).borderTopColor;
    reference.remove();
    return colour;
  });
  for (const invalid of await page.locator("[data-slot][aria-invalid=true]").all()) {
    expect(await invalid.evaluate((element) => getComputedStyle(element).borderTopColor)).toBe(destructive);
  }
  for (const slot of ["button", "input", "textarea"] as const) {
    const reference = slot === "button"
      ? page.getByRole("button", { name: "Native Button", exact: true })
      : page.getByLabel(`Native ${slot === "input" ? "Input" : "Textarea"}`, { exact: true });
    const native = await focusFromKeyboard(page, reference);
    expect(native[0]).toBe("auto");
    expect(Number.parseFloat(native[1] ?? "0")).toBeGreaterThan(0);
    const controls = page.locator(`[data-slot="${slot}"]:enabled`);
    for (const control of await controls.all()) {
      await reference.focus();
      const restingShadow = await control.evaluate((element) => getComputedStyle(element).boxShadow);
      expect(await focusFromKeyboard(page, control)).toEqual(native);
      expect(await control.evaluate((element) => getComputedStyle(element).boxShadow)).toBe(restingShadow);
    }
  }
});

for (const coarse of [false, true]) {
  test(`Button hover follows hover capability — ${coarse ? "touch" : "pointer"}`, async ({ browser }) => {
    const page = await openFixture(browser, coarse, coarse ? 810 : 1280);
    expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(!coarse);
    for (const variant of ["default", "secondary", "outline"] as const) {
      const control = page.getByRole("button", { name: `${variant} default`, exact: true });
      await page.mouse.move(0, 0);
      const resting = await control.evaluate((element) => getComputedStyle(element).backgroundColor);
      if (coarse) {
        await control.tap();
        expect(await control.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(resting);
      } else {
        await control.hover();
        await expect.poll(() => control.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(resting);
      }
    }
  });
}

test("buttons share cursors and each component owns its disabled appearance", async ({ browser }) => {
  const page = await openFixture(browser, false, 1280);
  for (const slot of ["button", "input", "textarea"] as const) {
    const opacity = async (selector: string): Promise<number> => page.locator(selector).first().evaluate(
      (element) => Number.parseFloat(getComputedStyle(element).opacity),
    );
    expect(await opacity(`[data-slot="${slot}"]:disabled`)).toBeLessThan(
      await opacity(`[data-slot="${slot}"]:enabled`),
    );
  }
  for (const control of await page.getByRole("region", { name: "Button recipes", exact: true }).getByRole("button").all()) {
    await expect(control).toHaveCSS("cursor", "pointer");
  }
  for (const name of ["Disabled Button", "Aria-disabled Button", "Disabled native Button", "Aria-disabled native Button"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCSS("cursor", "default");
  }
  for (const slot of ["input", "textarea"] as const) {
    await expect(page.locator(`[data-slot="${slot}"]:disabled`)).toHaveCSS("cursor", "not-allowed");
  }
  for (const [name, cursor] of [
    ["Text cursor Button", "text"],
    ["Resize cursor Button", "ns-resize"],
    ["Column resize cursor Button", "col-resize"],
  ] as const) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCSS("cursor", cursor);
  }
  const references = page.getByRole("region", { name: "Cursor references", exact: true });
  await references.evaluate((section) => {
    for (const disabled of [null, "false", "true"]) {
      const control = document.createElement("div");
      control.setAttribute("role", "button");
      control.textContent = `Role Button ${disabled ?? "enabled"}`;
      if (disabled !== null) control.setAttribute("aria-disabled", disabled);
      section.append(control);
    }
    const terminal = document.createElement("div");
    terminal.setAttribute("role", "button");
    terminal.className = "ub-terminal-screen";
    terminal.textContent = "Terminal text cursor";
    section.append(terminal);
  });
  for (const state of ["enabled", "false", "true"]) {
    await expect(page.getByRole("button", { name: `Role Button ${state}`, exact: true }))
      .toHaveCSS("cursor", state === "true" ? "default" : "pointer");
  }
  await expect(references.locator(".ub-terminal-screen")).toHaveCSS("cursor", "text");
});
