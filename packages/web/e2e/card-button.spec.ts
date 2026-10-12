import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { join } from "node:path";
import { editor, setupHarness } from "./app-helpers.js";
import { placeCaretIn } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";

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

async function editButton(page: Page, text: string, href: string, touch: boolean): Promise<void> {
  await activate(page.getByRole("button", { name: "Edit button", exact: true }), touch);
  await page.getByLabel("Button text", { exact: true }).fill(text);
  await page.getByLabel("Button destination", { exact: true }).fill(href);
  await activate(page.getByRole("button", { name: "Save button", exact: true }), touch);
}

for (const touch of [false, true]) for (const appearance of ["light", "dark"] as const) {
  test(`card buttons author, sync and activate on ${touch ? "iPad touch" : "desktop keyboard and pointer"} in ${appearance}`, { tag: "@webkit" }, async ({ browser }, info) => {
    const writer = session();
    const created = await writer.call<{ uuid: string }>("create_doc", {
      title: "Card button browser proof", description: "Synthetic action card for browser acceptance.",
      blocks: [{ type: "card", text: "title: Action card\nfooter: Metadata\n\nRecommendation body." }],
    });
    const path = `/${harness().workspace}/${created.uuid}`;
    const page = await openApp(browser, path, { upstream: true,
      contextOptions: { ...(touch ? devices["iPad (gen 7)"] : {}), colorScheme: appearance } });
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
    await activate(action, touch);
    if (!touch) {
      await action.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
    }
    await expect.poll(() => page.evaluate(() => (window as unknown as Window & { cardAppLinks: string[] }).cardAppLinks.length)).toBe(touch ? 1 : 3);
    expect(page.url()).toBe(before);
    expect(page.context().pages()).toHaveLength(1);

    await writer.call("archive_doc", { uuid: created.uuid });
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await expect(page.getByRole("button", { name: "Edit button", exact: true })).toHaveCount(0);
    if (touch) await action.tap();
    else { await action.focus(); await page.keyboard.press("Enter"); }
    await expect.poll(() => page.evaluate(() => (window as unknown as Window & { cardAppLinks: string[] }).cardAppLinks.length)).toBe(touch ? 2 : 4);
    expect(page.url()).toBe(before);
    expect(page.context().pages()).toHaveLength(1);
    await writer.call("restore_doc", { uuid: created.uuid });
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");

    await placeCaretIn(card.locator(".ub-card-body p"), { touch, edge: "end" });
    await page.keyboard.type(" More detail.");
    await expect(other.locator(".ub-card-body")).toContainText("Recommendation body. More detail.");
    await expect(other.getByRole("button", { name: "Discuss in Codex", exact: true })).toBeVisible();

    await editButton(page, "Read [the] details", "https://example.com/card-button", touch);
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
    expect(referrer).toBeUndefined();
    await popup.close();
    expect(page.url()).toBe(before);

    if (process.env.UB_AGENTS_SCRATCH !== undefined) {
      await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH, `card-button-${touch ? "ipad" : "desktop"}-${appearance}-${info.project.name}.png`) });
    }

    await writer.call("archive_doc", { uuid: created.uuid });
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await expect(page.getByRole("button", { name: "Edit button", exact: true })).toHaveCount(0);
    const readOnlyPopup = page.context().waitForEvent("page");
    if (touch) await https.tap();
    else { await https.focus(); await page.keyboard.press("Enter"); }
    const reader = await readOnlyPopup;
    await reader.waitForLoadState();
    expect(await reader.evaluate(() => window.opener)).toBeNull();
    await reader.close();
    await writer.call("restore_doc", { uuid: created.uuid });
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    await activate(page.getByRole("button", { name: "Edit button", exact: true }), touch);
    await activate(page.getByRole("button", { name: "Remove button", exact: true }), touch);
    await expect(https).toHaveCount(0);
    await expect(other.getByRole("button", { name: "Read [the] details", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add button", exact: true })).toBeVisible();
  });
}
