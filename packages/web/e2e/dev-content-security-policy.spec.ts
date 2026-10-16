/** Exercise the contributor Vite route, including real Fast Refresh, under CSP. */
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { silentLogger } from "@uberblick/hub";
import { createTeamHub } from "@uberblick/hub/team";
import { WEB_CONTENT_SECURITY_POLICY } from "@uberblick/schema/web-policy";
import { createServer } from "vite";
import type { ViteDevServer } from "vite";
import { placeCaret } from "./harness.js";
import { FIGMA_LOOKUP, mockFigmaLookup } from "./figma-fixtures.js";
import { McpAgent } from "./mcp-agent.js";
import { expectMcp } from "./settle.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "uberblick-dev-csp-e2e-secret";

interface Violation { directive: string; blocked: string; disposition: string }

test("Vite syncs, loads Figma and applies Fast Refresh without CSP violations", async ({ page }) => {
  test.setTimeout(120_000);
  const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(),
    `uberblick-dev-csp-${process.env.UB_AGENTS_RUN ?? "local"}-`));
  const workspace = `dev-csp-${randomUUID()}`;
  const originalEnvironment = { ...process.env };
  let server: ViteDevServer | undefined;
  let agent: McpAgent | undefined;
  let hub: Awaited<ReturnType<typeof createTeamHub>> | undefined;
  try {
    // A private copy permits a real source edit without changing another worker's app.
    for (const entry of ["src", "public", "index.html", "package.json"]) {
      cpSync(join(packageRoot, entry), join(scratch, entry), { recursive: true });
    }
    symlinkSync(join(packageRoot, "node_modules"), join(scratch, "node_modules"), "dir");
    writeFileSync(join(scratch, "tsconfig.json"), JSON.stringify({ extends: join(packageRoot, "tsconfig.json") }));
    hub = await createTeamHub({ port: 0, authSecret: SECRET, databasePath: ":memory:", log: silentLogger });
    const hubUrl = `ws://127.0.0.1:${hub.port}/ws`;
    for (const key of ["WORKSPACE_ID", "HUB_URL", "WORKSPACES", "UBERBLICK_RELEASE_WEB"]) delete process.env[key];
    process.env.UB_WORKSPACE_ID = workspace;
    process.env.UB_HUB_URL = hubUrl;
    process.env.HUB_AUTH_TOKEN = SECRET;
    // Global setup builds production assets; this server exercises the dev task.
    process.env.NODE_ENV = "development";
    process.env.XDG_CONFIG_HOME = join(scratch, "config");
    process.env.XDG_DATA_HOME = join(scratch, "data");
    process.env.XDG_STATE_HOME = join(scratch, "state");
    server = await createServer({ root: scratch, configFile: join(packageRoot, "vite.config.ts"),
      cacheDir: join(scratch, "vite-cache"), logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
    await server.listen();
    const address = server.httpServer?.address();
    if (address === undefined || address === null || typeof address === "string") {
      throw new Error("e2e: the Vite dev server has no TCP address");
    }
    const appUrl = `http://127.0.0.1:${address.port}`;
    agent = new McpAgent({ workspace, hubUrl, authSecret: SECRET, statePrefix: "uberblick-dev-csp-agent-" });
    const writer = agent.open({ name: "dev-csp-e2e" });
    const doc = await writer.call<{ uuid: string }>("create_doc", {
      title: "Vite CSP document", description: "Verify the dev server's Figma and editing paths under CSP.", blocks: [
        { type: "paragraph", text: "Editable over the same-origin proxy." },
        { type: "figma", text: "url: https://www.figma.com/design/k3Lm9QzT2x/Example\n\nA caption." },
      ],
    });
    await page.addInitScript(() => {
      const violations: Violation[] = [];
      (window as unknown as { cspViolations: Violation[] }).cspViolations = violations;
      document.addEventListener("securitypolicyviolation", (event) => violations.push({
        directive: event.effectiveDirective, blocked: event.blockedURI, disposition: event.disposition,
      }));
    });
    await mockFigmaLookup(page);
    await page.route("https://embed.figma.com/**", (route) => route.fulfill({
      contentType: "text/html", body: "<!doctype html><p id='viewer'>Live Figma fixture</p>",
    }));
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    const lookupResponse = page.waitForResponse(FIGMA_LOOKUP);
    const response = await page.goto(`${appUrl}/${workspace}/${doc.uuid}`);
    if (response === null) throw new Error("e2e: the Vite HTML navigation returned no response");
    const headers = await response.headersArray();
    expect(headers.filter(({ name }) => name.toLowerCase() === "content-security-policy")
      .map(({ value }) => value)).toEqual([WEB_CONTENT_SECURITY_POLICY]);
    expect(headers.some(({ name }) => name.toLowerCase() === "content-security-policy-report-only")).toBe(false);
    await expect(page.locator(".ub-title")).toHaveValue("Vite CSP document");
    await expect(page.locator(".ub-editor .ProseMirror")).toHaveAttribute("contenteditable", "true");
    const runtime = await page.evaluate(async () => (await fetch("/uberblick-config.json")).json() as Promise<{ hubUrl: string }>);
    expect(runtime.hubUrl).toBe(`${appUrl.replace("http:", "ws:")}/ws`);
    expect(sockets).toContain(runtime.hubUrl);
    expect(sockets.every((url) => new URL(url).origin === appUrl.replace("http:", "ws:"))).toBe(true);
    await page.locator(".ub-figma").scrollIntoViewIfNeeded();
    expect((await lookupResponse).status()).toBe(200);
    await expect(page.locator(".ub-figma .ub-block-label")).toHaveText("Figma · Figma fixture title");
    await expect(page.frameLocator(".ub-figma iframe").locator("#viewer")).toHaveText("Live Figma fixture");
    await placeCaret(page);
    await page.keyboard.insertText(" Browser edit reached the dev hub.");
    await expectMcp(() => writer.call<{ blocks: { text: string }[] }>("get_doc", { uuid: doc.uuid }), (value) => {
      expect(value.blocks[0]?.text).toContain("Browser edit reached the dev hub.");
    });

    await page.locator(".ub-status-sync").click();
    await expect(page.getByRole("dialog", { name: "Sync and presence" })).toBeVisible();
    await page.evaluate(() => { (window as unknown as { devCspIdentity: string }).devCspIdentity = "same page"; });
    let navigations = 0;
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations += 1; });
    const sourcePath = join(scratch, "src", "ui", "status", "SyncPanel.tsx");
    const source = readFileSync(sourcePath, "utf8");
    const refreshed = source.replace(">Sync</h2>", ">Sync refreshed</h2>");
    expect(refreshed).not.toBe(source);
    writeFileSync(sourcePath, refreshed);
    await expect(page.getByRole("heading", { name: "Sync refreshed", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { devCspIdentity: string }).devCspIdentity)).toBe("same page");
    expect(navigations).toBe(0);
    await expect(page.locator(".ub-editor .ub-paragraph").first()).toContainText("Browser edit reached the dev hub.");
    await page.keyboard.press("Escape");
    await placeCaret(page);
    await page.keyboard.insertText(" Fast Refresh kept editing live.");
    await expectMcp(() => writer.call<{ blocks: { text: string }[] }>("get_doc", { uuid: doc.uuid }), (value) => {
      expect(value.blocks[0]?.text).toContain("Fast Refresh kept editing live.");
    });
    await page.evaluate(() => new Promise<void>((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 0)));
    }));
    expect(await page.evaluate(() => (window as unknown as { cspViolations: Violation[] }).cspViolations)).toEqual([]);
  } finally {
    try { await page.close(); } finally {
      try { await server?.close(); } finally {
        try { await agent?.close(); } finally {
          try { await hub?.stop(); } finally {
            for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
            Object.assign(process.env, originalEnvironment);
            rmSync(scratch, { recursive: true, force: true });
          }
        }
      }
    }
  }
});
