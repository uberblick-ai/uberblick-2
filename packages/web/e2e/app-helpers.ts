import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { openUpstreamApp, startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

interface OpenAppOptions {
  contextOptions?: BrowserContextOptions;
  /** Bypass the serving replica when the proof requires direct hub presence. */
  upstream?: boolean;
  workspaces?: string[];
  beforeNavigate?: (page: Page) => Promise<void>;
  readySelector?: string;
}

/** Share one harness per file, with fresh contexts for each independent test. */
export function setupHarness(options: { scope?: "file" | "test"; app?: OpenAppOptions; accessRole?: "admin" | "member" } = {}) {
  let started: Harness | null = null;
  const contexts: BrowserContext[] = [];

  function harness(): Harness {
    if (started === null) {
      throw new Error("e2e: the harness is not running — its bootstrap failed");
    }
    return started;
  }

  const start = async (): Promise<void> => {
    started = await startHarness(options.accessRole === undefined ? {} : { accessRole: options.accessRole });
  };
  const stop = async (): Promise<void> => {
    const running = started;
    started = null;
    await running?.stop();
  };
  if (options.scope === "test") test.beforeEach(start);
  else test.beforeAll(start);
  test.afterEach(async () => {
    await Promise.all(contexts.splice(0).map((context) => context.close()));
  });
  if (options.scope === "test") test.afterEach(stop);
  else test.afterAll(stop);

  function trackContext(context: BrowserContext): BrowserContext {
    contexts.push(context);
    return context;
  }

  async function openApp(browser: Browser, path = "/", settings: OpenAppOptions = {}): Promise<Page> {
    const app = { ...options.app, ...settings };
    const running = harness();
    if (app.upstream === true || app.workspaces !== undefined) {
      const { context, page } = await openUpstreamApp(browser, running, path, {
        ...app,
        readySelector: app.readySelector ?? null,
      });
      trackContext(context);
      return page;
    }
    const context = trackContext(await browser.newContext(app.contextOptions));
    const page = await context.newPage();
    await app.beforeNavigate?.(page);
    await page.goto(new URL(path, running.appUrl).href);
    if (app.readySelector !== undefined) {
      await expect(page.locator(app.readySelector)).toBeVisible();
    }
    return page;
  }

  return { harness, openApp, trackContext, ws: () => harness().workspace };
}

export function editor(page: Page): Locator {
  return page.locator(".ub-editor .ProseMirror");
}

/** Keyboard input needs the opened menu's focus lifecycle, not just its paint. */
export async function openKeyboardMenu(page: Page, shortcut: string, trigger?: Locator): Promise<void> {
  await page.keyboard.press(shortcut);
  if (trigger !== undefined) await expect(trigger).toHaveAttribute("data-state", "open");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect.poll(() => menu.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
}

export function docButton(page: Page, title: string): Locator {
  return page.locator(".ub-list").getByRole("button", { name: title, exact: true });
}

/** Open a pinned document through the same sidebar a second client sees. */
export async function openDoc(page: Page, title: string): Promise<void> {
  await docButton(page, title).click();
  await expect(editor(page)).toBeVisible();
}

export function openPath(page: Page): string {
  return new URL(page.url()).pathname;
}

/** Every test sharing a workspace creates its own identifiable documents. */
export function docTitle(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Wait for the new document, even when a previous editor is already visible. */
export async function createDoc(page: Page, title: string, options: { pin?: boolean } = {}): Promise<string> {
  const before = openPath(page);
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect.poll(() => openPath(page)).not.toBe(before);
  await expect(page.locator(".ub-title")).toHaveValue("Untitled");
  await expect(editor(page)).toBeVisible();
  const uuid = openPath(page).split("/")[2];
  if (uuid === undefined || uuid === "") {
    throw new Error(`e2e: creating a document left the address at ${openPath(page)}`);
  }
  await page.locator(".ub-title").fill(title);
  if (options.pin === true) {
    await page.getByRole("button", { name: "Document actions" }).click();
    await page.getByRole("menuitem", { name: "Pin to sidebar" }).click();
    await expect(docButton(page, title)).toBeVisible();
  }
  return uuid;
}
