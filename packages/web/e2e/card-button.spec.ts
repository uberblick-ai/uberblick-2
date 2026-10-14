import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { join } from "node:path";
import { editor, setupHarness } from "./app-helpers.js";
import { placeCaretIn } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { composite, contrast } from "../test/colour.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
test.beforeAll(() => {
  agent = new McpAgent({ workspace: harness().workspace, hubUrl: harness().hubUrl,
    authSecret: harness().authSecret, statePrefix: "uberblick-e2e-card-button-" });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

function session(): McpSession {
  if (agent === null) throw new Error("e2e: missing card-button MCP agent");
  return agent.open({ name: "card-button-e2e" });
}

async function activate(control: Locator, touch: boolean): Promise<void> {
  if (touch) await control.tap();
  else await control.click();
}

async function buttonPaint(button: Locator): Promise<{ ink: string; ground: string; under: string }> {
  await expect.poll(() => button.evaluate((element) => element.getAnimations().length)).toBe(0);
  return button.evaluate((element) => {
    const card = element.closest(".ub-card");
    if (card === null) throw new Error("e2e: button has no card");
    return { ink: getComputedStyle(element).color, ground: getComputedStyle(element).backgroundColor,
      under: getComputedStyle(card).backgroundColor };
  });
}

async function editButton(page: Page, text: string, href: string, touch: boolean): Promise<void> {
  await activate(page.getByRole("button", { name: "Edit buttons", exact: true }), touch);
  await page.getByLabel("Button text", { exact: true }).fill(text);
  await page.getByLabel("Button destination", { exact: true }).fill(href);
  await activate(page.getByRole("button", { name: "Save button", exact: true }), touch);
}

test("card buttons author, sync and activate with native input", { tag: "@webkit" }, async ({ browser }, info) => {
  const touch = info.project.use.hasTouch === true;
  const writer = session();
  const created = await writer.call<{ uuid: string }>("create_doc", {
    title: "Card button browser proof", description: "Synthetic action card for browser acceptance.",
    blocks: [{ type: "card", text: "title: Action card\nfooter: Metadata\n\nRecommendation body." }],
  });
  const path = `/${harness().workspace}/${created.uuid}`;
  const page = await openApp(browser, path, { upstream: true,
    contextOptions: { colorScheme: "light" } });
  const other = await openApp(browser, path, { upstream: true });
  const card = page.locator(".ub-card");
  await expect(card).toBeVisible();
  await activate(card.locator(".ub-card-title p"), touch);
  await activate(page.getByRole("button", { name: "Add button", exact: true }), touch);
  await page.getByLabel("Button text", { exact: true }).fill("Discuss in Codex");
  await page.getByLabel("Button destination", { exact: true }).fill("codex://settings");
  await activate(page.getByRole("button", { name: "Save button", exact: true }), touch);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(card.getByRole("button", { name: "Discuss in Codex", exact: true })).toHaveCount(0);
  await page.getByLabel("Button destination", { exact: true }).fill("codex://new?prompt=synthetic%20recommendation");
  await activate(page.getByRole("button", { name: "Save button", exact: true }), touch);
  await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit buttons", exact: true })).toBeFocused();
  const action = card.getByRole("button", { name: "Discuss in Codex", exact: true });
  await expect(action).toBeVisible();
  await expect(action).toHaveText("Discuss in Codex");
  await expect(action).toHaveCSS("text-transform", "none");
  await expect(other.getByRole("button", { name: "Discuss in Codex", exact: true })).toBeVisible();

  await page.evaluate(() => {
    const capture = window as unknown as Window & { cardAppLinks: string[] };
    capture.cardAppLinks = [];
    document.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest("a") : null;
      if (link !== null && /^(claude|claude-cli|codex):/.test(link.getAttribute("href") ?? "")) {
        event.preventDefault();
        capture.cardAppLinks.push(link.getAttribute("href") ?? "");
        if (link.target === "_blank") throw new Error("e2e: app button opened a blank tab");
      }
    }, true);
  });
  const before = page.url();
  await page.bringToFront();
  await activate(action, touch);
  await expect.poll(() => page.evaluate(() => (window as unknown as Window & { cardAppLinks: string[] }).cardAppLinks.length)).toBe(1);
  if (!touch) {
    await action.focus();
    await expect(action).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as unknown as Window & { cardAppLinks: string[] }).cardAppLinks.length)).toBe(2);
    await action.focus();
    await expect(action).toBeFocused();
    await page.keyboard.press("Space");
  }
  await expect.poll(() => page.evaluate(() => (window as unknown as Window & { cardAppLinks: string[] }).cardAppLinks.length)).toBe(touch ? 1 : 3);
  expect(page.url()).toBe(before);
  expect(page.context().pages()).toHaveLength(1);

  await writer.call("archive_doc", { uuid: created.uuid });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("button", { name: "Edit buttons", exact: true })).toHaveCount(0);
  if (touch) await action.tap();
  else { await action.focus(); await page.keyboard.press("Enter"); }
  await expect.poll(() => page.evaluate(() => (window as unknown as Window & { cardAppLinks: string[] }).cardAppLinks.length)).toBe(touch ? 2 : 4);
  expect(page.url()).toBe(before);
  expect(page.context().pages()).toHaveLength(1);
  await writer.call("restore_doc", { uuid: created.uuid });
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await activate(page.locator(".ub-title"), touch);
  await activate(action, touch);
  await expect.poll(() => page.evaluate(() => (window as unknown as Window & { cardAppLinks: string[] }).cardAppLinks.length)).toBe(touch ? 3 : 5);

  await placeCaretIn(card.locator(".ub-card-body p"), { touch, edge: "end" });
  await page.keyboard.type(" More detail.");
  await expect(other.locator(".ub-card-body")).toContainText("Recommendation body. More detail.");
  await expect(other.getByRole("button", { name: "Discuss in Codex", exact: true })).toBeVisible();

  await activate(page.getByRole("button", { name: "Edit buttons", exact: true }), touch);
  await activate(page.getByRole("button", { name: "Add button", exact: true }), touch);
  await page.getByLabel("Button text", { exact: true }).fill("Second action");
  await page.getByLabel("Button destination", { exact: true }).fill("claude-cli://open?q=Second");
  await activate(page.getByRole("button", { name: "filled", exact: true }), touch);
  await activate(page.getByRole("button", { name: "blue", exact: true }), touch);
  await activate(page.getByRole("button", { name: "Save button", exact: true }), touch);
  const second = card.getByRole("button", { name: "Second action", exact: true });
  await expect(second).toBeVisible();
  await expect(other.getByRole("button", { name: "Second action", exact: true })).toHaveAttribute("data-card-button-style", "filled");
  await expect(other.getByRole("button", { name: "Second action", exact: true })).toHaveAttribute("data-card-button-color", "blue");

  await editButton(page, "Read [the] details", "https://example.com/card-button", touch);
  await expect(second).toHaveAttribute("data-card-button-style", "filled");
  await expect(second).toHaveAttribute("data-card-button-color", "blue");
  const https = card.getByRole("button", { name: "Read [the] details", exact: true });
  await expect(https).toHaveText("Read [the] details");
  let referrer: string | undefined;
  await page.context().route("https://example.com/card-button", async (route) => {
    referrer = route.request().headers().referer;
    await route.fulfill({ contentType: "text/html", body: "<title>Card destination</title><p>Destination</p>" });
  });
  const popupPromise = page.context().waitForEvent("page");
  await activate(https, touch);
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(await popup.evaluate(() => ({ opener: window.opener, referrer: document.referrer }))).toEqual({ opener: null, referrer: "" });
  expect(referrer ?? "").toBe("");
  await popup.close();
  expect(page.url()).toBe(before);

  if (process.env.UB_AGENTS_SCRATCH !== undefined) {
    await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH, `card-button-${touch ? "ipad" : "desktop"}-light-${info.project.name}.png`) });
  }

  await writer.call("archive_doc", { uuid: created.uuid });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("button", { name: "Edit buttons", exact: true })).toHaveCount(0);
  const readOnlyPopup = page.context().waitForEvent("page");
  if (touch) await https.tap();
  else { await https.focus(); await page.keyboard.press("Enter"); }
  const reader = await readOnlyPopup;
  await reader.waitForLoadState();
  expect(await reader.evaluate(() => window.opener)).toBeNull();
  await reader.close();
  await writer.call("restore_doc", { uuid: created.uuid });
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await activate(page.getByRole("button", { name: "Edit buttons", exact: true }), touch);
  await activate(page.getByRole("button", { name: "Remove button", exact: true }), touch);
  await expect(https).toHaveCount(0);
  await expect(other.getByRole("button", { name: "Read [the] details", exact: true })).toHaveCount(0);
  await expect(second).toBeVisible();
  await activate(page.getByRole("button", { name: "Edit buttons", exact: true }), touch);
  await activate(page.getByRole("button", { name: "Remove button", exact: true }), touch);
  await expect(second).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add button", exact: true })).toBeVisible();
});

test("card button groups wrap, keep both appearances' contrast and ordered destinations", { tag: "@webkit" }, async ({ browser }, info) => {
  const touch = info.project.use.hasTouch === true;
  const writer = session();
  const options = (["outline", "filled"] as const).flatMap((style) =>
    (["neutral", "blue", "green", "violet"] as const).map((color, index) => ({
      style, color, text: `${style} ${color}`,
      href: index === 0 ? `https://example.invalid/${style}` :
        `${["claude://code/new", "claude-cli://open", "codex://new"][index - 1]}?prompt=${style}-${color}`,
    })));
  const longText = "W".repeat(180);
  const created = await writer.call<{ uuid: string }>("create_doc", {
    title: "Multiple card button browser proof", description: "Synthetic card action group.",
    blocks: [{ type: "card", text: `title: All button appearances\nfooter: Metadata\n${options.map((button) =>
      `button: [${button.text}](${button.href}) ${button.style} ${button.color}`).join("\n")}\nbutton: [${longText}](codex://new?prompt=long) filled violet\n\nBody.` }],
  });
  const page = await openApp(browser, `/${harness().workspace}/${created.uuid}`, { upstream: true,
    contextOptions: { colorScheme: "light" } });
  const card = page.locator(".ub-card");
  await expect(card.locator(".ub-card-button")).toHaveCount(9);
  await card.evaluate((element) => { (element as HTMLElement).style.maxWidth = "22rem"; });
  const actions = card.locator(".ub-card-actions");
  const buttons = card.locator(".ub-card-button");
  await expect(buttons).toHaveText([...options.map((button) => button.text), longText]);
  const layout = await actions.evaluate((element) => {
    const group = element.getBoundingClientRect();
    const boxes = [...element.querySelectorAll<HTMLButtonElement>(".ub-card-button")].map((button) => {
      const box = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return { left: box.left, right: box.right, top: box.top, width: box.width,
        height: box.height, lineHeight: Number.parseFloat(style.lineHeight), grow: style.flexGrow,
        scrollWidth: button.scrollWidth, clientWidth: button.clientWidth };
    });
    return { right: group.right, width: group.width, gap: getComputedStyle(element).gap,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, boxes };
  });
  expect(layout.gap).toBe("4px");
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  const rows: typeof layout.boxes[] = [];
  for (const box of layout.boxes) {
    const last = rows.at(-1);
    const first = last?.[0];
    if (first === undefined || Math.abs(first.top - box.top) > 1) rows.push([box]);
    else last?.push(box);
    expect(box.grow).toBe("0");
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
  }
  expect(rows.length).toBeGreaterThan(2);
  expect(rows.some((row) => row.length > 1)).toBe(true);
  for (const row of rows) {
    const last = row.at(-1);
    if (last === undefined) throw new Error("e2e: empty button row");
    expect(Math.abs(last.right - layout.right)).toBeLessThanOrEqual(1);
    for (const [index, box] of row.entries()) {
      const previous = row[index - 1];
      if (previous !== undefined) expect(box.left - previous.right).toBeCloseTo(4, 0);
    }
  }
  for (const box of layout.boxes.slice(0, 8)) expect(box.width).toBeLessThan(layout.width);
  const longBox = layout.boxes[8];
  if (longBox === undefined) throw new Error("e2e: missing long-label button");
  expect(longBox.height).toBeGreaterThan(longBox.lineHeight * 2);
  expect(longBox.width).toBeLessThanOrEqual(layout.width + 1);

  for (const appearance of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: appearance });
    await expect.poll(() => buttons.first().evaluate((element) => element.getAnimations().length)).toBe(0);
    const neutralAppearance = await buttons.first().evaluate((element) => {
      const reference = element.cloneNode(true) as HTMLButtonElement;
      reference.classList.remove("ub-card-button");
      reference.style.position = "absolute";
      reference.style.visibility = "hidden";
      element.parentElement?.append(reference);
      const read = (button: Element): Record<string, string | number> => {
        const style = getComputedStyle(button);
        const box = button.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(button);
        return { width: box.width, height: box.height, labelTop: text.getBoundingClientRect().top - box.top,
          color: style.color, background: style.backgroundColor, border: style.border,
          borderRadius: style.borderRadius, font: style.font, textTransform: style.textTransform };
      };
      const actual = read(element);
      const delivered = read(reference);
      reference.remove();
      return { actual, delivered };
    });
    expect(neutralAppearance.actual).toEqual(neutralAppearance.delivered);
    const paints = new Set<string>();
    for (const [index, option] of options.entries()) {
      const button = buttons.nth(index);
      await page.mouse.move(0, 0);
      const resting = await buttonPaint(button);
      expect(contrast(resting.ink, composite(resting.ground, resting.under)), `${appearance} ${option.text} resting`).toBeGreaterThanOrEqual(4.5);
      paints.add(`${resting.ink}/${resting.ground}`);
      await button.hover();
      const hovered = await buttonPaint(button);
      expect(contrast(hovered.ink, composite(hovered.ground, hovered.under)), `${appearance} ${option.text} hover`).toBeGreaterThanOrEqual(4.5);
      if (!touch) expect(hovered.ground, `${option.text} hover feedback`).not.toBe(resting.ground);
    }
    expect(paints.size).toBe(8);
  }
  await page.evaluate(() => {
    const capture = window as unknown as Window & { cardDestinations: string[] };
    capture.cardDestinations = [];
    window.open = ((href: string | URL | undefined, target?: string, features?: string) => {
      if (target !== "_blank" || features !== "noopener,noreferrer") throw new Error("e2e: unsafe https card activation");
      capture.cardDestinations.push(String(href));
      return null;
    }) as typeof window.open;
    document.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest("a[data-card-button-navigation]") : null;
      if (link === null) return;
      event.preventDefault();
      if (link.getAttribute("target") !== "_self") throw new Error("e2e: app opened a blank tab");
      capture.cardDestinations.push(link.getAttribute("href") ?? "");
    }, true);
  });
  const expected = [...options.map((button) => button.href), "codex://new?prompt=long"];
  for (let index = 0; index < expected.length; index += 1) await activate(buttons.nth(index), touch);
  await expect.poll(() => page.evaluate(() => (window as unknown as Window & { cardDestinations: string[] }).cardDestinations)).toEqual(expected);
  if (!touch) {
    const nextControl = browser.browserType().name() === "webkit" ? "Alt+Tab" : "Tab";
    await buttons.first().focus();
    for (let index = 0; index < expected.length; index += 1) {
      await expect(buttons.nth(index)).toBeFocused();
      await page.keyboard.press("Enter");
      if (index < expected.length - 1) await page.keyboard.press(nextControl);
    }
    await expect.poll(() => page.evaluate(() => (window as unknown as Window & { cardDestinations: string[] }).cardDestinations)).toEqual([...expected, ...expected]);
  }
  await writer.call("archive_doc", { uuid: created.uuid });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("button", { name: "Edit buttons", exact: true })).toHaveCount(0);
  for (let index = 0; index < expected.length; index += 1) await activate(buttons.nth(index), touch);
  await expect.poll(() => page.evaluate(() => (window as unknown as Window & { cardDestinations: string[] }).cardDestinations)).toEqual(touch ? [...expected, ...expected] : [...expected, ...expected, ...expected]);
  if (process.env.UB_AGENTS_SCRATCH !== undefined) {
    await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH, `card-buttons-${touch ? "ipad" : "desktop"}-dark-${info.project.name}.png`) });
  }
});
