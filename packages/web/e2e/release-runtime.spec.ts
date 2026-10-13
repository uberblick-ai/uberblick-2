/** Released bundles open sockets only to a served configuration's endpoint. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createHub, silentLogger } from "@uberblick/hub";
import type { Hub } from "@uberblick/hub";
import { createTeamHub } from "@uberblick/hub/team";
import type { TeamHub } from "@uberblick/hub/team";
import { build, preview } from "vite";
import type { PreviewServer } from "vite";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const SECRET = "synthetic-release-runtime-secret";
let scratch: string | undefined;
let serving: PreviewServer | undefined;
let hub: Hub | undefined;
let appUrl: string;
let releaseOutDir: string;

test.beforeAll(async () => {
  const scratchRoot = process.env.UB_AGENTS_SCRATCH ?? tmpdir();
  const run = process.env.UB_AGENTS_RUN ?? basename(dirname(scratchRoot));
  scratch = mkdtempSync(join(scratchRoot, `release-browser-${run}-`));
  const outDir = join(scratch, "bundle");
  releaseOutDir = outDir;
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

class BrowserGithub {
  now = Date.now();
  starts = 0;
  approved = false;
  accountId = 9007;
  username = "browser-person";
  readonly fetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://github.com/login/device/code") {
      this.starts += 1;
      this.approved = false;
      return Response.json({ device_code: `synthetic-browser-device-${this.starts}`,
        user_code: "BROW-1234", verification_uri: "https://github.com/login/device",
        expires_in: 900, interval: 1 });
    }
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json(this.approved
        ? { access_token: "synthetic-browser-github-token", token_type: "bearer", scope: "" }
        : { error: "authorization_pending" });
    }
    if (url === "https://api.github.com/user") return Response.json({ id: this.accountId, login: this.username });
    throw new Error("Unexpected GitHub request in browser sign-in fixture");
  };

  approve(): void {
    this.approved = true;
    this.now += 1_000;
  }
}

interface BrowserSession {
  token: string;
  expiresAt: number;
  username: string;
}

interface BrowserSignIn {
  status: "complete";
  session: BrowserSession;
  claimedWorkspaceId?: string;
}

function previewTls(): { key: Buffer; cert: Buffer } {
  if (scratch === undefined) throw new Error("release test scratch is missing");
  const keyPath = join(scratch, "browser-preview.key");
  const certPath = join(scratch, "browser-preview.crt");
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost"], { timeout: 10_000, stdio: "pipe" });
  if (generated.status !== 0) throw new Error("Could not generate the run-owned HTTPS preview certificate");
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

async function browserPreview(running: TeamHub, secure = false): Promise<{ serving: PreviewServer; appUrl: string }> {
  const serving = await preview({ configFile: false, root: webRoot, logLevel: "error",
    build: { outDir: releaseOutDir }, preview: { port: 0, host: "127.0.0.1", strictPort: true,
      ...(secure ? { https: previewTls() } : {}),
      // Preserve the page's Host and Origin, including its port, through the
      // same-origin /auth route used by the released hub's reverse proxy.
      proxy: { "/auth/": { target: `http://127.0.0.1:${running.port}`, changeOrigin: false } } } });
  const address = serving.httpServer.address();
  if (address === null || typeof address === "string") {
    await serving.close();
    throw new Error("browser sign-in preview has no TCP address");
  }
  return { serving, appUrl: `${secure ? "https" : "http"}://localhost:${address.port}` };
}

async function browserHub(secure = false): Promise<{
  hub: TeamHub; github: BrowserGithub; appUrl: string; stop(): Promise<void>;
}> {
  const github = new BrowserGithub();
  const running = await createTeamHub({ port: 0, authSecret: SECRET, databasePath: ":memory:", log: silentLogger,
    github: { clientId: "Iv1.0123456789abcdef", fetch: github.fetch, now: () => github.now } },
  { initializeDefaultWorkspace: true, deviceCredentials: true });
  try {
    const served = await browserPreview(running, secure);
    return { hub: running, github, appUrl: served.appUrl, async stop() {
      try { await served.serving.close(); } finally { await running.stop(); }
    } };
  } catch (error) {
    await running.stop();
    throw error;
  }
}

async function completeBrowserSignIn(page: Page, github: BrowserGithub): Promise<BrowserSignIn> {
  await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
  await expect(page.getByText("BROW-1234", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "https://github.com/login/device", exact: true }))
    .toHaveAttribute("href", "https://github.com/login/device");
  const completed = page.waitForResponse(async (response) =>
    response.url().endsWith("/auth/browser/collect") && response.status() === 200 &&
    (await response.json()).status === "complete");
  github.approve();
  const result = await (await completed).json() as BrowserSignIn;
  await expect(page.getByText("Signed in as browser-person.", { exact: true })).toBeVisible();
  return result;
}

async function sessionStatus(page: Page, token: string): Promise<number> {
  return page.evaluate(async (sessionToken) => (await fetch("/auth/browser/session", {
    method: "POST", credentials: "omit", headers: { "Content-Type": "application/json", "X-Uberblick-Session": sessionToken },
    body: "{}",
  })).status, token);
}

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


for (const endpoint of ["ws://localhost:8080/ws", "wss://remote.example/ws"]) {
  test(`a released page for ${endpoint} guides every route without credentials or documents`, async ({ context, page }, testInfo) => {
    await context.route("**/uberblick-config.json", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        hubUrl: endpoint, workspaces: [WORKSPACE],
        // A stale HTTPS document must not restore remote shared-secret access.
        ...(endpoint.startsWith("wss:") ? { hubAuthToken: SECRET } : {}),
      }) });
    });
    await context.addCookies([{ name: "synthetic-session", value: "not-a-credential", url: appUrl }]);
    const claimRequests: { url: string; headers: Record<string, string> }[] = [];
    await context.route("**/auth/claim-state", async (route) => {
      claimRequests.push({ url: route.request().url(), headers: await route.request().allHeaders() });
      await route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ unclaimed: true, canClaim: true }) });
    });
    await context.route("**/auth/browser/session", (route) => route.fulfill({
      status: 401, json: { status: "signed-out" },
    }));
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    for (const path of ["/", `/${WORKSPACE}`, `/${WORKSPACE}/00000000-0000-4000-8000-000000000002`]) {
      await page.goto(`${appUrl}${path}`);
      await expect(page.getByRole("heading", { name: "This hub is unclaimed", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign in with GitHub", exact: true })).toBeVisible();
      const commands = page.getByRole("region", { name: "Hub setup guide" }).locator("li code");
      await expect(commands).toHaveText([
        `ub auth login '${appUrl}'`, `ub workspace use '${appUrl}/<workspace-id>'`, "ub open",
      ]);
      // Long origins and the placeholder must wrap and remain native
      // selectable text.
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
}

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

test("@webkit browser sign-in claims a released localhost hub and survives reload without opening documents", async ({ context, page }) => {
  const running = await browserHub();
  try {
    await context.route("**/uberblick-config.json", (route) => route.fulfill({ json: {
      hubUrl: `ws://localhost:${running.hub.port}/ws`, workspaces: [WORKSPACE],
    } }));
    await context.addCookies([{ name: "synthetic-session", value: "not-a-credential", url: running.appUrl }]);
    const authHeaders: Promise<Record<string, string>>[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/auth/")) authHeaders.push(request.allHeaders());
    });
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    await page.goto(running.appUrl);
    await expect(page.getByRole("heading", { name: "This hub is unclaimed", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in with GitHub", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Hub setup guide" }))
      .toContainText("hub administrator");
    expect(running.github.starts).toBe(0);

    const result = await completeBrowserSignIn(page, running.github);
    expect(result.claimedWorkspaceId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByText(`Claimed this hub: you are a hub administrator and administrator of the default workspace (${result.claimedWorkspaceId}).`, { exact: true })).toBeVisible();
    expect(Object.keys(result).sort()).toEqual(["claimedWorkspaceId", "session", "status"]);
    expect(Object.keys(result.session).sort()).toEqual(["expiresAt", "token", "username"]);
    expect(result.session.expiresAt).toBe(running.github.now + 24 * 60 * 60_000);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("synthetic-browser-github-token");
    const principal = running.hub.principals?.getByGithubAccountId("9007");
    if (principal == null || result.claimedWorkspaceId === undefined) throw new Error("Browser claim did not identify its account and workspace");
    expect(running.hub.hubAdmins?.isAdmin(principal.id)).toBe(true);
    expect(running.hub.memberships?.roleFor(result.claimedWorkspaceId, principal.id)).toBe("admin");
    expect(running.hub.credentials?.listDevices(principal.id)).toEqual([]);
    expect(running.hub.hubAdmins?.listAdmins(principal.id)[0]?.lastSignedInAt).toBeNull();

    await page.reload();
    await expect(page.getByText("Signed in as browser-person.", { exact: true })).toBeVisible();
    await page.goto(`${running.appUrl}/${result.claimedWorkspaceId}/00000000-0000-4000-8000-000000000002`);
    await expect(page.getByText("Signed in as browser-person.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "+ new doc" })).toHaveCount(0);
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Hub setup guide" })).toContainText("ub open");
    expect(sockets).toEqual([]);
    expect(running.hub.hocuspocus.documents.size).toBe(0);
    const authRequests = await Promise.all(authHeaders);
    expect(authRequests.length).toBeGreaterThan(0);
    expect(authRequests.every((headers) => headers.cookie === undefined && headers.authorization === undefined)).toBe(true);
  } finally { await running.stop(); }
});

test("a released hub without GitHub sign-in keeps its computer guidance and offers no browser approval", async ({ context, page }) => {
  if (hub === undefined) throw new Error("release test hub did not start");
  const served = await browserPreview(hub);
  try {
    await context.route("**/uberblick-config.json", (route) => route.fulfill({ json: {
      hubUrl: `ws://localhost:${hub?.port}/ws`, workspaces: [WORKSPACE],
    } }));
    await page.goto(served.appUrl);
    await expect(page.getByText("Browser sign-in is not configured on this hub.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in with GitHub", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Hub setup guide" })).toContainText("ub open");
    await expect(page.getByRole("button", { name: "+ new doc" })).toHaveCount(0);
  } finally { await served.serving.close(); }
});

test("@webkit a released HTTPS page signs in through its own origin and keeps the session on reload", async ({ browser }) => {
  const running = await browserHub(true);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.route("**/uberblick-config.json", (route) => route.fulfill({ json: {
      hubUrl: "wss://different-hub.example/ws", workspaces: [WORKSPACE],
    } }));
    const page = await context.newPage();
    await page.goto(running.appUrl);
    const result = await completeBrowserSignIn(page, running.github);
    expect(await sessionStatus(page, result.session.token)).toBe(200);
    await page.reload();
    await expect(page.getByText("Signed in as browser-person.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign in with GitHub", exact: true })).toBeVisible();
    expect(await sessionStatus(page, result.session.token)).toBe(401);
  } finally {
    try { await context.close(); } finally { await running.stop(); }
  }
});

test("browser sign-out waits for hub confirmation, revokes the session, and expired sessions require sign-in", async ({ context, page }) => {
  const running = await browserHub();
  try {
    await context.route("**/uberblick-config.json", (route) => route.fulfill({ json: {
      hubUrl: `ws://localhost:${running.hub.port}/ws`, workspaces: [WORKSPACE],
    } }));
    await page.goto(running.appUrl);
    const first = await completeBrowserSignIn(page, running.github);
    await context.route("**/auth/browser/sign-out", (route) => route.abort("failed"));
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("The hub could not confirm sign-out. Your session may still be active. Try again.");
    await expect(page.getByText("Signed in as browser-person.", { exact: true })).toBeVisible();
    expect(await sessionStatus(page, first.session.token)).toBe(200);
    await context.unroute("**/auth/browser/sign-out");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign in with GitHub", exact: true })).toBeVisible();
    expect(await sessionStatus(page, first.session.token)).toBe(401);
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign in with GitHub", exact: true })).toBeVisible();

    const second = await completeBrowserSignIn(page, running.github);
    running.github.now = second.session.expiresAt;
    expect(await sessionStatus(page, second.session.token)).toBe(401);
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign in with GitHub", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
  } finally { await running.stop(); }
});

test("browser sign-in on a CLI-claimed hub adds identity without a device, role or membership", async ({ context, page }) => {
  const running = await browserHub();
  try {
    running.github.accountId = 9010;
    running.github.username = "cli-owner";
    const cliStart = await (await fetch(`http://127.0.0.1:${running.hub.port}/auth/github/start`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })).json() as { requestId: string; collectionSecret: string };
    running.github.approve();
    const cliClaim = await (await fetch(`http://127.0.0.1:${running.hub.port}/auth/github/collect`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: cliStart.requestId, collectionSecret: cliStart.collectionSecret }),
    })).json() as { status: string; claimedWorkspaceId: string; credential: unknown };
    expect(cliClaim.status).toBe("complete");
    expect(cliClaim.credential).toBeDefined();
    running.github.accountId = 9007;
    running.github.username = "browser-person";
    await context.route("**/uberblick-config.json", (route) => route.fulfill({ json: {
      hubUrl: `ws://localhost:${running.hub.port}/ws`, workspaces: [WORKSPACE],
    } }));
    await page.goto(running.appUrl);
    const result = await completeBrowserSignIn(page, running.github);
    expect(result.claimedWorkspaceId).toBeUndefined();
    const principal = running.hub.principals?.getByGithubAccountId("9007");
    if (principal == null) throw new Error("Browser sign-in did not identify its account");
    expect(running.hub.hubAdmins?.isAdmin(principal.id)).toBe(false);
    expect(running.hub.memberships?.workspacesFor(principal.id)).toEqual([]);
    expect(running.hub.memberships?.roleFor(cliClaim.claimedWorkspaceId, principal.id)).toBeNull();
    expect(running.hub.credentials?.listDevices(principal.id)).toEqual([]);
  } finally { await running.stop(); }
});

test("another localhost port cannot start or end hub sign-in or reuse the hub session", async ({ context, page }) => {
  const running = await browserHub();
  let otherServing: PreviewServer | undefined;
  try {
    await context.route("**/uberblick-config.json", (route) => route.fulfill({ json: {
      hubUrl: `ws://localhost:${running.hub.port}/ws`, workspaces: [WORKSPACE],
    } }));
    await page.goto(running.appUrl);
    const signedIn = await completeBrowserSignIn(page, running.github);
    const other = await browserPreview(running.hub);
    otherServing = other.serving;
    const attacker = await context.newPage();
    await attacker.goto(other.appUrl);
    const attacks = await attacker.evaluate(async ({ hubOrigin, token }) => {
      const results: string[] = [];
      for (const action of ["start", "sign-out"]) {
        try {
          await fetch(`${hubOrigin}/auth/browser/${action}`, { method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json", "X-Uberblick-Session": token }, body: "{}" });
          results.push("allowed");
        } catch { results.push("refused"); }
      }
      // A local proxy can preserve its own Origin and Host. A session issued
      // at the hub's different port must still have no authority here.
      const replay = await fetch("/auth/browser/session", { method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", "X-Uberblick-Session": token }, body: "{}" });
      return { results, replay: replay.status, stored: localStorage.getItem("uberblick.browser-session") };
    }, { hubOrigin: running.appUrl, token: signedIn.session.token });
    expect(attacks).toEqual({ results: ["refused", "refused"], replay: 401, stored: null });

    const framedAuthRequests: string[] = [];
    attacker.on("request", (request) => {
      if (request.frame().parentFrame() !== null && new URL(request.url()).pathname.startsWith("/auth/browser/")) {
        framedAuthRequests.push(request.url());
      }
    });
    await attacker.evaluate((hubOrigin) => {
      const frame = document.createElement("iframe");
      frame.title = "Embedded hub";
      frame.src = hubOrigin;
      document.body.append(frame);
    }, running.appUrl);
    const embedded = attacker.frameLocator('iframe[title="Embedded hub"]');
    await expect(embedded.getByText("Open this hub in its own browser tab to sign in. This page has no document access.", { exact: true })).toBeVisible();
    const ownTab = embedded.getByRole("link", { name: "Open this hub in its own browser tab", exact: true });
    await expect(ownTab).toHaveAttribute("href", `${running.appUrl}/`);
    await expect(ownTab).toHaveAttribute("target", "_blank");
    await expect(ownTab).toHaveAttribute("rel", "noopener noreferrer");
    await expect(embedded.getByRole("button", { name: "Sign in with GitHub", exact: true })).toHaveCount(0);
    await expect(embedded.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
    expect(framedAuthRequests).toEqual([]);
    expect(running.github.starts).toBe(1);
    expect(await sessionStatus(page, signedIn.session.token)).toBe(200);
    await expect(page.getByText("Signed in as browser-person.", { exact: true })).toBeVisible();
  } finally {
    try { await otherServing?.close(); } finally { await running.stop(); }
  }
});
