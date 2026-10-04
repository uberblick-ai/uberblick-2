/** Released bundles open sockets only to a served configuration's endpoint. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createHub, silentLogger } from "@uberblick/hub";
import type { Hub } from "@uberblick/hub";
import { build, preview } from "vite";
import type { PreviewServer } from "vite";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const SECRET = "synthetic-release-runtime-secret";
let scratch: string | undefined;
let serving: PreviewServer | undefined;
let hub: Hub | undefined;
let appUrl: string;

test.beforeAll(async () => {
  const scratchRoot = process.env.UB_AGENTS_SCRATCH ?? tmpdir();
  const run = process.env.UB_AGENTS_RUN ?? basename(dirname(scratchRoot));
  scratch = mkdtempSync(join(scratchRoot, `release-browser-${run}-`));
  const outDir = join(scratch, "bundle");
  const prior = process.env.UBERBLICK_RELEASE_WEB;
  process.env.UBERBLICK_RELEASE_WEB = "1";
  try {
    await build({ configFile: join(webRoot, "vite.config.ts"), root: webRoot,
      logLevel: "error", build: { outDir, emptyOutDir: true } });
  } finally {
    if (prior === undefined) delete process.env.UBERBLICK_RELEASE_WEB;
    else process.env.UBERBLICK_RELEASE_WEB = prior;
  }
  hub = await createHub({ port: 0, authSecret: SECRET, databasePath: ":memory:", log: silentLogger });
  serving = await preview({ configFile: false, root: webRoot, logLevel: "error",
    build: { outDir }, preview: { port: 0, host: "127.0.0.1", strictPort: true } });
  const address = serving.httpServer.address();
  if (address === null || typeof address === "string") throw new Error("release preview has no TCP address");
  appUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  try {
    await serving?.close();
  } finally {
    try { await hub?.stop(); } finally {
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test("a release bundle makes no implicit connection and uses a valid served endpoint", async ({ browser }) => {
  if (hub === undefined) throw new Error("release test hub did not start");
  const endpoint = `ws://127.0.0.1:${hub.port}`;
  for (const kind of ["missing", "empty", "invalid", "valid"] as const) {
    const context = await browser.newContext();
    try {
      await context.route("**/uberblick-config.json", async (route) => {
        await route.fulfill({ status: kind === "missing" ? 404 : 200,
          contentType: "application/json", body: JSON.stringify({
            hubUrl: kind === "empty" ? "" : kind === "invalid" ? "https://not-a-websocket.invalid" : endpoint,
            workspaces: [WORKSPACE], hubAuthToken: SECRET,
          }) });
      });
      const page = await context.newPage();
      const sockets: string[] = [];
      let resolved = false;
      page.on("websocket", (socket) => sockets.push(socket.url()));
      page.on("console", (message) => {
        if (message.text().startsWith("uberblick web: hub ")) resolved = true;
      });
      // The address names a workspace even when no config document arrives.
      await page.goto(`${appUrl}/${WORKSPACE}`);
      await expect.poll(() => resolved).toBe(true);
      if (kind === "valid") {
        await expect.poll(() => sockets.length).toBeGreaterThan(0);
        expect(sockets.every((url) => url === endpoint || url === `${endpoint}/`)).toBe(true);
        await expect(page.getByRole("button", { name: "+ new doc" })).toBeVisible();
      } else {
        await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        expect(sockets, kind).toEqual([]);
      }
    } finally {
      await context.close();
    }
  }
});


test("a remote hub guide covers every route without credentials or documents @webkit", async ({ context, page }, testInfo) => {
    await context.route("**/uberblick-config.json", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        hubUrl: "wss://remote.example/ws", workspaces: [WORKSPACE],
        // Old host config must not restore a remote browser's shared-secret path.
        hubAuthToken: SECRET,
      }) });
    });
    await context.addCookies([{ name: "synthetic-session", value: "not-a-credential", url: appUrl }]);
    const claimRequests: { url: string; headers: Record<string, string> }[] = [];
    await context.route("**/auth/claim-state", async (route) => {
      claimRequests.push({ url: route.request().url(), headers: await route.request().allHeaders() });
      await route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ unclaimed: true, canClaim: true }) });
    });
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    for (const path of ["/", `/${WORKSPACE}`, `/${WORKSPACE}/00000000-0000-4000-8000-000000000002`]) {
      await page.goto(`${appUrl}${path}`);
      await expect(page.getByRole("heading", { name: "This hub is unclaimed", exact: true })).toBeVisible();
      const commands = page.getByRole("region", { name: "Hub setup guide" }).locator("li code");
      await expect(commands).toHaveText([
        `ub auth login '${appUrl}'`, `ub remote join '${appUrl}/<workspace-id>'`, "ub open",
      ]);
      // Inherited WebKit viewports cover iPhone, iPad and MacBook; long origins
      // and the placeholder must wrap, and remain native selectable text.
      expect(await commands.evaluateAll((nodes) => nodes.every((node) => {
        const style = getComputedStyle(node);
        return (style.getPropertyValue("user-select") || style.getPropertyValue("-webkit-user-select")) === "text";
      }))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await commands.last().scrollIntoViewIfNeeded();
      await expect(commands.last()).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole("button", { name: "+ new doc" })).toHaveCount(0);
      await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
      expect(sockets).toEqual([]);
    }
    expect(claimRequests).toHaveLength(3);
    expect(claimRequests.every(({ url, headers }) => url === `${appUrl}/auth/claim-state` &&
      headers.cookie === undefined && headers.authorization === undefined)).toBe(true);
    const screenshot = testInfo.outputPath("remote-hub-guide.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach("remote-hub-guide", { path: screenshot, contentType: "image/png" });
});

test("ub open's local page ignores remote claim state and keeps its editor", async ({ context, page }) => {
  if (hub === undefined) throw new Error("release test hub did not start");
  let claimReads = 0;
  await context.route("**/auth/claim-state", async (route) => {
    claimReads += 1;
    await route.fulfill({ json: { unclaimed: true, canClaim: true } });
  });
  await context.route("**/uberblick-config.json", async (route) => {
    await route.fulfill({ json: {
      hubUrl: `ws://127.0.0.1:${hub?.port}`, workspaces: [WORKSPACE], hubAuthToken: SECRET,
      remoteHubUrl: "wss://remote.example/ws", rebound: false,
    } });
  });
  await page.goto(`${appUrl}/${WORKSPACE}`);
  await expect(page.getByRole("button", { name: "+ new doc" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Hub setup guide" })).toHaveCount(0);
  expect(claimReads).toBe(0);
});
