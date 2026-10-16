/** Enforced policy and classic appearance bootstrap through production `ub open`. */
import { devices, expect, test } from "@playwright/test";
import type { Page, Response } from "@playwright/test";
import { BLOCK_TYPES } from "@uberblick/schema";
import type { BlockInput } from "@uberblick/schema";
import { WEB_CONTENT_SECURITY_POLICY } from "@uberblick/schema/web-policy";
import { SETTINGS_KEY } from "../src/settings.js";
import { editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import { expectMcp, waitForDocumentDraw } from "./settle.js";
import { FIGMA_LOOKUP, mockFigmaLookup } from "./figma-fixtures.js";

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
  // Violations are queued as DOM events; let renderer work and event delivery finish.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }));
  expect(await page.evaluate(() => (window as unknown as { cspViolations: Violation[] }).cspViolations)).toEqual([]);
}

async function expectEnforcingPolicy(response: Response): Promise<void> {
  const headers = await response.headersArray();
  expect(headers.filter((header) => header.name.toLowerCase() === "content-security-policy")
    .map((header) => header.value)).toEqual([WEB_CONTENT_SECURITY_POLICY]);
  expect(headers.some((header) => header.name.toLowerCase() === "content-security-policy-report-only")).toBe(false);
}

async function expectWorkspaceSynced(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await expect(page.locator(".ub-document-sidebar")).toHaveAttribute("data-directory-state", "synced");
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
  text: "url: https://www.figma.com/design/k3Lm9QzT2x/Example\n\nA caption.",
};

test("workspace and every block render, load Figma and sync edits without CSP violations", { tag: "@webkit" }, async ({ browser }, info) => {
  if (agent === null) throw new Error("e2e: the CSP MCP agent is not configured");
  const writer = agent.open({ name: "csp-e2e" });
  expect([...new Set([...blocks, figma].map((block) => block.type))].sort()).toEqual([...BLOCK_TYPES].sort());
  const allTypes = await writer.call<{ uuid: string }>("create_doc", {
    title: "CSP every block type", description: "Includes the live Figma view.", blocks: [...blocks, figma],
  });
  await writer.call("update_data", {
    uuid: allTypes.uuid,
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
  let workspaceResponse: Response | undefined;
  const page = await openApp(browser, "/", { beforeNavigate: async (target) => {
    await watchViolations(target);
    target.on("response", (response) => {
      if (response.url() === new URL("/", harness().appUrl).href) workspaceResponse = response;
    });
    await mockFigmaLookup(target);
    await target.route("https://embed.figma.com/**", (route) => route.fulfill({
      contentType: "text/html", body: "<!doctype html><title>Figma fixture</title><p id='viewer'>Live Figma fixture</p>",
    }));
  }, contextOptions: info.project.use.hasTouch === true ? devices["iPad (gen 7)"] : {} });
  if (workspaceResponse === undefined) throw new Error("e2e: the workspace navigation returned no response");
  await expectEnforcingPolicy(workspaceResponse);
  await expectWorkspaceSynced(page);
  await expectNoViolations(page);

  const lookupResponse = page.waitForResponse(FIGMA_LOOKUP);
  const response = await page.goto(new URL(`/${harness().workspace}/${allTypes.uuid}`, harness().appUrl).href);
  if (response === null) throw new Error("e2e: the document navigation returned no response");
  await expectEnforcingPolicy(response);
  await expect(page.locator(".ub-title")).toHaveValue("CSP every block type");
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await waitForDocumentDraw(page, writer, allTypes.uuid, { index: "all" });
  for (const selector of [
    ".ub-code > code", ".ub-wireframe-drawing .wf-root", ".ub-mermaid-panel svg",
    ".ProseMirror h2", ".ProseMirror li", ".ProseMirror blockquote",
    ".ProseMirror table", ".ub-terminal-screen", ".ub-chart canvas", ".ub-card",
  ]) await expect(page.locator(selector).first()).toBeVisible();
  await expect(page.locator(".ub-chart-panel")).toHaveAttribute("data-state", "ready");
  await page.getByRole("button", { name: "Document actions", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".ub-figma").scrollIntoViewIfNeeded();
  const lookup = await lookupResponse;
  expect(lookup.status()).toBe(200);
  expect(await lookup.json()).toEqual({ title: "Figma fixture title" });
  await expect(page.locator(".ub-figma .ub-block-label")).toHaveText("Figma · Figma fixture title");
  await expect(page.locator(".ub-figma iframe")).toHaveAttribute("src", /^https:\/\/embed\.figma\.com\//);
  await expect(page.frameLocator(".ub-figma iframe").locator("#viewer")).toHaveText("Live Figma fixture");

  await page.locator(".ub-editor .ub-paragraph").first().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" CSP edit reached the hub.");
  await expectMcp(() => writer.call<{ blocks: Array<{ text: string }> }>("get_doc", { uuid: allTypes.uuid }), (doc) => {
    expect(doc.blocks[0]?.text).toContain("CSP edit reached the hub.");
  });
  await expectNoViolations(page);
});

test("frame-src enforces the Figma-only boundary before a forbidden frame reaches the network", { tag: "@webkit" }, async ({ browser }, info) => {
  let forbiddenRequests = 0;
  const page = await openApp(browser, "/", {
    contextOptions: info.project.use.hasTouch === true ? devices["iPad (gen 7)"] : {},
    beforeNavigate: async (target) => {
      await watchViolations(target);
      await target.route("https://example.com/**", async (route) => {
        forbiddenRequests += 1;
        await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Forbidden fixture</title>" });
      });
    },
  });
  await expectWorkspaceSynced(page);
  await expectNoViolations(page);
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.src = "https://example.com/";
    document.body.append(frame);
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { cspViolations: Violation[] }).cspViolations))
    .toEqual([{ directive: "frame-src", blocked: expect.stringMatching(/^https:\/\/example\.com\/?$/), disposition: "enforce" }]);
  expect(forbiddenRequests).toBe(0);
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
