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
