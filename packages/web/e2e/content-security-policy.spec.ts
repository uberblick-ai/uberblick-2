/** Report-only policy and classic appearance bootstrap through production `ub open`. */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { BLOCK_TYPES } from "@uberblick/schema";
import type { BlockInput } from "@uberblick/schema";
import { WEB_CONTENT_SECURITY_POLICY } from "@uberblick/schema/web-policy";
import { SETTINGS_KEY } from "../src/settings.js";
import { editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";

const { harness, openApp, trackContext } = setupHarness();
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-csp-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

interface Violation { directive: string; blocked: string; disposition: string }

async function watchViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const violations: Violation[] = [];
    (window as unknown as { cspViolations: Violation[] }).cspViolations = violations;
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
        disposition: event.disposition,
      });
    });
  });
}

async function expectNoViolations(page: Page): Promise<void> {
  // Reports are queued as DOM events; let renderer work and its event delivery finish.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }));
  expect(await page.evaluate(() => (window as unknown as { cspViolations: Violation[] }).cspViolations)).toEqual([]);
}

const blocks: BlockInput[] = [
  { type: "paragraph", text: "Ordinary **marked** prose and a [link](https://example.com)." },
  { type: "heading", level: 2, text: "Every block" },
  { type: "code", language: "typescript", text: "const value = 1;" },
  { type: "code", language: "wireframe", text: "dialog Preview\n  text A same-origin renderer.\n  button Continue" },
  { type: "mermaid", text: "flowchart LR\n  Start --> Finish" },
  { type: "list-item", text: "A list entry" },
  { type: "quote", text: "Quoted prose" },
  { type: "table", text: "| Name | Count |\n| --- | --- |\n| Example | 2 |" },
  { type: "terminal", text: "$ ub init\nworkspace ready" },
  { type: "chart", text: JSON.stringify({
    version: 1, type: "line", collection: "measurements", title: "Example measurements",
    x: { field: "day", type: "date" }, y: [{ field: "value", label: "Value" }],
  }) },
  { type: "card", text: "label: Reference\ntitle: A useful card\nfooter: Metadata\n\nCard body." },
];
const figma: BlockInput = {
  type: "figma",
  text: "url: https://www.figma.com/design/k3Lm9QzT2x/Example\ntitle: Design reference\n\nA caption.",
};

test("workspace, supported renderers and the every-type document emit no report-only CSP violations", async ({ browser }) => {
  if (agent === null) throw new Error("e2e: the CSP MCP agent is not configured");
  const writer = agent.open({ name: "csp-e2e" });
  expect([...new Set([...blocks, figma].map((block) => block.type))].sort()).toEqual([...BLOCK_TYPES].sort());
  const rendered = await writer.call<{ uuid: string }>("create_doc", {
    title: "CSP supported blocks", description: "Production renderer coverage.", blocks,
  });
  await writer.call("update_data", {
    uuid: rendered.uuid,
    operations: [{
      collection: "measurements",
      schema: { version: 1, schema: {
        type: "object", additionalProperties: false,
        properties: { day: { type: "string" }, value: { type: "number" } }, required: ["day", "value"],
      } },
      replaceRecords: [
        { id: "first", value: { day: "2026-01-01", value: 1 } },
        { id: "second", value: { day: "2026-01-02", value: 2 } },
      ],
    }],
  });
  const allTypes = await writer.call<{ uuid: string }>("create_doc", {
    title: "CSP every block type", description: "Includes the live Figma view.",
    blocks: [...blocks, figma],
  });
  const page = await openApp(browser, "/", { beforeNavigate: async (target) => {
    await watchViolations(target);
    await target.route("https://embed.figma.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Figma fixture</title>" }));
  } });
  await expect(page.locator(".ub-document-sidebar")).toHaveAttribute("data-directory-state", "synced");
  await expectNoViolations(page);

  for (const uuid of [rendered.uuid, allTypes.uuid]) {
    const response = await page.goto(new URL(`/${harness().workspace}/${uuid}`, harness().appUrl).href);
    if (response === null) throw new Error("e2e: the document navigation returned no response");
    const headers = await response.headersArray();
    expect(headers.filter((header) => header.name.toLowerCase() === "content-security-policy-report-only")
      .map((header) => header.value)).toEqual([WEB_CONTENT_SECURITY_POLICY]);
    expect(headers.some((header) => header.name.toLowerCase() === "content-security-policy")).toBe(false);
    await expect(page.locator(".ub-title")).toHaveValue(uuid === rendered.uuid ? "CSP supported blocks" : "CSP every block type");
    if (uuid === rendered.uuid) {
      await expect(editor(page)).toBeVisible();
      for (const selector of [
        ".ub-code > code", ".ub-wireframe-drawing .wf-root", ".ub-mermaid-panel svg",
        ".ProseMirror h2", ".ProseMirror li", ".ProseMirror blockquote",
        ".ProseMirror table", ".ub-terminal-screen", ".ub-chart canvas", ".ub-card",
      ]) await expect(page.locator(selector).first()).toBeVisible();
      await expect(page.locator(".ub-chart-panel")).toHaveAttribute("data-state", "ready");
      await page.getByRole("button", { name: "Document actions", exact: true }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
    } else {
      await expect(editor(page)).toBeVisible();
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      await expect(page.locator(".ub-figma")).toBeVisible();
      await page.locator(".ub-figma").scrollIntoViewIfNeeded();
      await expect(page.locator(".ub-figma iframe")).toHaveAttribute("src", /^https:\/\/embed\.figma\.com\//);
    }
    await expectNoViolations(page);
  }
});

const appearance = { raw: JSON.stringify({ appearance: "dark" }), theme: "dark", system: "light" } as const;

test("the classic bootstrap applies stored dark settings before the app module and first body frame", async ({ browser }) => {
  const context = trackContext(await browser.newContext({ colorScheme: appearance.system }));
  await context.addInitScript(({ key, raw }) => {
    localStorage.setItem(key, raw);
    const firstBodyFrame = new Promise<{ theme: string | null; appMounted: boolean }>((resolve) => {
      const observer = new MutationObserver(() => {
        if (document.body === null) return;
        observer.disconnect();
        requestAnimationFrame(() => resolve({
          theme: document.documentElement.getAttribute("data-theme"),
          appMounted: (document.getElementById("root")?.childElementCount ?? 0) > 0,
        }));
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    (window as unknown as { firstBodyFrame: typeof firstBodyFrame }).firstBodyFrame = firstBodyFrame;
  }, { key: SETTINGS_KEY, raw: appearance.raw });
  const page = await context.newPage();
  let releaseModule: (() => void) | undefined;
  const moduleHeld = new Promise<void>((resolve) => { releaseModule = resolve; });
  await page.route(/\/assets\/[^/]+\.js(?:\?|$)/, async (route) => {
    await moduleHeld;
    await route.continue();
  });
  try {
    await page.goto(harness().appUrl, { waitUntil: "commit" });
    const first = await page.evaluate(() => (window as unknown as {
      firstBodyFrame: Promise<{ theme: string | null; appMounted: boolean }>;
    }).firstBodyFrame);
    expect(first).toEqual({ theme: appearance.theme, appMounted: false });
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(false);
  } finally { releaseModule?.(); }
  await expect(page.locator(".ub-document-sidebar")).toHaveAttribute("data-directory-state", "synced");
  expect(await page.locator("html").getAttribute("data-theme")).toBe(appearance.theme);
});
