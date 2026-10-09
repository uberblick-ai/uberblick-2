/** Browser proof over the shared module, trimmed wrapper and product CSS. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { build, preview } from "vite";
import type { PreviewServer } from "vite";
import { assertNoViolations, WCAG_TAGS } from "./accessibility-assertions.js";
import { renderedText } from "./contrast-helpers.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let scratch: string | null = null;
let server: PreviewServer | null = null;
let fixtureUrl = "";
const contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), `uberblick-notifications-${process.env.UB_AGENTS_RUN ?? "local"}-`));
  const configFile = join(packageRoot, "vite.config.ts");
  await build({
    configFile,
    root: packageRoot,
    logLevel: "error",
    build: {
      outDir: scratch,
      emptyOutDir: true,
      rolldownOptions: { input: join(packageRoot, "e2e/fixtures/notifications.html") },
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
  if (base === undefined) throw new Error("e2e: no notification fixture serving address");
  fixtureUrl = new URL("e2e/fixtures/notifications.html", base).href;
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

type Severity = "success" | "info" | "warning" | "error";
interface Notice { key?: string; severity: Severity; message: string }
interface Fixture {
  transient: (notice: Notice) => void;
  sticky: (notice: Notice & { key: string }) => void;
  resolve: (key: string) => void;
  appearance: (appearance: "light" | "dark") => void;
}

async function openFixture(browser: Browser, options: { width?: number; height?: number; clock?: boolean } = {}): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: options.width ?? 1280, height: options.height ?? 720 } });
  contexts.push(context);
  const page = await context.newPage();
  if (options.clock) await page.clock.install();
  await page.goto(fixtureUrl);
  await expect(page.getByRole("heading", { name: "Shared notifications" })).toBeVisible();
  await expect(page.locator("[aria-live=polite]")).toHaveCount(1);
  if (options.clock) await page.clock.pauseAt(new Date(Date.now() + 1000));
  return page;
}

async function publish(page: Page, kind: "transient" | "sticky", notice: Notice): Promise<void> {
  await page.evaluate(({ kind, notice }) => {
    const fixture = (window as unknown as { notificationFixture: Fixture }).notificationFixture;
    if (kind === "sticky") fixture.sticky(notice as Notice & { key: string });
    else fixture.transient(notice);
  }, { kind, notice });
}

async function resolveSticky(page: Page, key: string): Promise<void> {
  await page.evaluate((key) => (window as unknown as { notificationFixture: Fixture }).notificationFixture.resolve(key), key);
}

function notice(page: Page, message: string): Locator {
  return page.locator("[data-sonner-toast]").filter({ has: page.locator("[data-description]", { hasText: message }) });
}

async function startNoticeClock(page: Page): Promise<void> {
  // Flush React's publication and the primitive's initial mounting frame.
  await page.clock.runFor(50);
}

test("one polite region precedes publication and outside-React calls preserve focus", async ({ browser }) => {
  const page = await openFixture(browser);
  const region = page.locator("[aria-live=polite]");
  await expect(region).toHaveAttribute("aria-label", "Notifications (Shift+F8)");
  await expect(region).toHaveAttribute("aria-relevant", "additions text");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  const origin = page.getByRole("textbox", { name: "Origin control" });
  await origin.focus();
  await publish(page, "sticky", { key: "connection", severity: "error", message: "Offline" });
  await expect(notice(page, "Offline")).toBeVisible();
  await expect(origin).toBeFocused();
  await publish(page, "sticky", { key: "connection", severity: "info", message: "Reconnecting" });
  await expect(notice(page, "Reconnecting")).toBeVisible();
  await expect(origin).toBeFocused();
  await resolveSticky(page, "connection");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await expect(origin).toBeFocused();
  await expect(region).toHaveCount(1);
  const reactPublisher = page.getByRole("button", { name: "Publish from React" });
  await reactPublisher.click();
  await expect(notice(page, "React publisher")).toBeVisible();
  await expect(reactPublisher).toBeFocused();
});

test("transients expire after ten seconds and keyed repeats are new additions with a fresh timer", async ({ browser }) => {
  const page = await openFixture(browser, { clock: true });
  await publish(page, "transient", { key: "copy", severity: "success", message: "Copied" });
  await startNoticeClock(page);
  const copied = notice(page, "Copied");
  await expect(copied).toHaveCount(1);
  await page.evaluate(() => {
    const fixtureWindow = window as unknown as { originalNotice: Element | null; addedNotices: number };
    fixtureWindow.originalNotice = document.querySelector("[data-sonner-toast]");
    fixtureWindow.addedNotices = 0;
    const region = document.querySelector("[aria-live=polite]");
    if (region === null) throw new Error("missing live region");
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) fixtureWindow.addedNotices += Number(node.matches("[data-sonner-toast]")) + node.querySelectorAll("[data-sonner-toast]").length;
        }
      }
    }).observe(region, { childList: true, subtree: true });
  });
  await page.clock.runFor(8500);
  await expect(copied).toHaveAttribute("data-removed", "false");
  await publish(page, "transient", { key: "copy", severity: "success", message: "Copied" });
  // Dismissal uses two native animation frames before its exit timer starts.
  await page.clock.runFor(100);
  await expect(page.locator("[data-sonner-toast][data-removed=true]")).toHaveCount(1);
  await page.clock.runFor(300);
  await expect(copied).toHaveCount(1);
  expect(await page.evaluate(() => {
    const fixtureWindow = window as unknown as { originalNotice: Element | null; addedNotices: number };
    return { replaced: document.querySelector("[data-sonner-toast]") !== fixtureWindow.originalNotice, additions: fixtureWindow.addedNotices };
  })).toEqual({ replaced: true, additions: 1 });
  await page.clock.runFor(9500);
  await expect(copied).toHaveAttribute("data-removed", "false");
  await page.clock.runFor(600);
  await expect(copied).toHaveCount(0);
});

for (const pause of ["hover", "keyboard", "hidden"] as const) {
  test(`Sonner preserves remaining transient time during ${pause} pause`, async ({ browser }) => {
    const page = await openFixture(browser, { clock: true });
    await publish(page, "transient", { severity: "info", message: "Temporary feedback" });
    await startNoticeClock(page);
    const feedback = notice(page, "Temporary feedback");
    await page.clock.runFor(4000);
    if (pause === "hover") await feedback.hover();
    else if (pause === "keyboard") await page.keyboard.press("Shift+F8");
    else {
      // Replay the browser's visibility signal, without changing Sonner's
      // implementation or replacing its timer with a test-only duration.
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }
    await page.clock.runFor(20_000);
    await expect(feedback).toHaveAttribute("data-removed", "false");
    if (pause === "hover") await page.mouse.move(0, 0);
    else if (pause === "keyboard") await page.keyboard.press("Escape");
    else {
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }
    await page.clock.runFor(5000);
    await expect(feedback).toHaveAttribute("data-removed", "false");
    await page.clock.runFor(1500);
    await expect(feedback).toHaveCount(0);
  });
}

test("sticky updates stay in place, dismissal preserves the condition, and resolution allows recurrence", async ({ browser }) => {
  const page = await openFixture(browser);
  await publish(page, "sticky", { key: "sync", severity: "error", message: "Sync unavailable" });
  await expect(notice(page, "Sync unavailable")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { stickyNotice: Element | null }).stickyNotice = document.querySelector("[data-sonner-toast]");
  });
  await publish(page, "sticky", { key: "sync", severity: "warning", message: "Sync retrying" });
  await expect(notice(page, "Sync retrying")).toHaveAttribute("data-type", "warning");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);
  expect(await page.evaluate(() => document.querySelector("[data-sonner-toast]") ===
    (window as unknown as { stickyNotice: Element | null }).stickyNotice)).toBe(true);
  await notice(page, "Sync retrying").getByRole("button").click();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await publish(page, "sticky", { key: "sync", severity: "warning", message: "Sync retrying" });
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await publish(page, "sticky", { key: "sync", severity: "error", message: "Sync retrying" });
  await expect(notice(page, "Sync retrying")).toHaveAttribute("data-type", "error");
  await notice(page, "Sync retrying").getByRole("button").click();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await publish(page, "sticky", { key: "sync", severity: "error", message: "Sync failed again" });
  await expect(notice(page, "Sync failed again")).toBeVisible();
  await resolveSticky(page, "sync");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await resolveSticky(page, "sync");
  await publish(page, "sticky", { key: "sync", severity: "error", message: "Sync failed again" });
  await expect(notice(page, "Sync failed again")).toBeVisible();
});

test("changed sticky content published during dismissal animation survives the old notice cleanup", async ({ browser }) => {
  const page = await openFixture(browser, { clock: true });
  await publish(page, "sticky", { key: "connection", severity: "error", message: "First failure" });
  await startNoticeClock(page);
  await notice(page, "First failure").getByRole("button").click();
  await publish(page, "sticky", { key: "connection", severity: "warning", message: "Second failure" });
  await page.clock.runFor(500);
  await expect(notice(page, "Second failure")).toHaveCount(1);
  await expect(notice(page, "Second failure")).toHaveAttribute("data-removed", "false");
  await page.clock.runFor(20_000);
  await expect(notice(page, "Second failure")).toHaveCount(1);
});

test("native keyboard entry and final dismissal restore origin focus without taking editor chords @webkit", async ({ browser, browserName }) => {
  const page = await openFixture(browser);
  // Safari's native all-controls traversal uses Option+Tab.
  const nextControl = browserName === "webkit" ? "Alt+Tab" : "Tab";
  const previousControl = browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab";
  const origin = page.getByRole("textbox", { name: "Origin control" });
  await publish(page, "sticky", { key: "keyboard", severity: "info", message: "Keyboard notice" });
  await origin.focus();
  await page.keyboard.press("Control+Alt+t");
  await expect(origin).toBeFocused();
  await page.keyboard.press("Alt+t");
  await expect(origin).toBeFocused();
  await page.keyboard.press("Shift+F8");
  await expect(page.locator("[data-sonner-toaster]")).toBeFocused();
  // Sonner's first Tab reaches the toast; the second reaches its close button.
  await page.keyboard.press(nextControl);
  await expect(notice(page, "Keyboard notice")).toBeFocused();
  await page.keyboard.press(nextControl);
  await expect(notice(page, "Keyboard notice").getByRole("button")).toBeFocused();
  await page.keyboard.press(previousControl);
  await page.keyboard.press(previousControl);
  await expect(origin).toBeFocused();
  await page.keyboard.press("Shift+F8");
  await page.keyboard.press(nextControl);
  await page.keyboard.press(nextControl);
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await expect(origin).toBeFocused();
});

test("a transient can be dismissed early with a pointer", async ({ browser }) => {
  const page = await openFixture(browser);
  await publish(page, "transient", { severity: "success", message: "Dismiss me" });
  await notice(page, "Dismiss me").getByRole("button").click();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

for (const appearance of ["light", "dark"] as const) {
  for (const width of [1280, 375]) {
    test(`${appearance} notices are accessible and stay above chrome within ${width}px`, async ({ browser }) => {
      const page = await openFixture(browser, { width });
      await page.evaluate((appearance) =>
        (window as unknown as { notificationFixture: Fixture }).notificationFixture.appearance(appearance), appearance);
      await expect(page.locator("html")).toHaveAttribute("data-theme", appearance);
      for (const severity of ["success", "info", "warning", "error"] as const) {
        await publish(page, "sticky", { key: severity, severity, message: `${severity} condition` });
      }
      const origin = page.getByRole("textbox", { name: "Origin control" });
      await origin.focus();
      await page.keyboard.press("Shift+F8");
      await expect(page.locator("[data-sonner-toast]").last()).toHaveAttribute("data-expanded", "true");
      // Native transform transitions finish before inspecting painted bounds.
      await page.waitForTimeout(500);
      await expect(page.locator("[data-sonner-toaster]")).toHaveAttribute("data-sonner-theme", appearance);
      const shapes = new Set<string>();
      for (const severity of ["success", "info", "warning", "error"] as const) {
        const condition = notice(page, `${severity} condition`);
        await expect(condition).toHaveAttribute("data-type", severity);
        await expect(condition).toContainText(severity === "info" ? "Information" : severity.charAt(0).toUpperCase() + severity.slice(1));
        const readings = await condition.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const chrome = document.querySelector<HTMLElement>("[data-fixture-chrome]");
          if (chrome === null) throw new Error("missing fixture chrome");
          // Include the chrome in this hit test, then release the pointer
          // so the fixture's ordinary page controls remain usable.
          chrome.style.pointerEvents = "auto";
          const painted = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
          chrome.style.pointerEvents = "none";
          return {
            top: bounds.top, left: bounds.left, right: bounds.right, bottom: bounds.bottom,
            aboveChrome: painted !== null && element.contains(painted),
            icon: element.querySelector("[data-icon] svg")?.innerHTML,
          };
        });
        expect(readings.top).toBeGreaterThanOrEqual(0);
        expect(readings.left).toBeGreaterThanOrEqual(0);
        expect(readings.right).toBeLessThanOrEqual(width);
        expect(readings.bottom).toBeLessThanOrEqual(720);
        expect(readings.aboveChrome).toBe(true);
        expect(readings.icon).toBeDefined();
        shapes.add(readings.icon ?? "");
      }
      expect(shapes.size, "each severity has a distinct icon as well as a text label").toBe(4);
      const readings = await renderedText(page, "[aria-live=polite]");
      expect(readings.length).toBeGreaterThanOrEqual(4);
      for (const reading of readings) expect(reading.ratio, JSON.stringify(reading)).toBeGreaterThanOrEqual(4.5);
      const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      assertNoViolations(axe.violations);
      await expect(page.locator("[data-sonner-toast]").last()).toHaveAttribute("data-mounted", "true");
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH ?? test.info().outputDir, `notifications-${appearance}-${width}.png`) });
      const error = notice(page, "error condition");
      const close = error.getByRole("button");
      const restingToastShadow = await error.evaluate((element) => getComputedStyle(element).boxShadow);
      const restingCloseShadow = await close.evaluate((element) => getComputedStyle(element).boxShadow);
      await page.keyboard.press("Tab");
      await expect(error).toBeFocused();
      await expect.poll(() => error.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe(restingToastShadow);
      await page.keyboard.press("Tab");
      await expect(close).toBeFocused();
      await expect.poll(() => close.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe(restingCloseShadow);
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(origin).toBeFocused();
      await notice(page, "error condition").getByRole("button").click();
      await expect(notice(page, "error condition")).toHaveCount(0);
      await origin.focus();
      await page.keyboard.press("Shift+F8");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(notice(page, "warning condition").getByRole("button")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(notice(page, "warning condition")).toHaveCount(0);
      // Native multi-notice dismissal may leave focus on the body.
    });
  }
}

test("an active sticky notice stays reachable through a burst of transients in a narrow viewport @webkit", async ({ browser, browserName }) => {
  const page = await openFixture(browser, { width: 375, height: 400, clock: true });
  await publish(page, "sticky", { key: "ongoing", severity: "error", message: "Ongoing failure" });
  for (let index = 0; index < 18; index += 1) {
    await publish(page, "transient", { severity: "info", message: `Burst notice ${index}` });
  }
  await startNoticeClock(page);
  await page.keyboard.press("Shift+F8");
  const sticky = notice(page, "Ongoing failure");
  await expect(sticky).toHaveAttribute("data-expanded", "true");
  // Flush and finish native expansion before focus scrolls to a notice. A
  // wall-clock delay can leave WebKit scrolling to the pre-transition box.
  await page.locator("[data-sonner-toaster]").evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  // Keyboard traversal must reach the older condition without a history UI.
  const nextControl = browserName === "webkit" ? "Alt+Tab" : "Tab";
  for (let index = 0; index < 37; index += 1) await page.keyboard.press(nextControl);
  await expect(sticky).toBeFocused();
  const painted = await sticky.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const list = element.closest("[data-sonner-toaster]");
    const listBounds = list?.getBoundingClientRect();
    return {
      withinViewport: listBounds !== undefined && bounds.top >= listBounds.top - 1 && bounds.bottom <= innerHeight && bounds.right <= innerWidth,
      receivesPointer: element.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)),
      top: bounds.top, listTop: listBounds?.top, bottom: bounds.bottom,
      position: getComputedStyle(element).position, offset: getComputedStyle(element).bottom,
      scrollTop: list?.scrollTop, scrollHeight: list?.scrollHeight,
    };
  });
  expect(painted).toMatchObject({ withinViewport: true, receivesPointer: true });
  await page.clock.runFor(20_000);
  await expect(sticky).toHaveAttribute("data-removed", "false");
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  await page.clock.runFor(10_500);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);
  await expect(sticky).toBeVisible();
});
