/** Production CSS over the real components, including the unconsumed Textarea. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { build, preview } from "vite";
import type { PreviewServer } from "vite";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let scratch: string | null = null;
let server: PreviewServer | null = null;
let fixtureUrl = "";
const contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), `uberblick-controls-${process.env.UB_AGENTS_RUN ?? "local"}-`));
  const configFile = join(packageRoot, "vite.config.ts");
  await build({
    configFile,
    root: packageRoot,
    logLevel: "error",
    build: {
      outDir: scratch,
      emptyOutDir: true,
      rolldownOptions: { input: join(packageRoot, "e2e/fixtures/controls.html") },
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

for (const { coarse, widths } of [
  { coarse: true, widths: [375, 932, 744, 1024, 1366] },
  { coarse: false, widths: [1280, 1470] },
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
    const page = await openFixture(browser, coarse, coarse ? 375 : 1280);
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

test("each component owns its disabled appearance", async ({ browser }) => {
  const page = await openFixture(browser, false, 1280);
  for (const slot of ["button", "input", "textarea"] as const) {
    const opacity = async (selector: string): Promise<number> => page.locator(selector).first().evaluate(
      (element) => Number.parseFloat(getComputedStyle(element).opacity),
    );
    expect(await opacity(`[data-slot="${slot}"]:disabled`)).toBeLessThan(
      await opacity(`[data-slot="${slot}"]:enabled`),
    );
  }
});
