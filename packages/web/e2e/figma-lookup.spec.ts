import { devices, expect, test } from "@playwright/test";
import type { Browser, Page, Route } from "@playwright/test";
import { FIGMA_PROVIDER } from "@uberblick/schema";
import { docTitle, setupHarness } from "./app-helpers.js";
import { answerFigmaLookup, FIGMA_LOOKUP } from "./figma-fixtures.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { expectMcp, proveMcpArrival } from "./settle.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl, authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-figma-lookup-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

interface StoredDoc { uuid: string; blocks: Array<{ id: string; type: string; text: string; rev: string }> }
interface Lookup { url: string; headers: Record<string, string> }
const LINK = "https://www.figma.com/design/lookup123/Stored-file-name?node-id=2-3";
const PRIVATE = "Figma can't show this file publicly. If you have access, load it to sign in.";
const CORS = { "access-control-allow-origin": "*" };

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: Figma lookup writer is missing");
  return agent.open({ name: "figma-lookup-e2e" });
}

function source(url = LINK, title?: string): { type: string; text: string } {
  return { type: "figma", text: `url: ${url}\n${title === undefined ? "" : `title: ${title}\n`}height: 240\n\nReference caption.` };
}

async function create(session: McpSession, blocks = [source()]): Promise<StoredDoc> {
  return session.call<StoredDoc>("create_doc", {
    title: docTitle("Figma lookup"), description: "Synthetic Figma lookup contract proof.", blocks,
  });
}

async function open(browser: Browser, uuid: string, answer: (route: Route, storedLink: string) => Promise<void>, options: { offline?: boolean; touch?: boolean } = {}): Promise<{ page: Page; lookups: Lookup[]; viewers: string[] }> {
  const lookups: Lookup[] = [];
  const viewers: string[] = [];
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    upstream: true,
    contextOptions: options.touch ? { ...devices["iPad (gen 7)"], isMobile: false } : { viewport: { width: 1366, height: 1200 }, hasTouch: false, isMobile: false },
    beforeNavigate: async (target) => {
      await target.context().addCookies([{ name: "figma-session", value: "synthetic-provider-cookie", domain: ".figma.com", path: "/", secure: true, sameSite: "None" }]);
      await target.route(FIGMA_LOOKUP, async (route) => {
        const url = new URL(route.request().url()).searchParams.get("url");
        if (url === null) throw new Error("e2e: lookup has no stored link");
        lookups.push({ url, headers: await route.request().allHeaders() });
        await answer(route, url);
      });
      await target.route("https://embed.figma.com/**", async (route) => {
        viewers.push(route.request().url());
        await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Synthetic Figma viewer</title>" });
      });
      if (options.offline) await target.addInitScript(() => {
        Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
      });
    },
  });
  return { page, lookups, viewers };
}

async function editLink(session: McpSession, doc: StoredDoc, url: string): Promise<void> {
  const current = await session.call<StoredDoc>("get_doc", { uuid: doc.uuid });
  const block = current.blocks[0];
  if (block === undefined) throw new Error("e2e: lookup block is missing");
  await session.call("edit_block", {
    uuid: doc.uuid, block_id: block.id, rev: block.rev, old_text: block.text,
    new_text: block.text.replace(/^url: .*/m, `url: ${url}`),
  });
}

test("a public lookup is credential-free, gates the viewer and changes only the rendered title", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer();
  const created = await create(session, [source(`${LINK.replace("www.figma.com", "figma.com")}&t=discarded`), source(LINK.replace("lookup123", "titled123"), "Stored title")]);
  const pending: Route[] = [];
  const { page, lookups, viewers } = await open(browser, created.uuid, async (route) => { pending.push(route); }, { touch: info.project.use.hasTouch === true });
  const frames = page.locator(".ub-figma");
  await expect.poll(() => pending.length).toBe(2);
  await expect(frames.locator("iframe")).toHaveCount(0);
  expect(viewers).toEqual([]);
  expect(lookups.map(({ url }) => url).sort()).toEqual([LINK, LINK.replace("lookup123", "titled123")].sort());
  for (const lookup of lookups) {
    expect(lookup.headers.cookie).toBeUndefined();
    expect(lookup.headers.referer).toBeUndefined();
    expect(lookup.headers.origin).toBe(new URL(page.url()).origin);
  }
  const title = '<img src="https://untrusted.invalid/title" onerror="alert(1)"> & Figma title';
  for (const route of pending) await answerFigmaLookup(route, title);
  await expect(frames.first().locator(".ub-block-label")).toHaveCount(0);
  await expect(frames.first().locator(".ub-figma-placeholder-title img")).toHaveCount(0);
  await expect(frames.first().locator("iframe")).toHaveAttribute("title", title);
  await expect(frames.nth(1).locator("iframe")).toHaveAttribute("title", "Stored title");
  await page.emulateMedia({ media: "print" });
  await expect(frames.first().locator(".ub-figma-print")).toHaveText(`${title}\n${LINK}`);
  await expect(frames.nth(1).locator(".ub-figma-print")).toContainText("Stored title");
  await page.emulateMedia({ media: "screen" });
  if (info.project.use.hasTouch === true) {
    await frames.first().locator(".ub-figma-shield").tap();
    await frames.first().locator(".ub-figure-viewer-bar").getByRole("button", { name: "Edit", exact: true }).tap();
  } else {
    await frames.first().getByRole("button", { name: "Edit", exact: true }).focus();
    await frames.first().getByRole("button", { name: "Edit", exact: true }).click();
  }
  await expect(frames.first().getByLabel("Title", { exact: true })).toHaveValue("");
  await frames.first().getByRole("button", { name: "Done", exact: true }).first().click();
  await proveMcpArrival(page, session, created.uuid, { path: "upstream" });
  await expectMcp(() => session.call<StoredDoc>("get_doc", { uuid: created.uuid }), (doc) => {
    expect(doc.blocks).toEqual(created.blocks);
  });
  await expectMcp(() => session.call<{ markdown: string }>("export_markdown", { uuid: created.uuid }), (doc) => {
    expect(doc.markdown).not.toContain(title);
    expect(doc.markdown).toContain("title: Stored title");
    expect(doc.markdown).toContain(LINK);
  });
});

test("a private placeholder holds no viewer slot; Load shares the limit and remains allowed until the link changes", { tag: "@webkit" }, async ({ browser }, info) => {
  const session = writer();
  const created = await create(session, [source(LINK, "Private reference"), ...[1, 2, 3].map((index) => source(LINK.replace("lookup123", `public${index}`))),
    { type: "code", text: Array.from({ length: 100 }, (_, index) => `Separation line ${index + 1}`).join("\n") }, source(LINK.replace("lookup123", "distant-private-proof"))]);
  const { page, lookups } = await open(browser, created.uuid, (route, url) => url === LINK || url.includes("private-again")
    ? route.fulfill({ status: 404, body: "Missing", headers: CORS }) : answerFigmaLookup(route), { touch: info.project.use.hasTouch === true });
  const frames = page.locator(".ub-figma");
  const privateFrame = frames.first();
  await expect(privateFrame.locator(".ub-figma-placeholder")).toContainText(PRIVATE);
  await expect(privateFrame.locator("iframe")).toHaveCount(0);
  await expect(privateFrame.locator(".ub-figma-placeholder-title")).toHaveText("Private reference");
  if (info.project.use.hasTouch === true) await expect(privateFrame.getByRole("button", { name: "Expand", exact: true })).toBeHidden();
  else await expect(privateFrame.getByRole("button", { name: "Expand", exact: true })).toBeDisabled();
  await expect(frames.locator("iframe")).toHaveCount(3);
  await privateFrame.getByRole("button", { name: "Load", exact: true }).click();
  await expect(privateFrame.locator(".ub-figma-placeholder")).not.toContainText(PRIVATE);
  await expect(frames.locator("iframe")).toHaveCount(3);
  await session.call("delete_block", { uuid: created.uuid, block_id: created.blocks[1]?.id });
  await expect(privateFrame.locator("iframe")).toHaveAttribute("src", FIGMA_PROVIDER.embedAddress(LINK, "light"));
  await expect(frames.locator("iframe")).toHaveCount(3);
  await frames.last().scrollIntoViewIfNeeded();
  await expect(privateFrame.locator("iframe")).toHaveCount(0);
  await expect(frames.last().locator("iframe")).toHaveCount(1);
  await privateFrame.scrollIntoViewIfNeeded();
  await expect(privateFrame.locator("iframe")).toHaveCount(1);
  await expect(privateFrame.locator(".ub-figma-placeholder")).not.toContainText(PRIVATE);
  await expect(frames.locator("iframe")).toHaveCount(3);
  expect(lookups.filter(({ url }) => url === LINK)).toHaveLength(1);
  await page.reload();
  await expect(privateFrame.locator(".ub-figma-placeholder")).toContainText(PRIVATE);
  await expect(privateFrame.locator("iframe")).toHaveCount(0);
  await editLink(session, created, LINK.replace("lookup123", "private-again"));
  await expect(privateFrame.locator(".ub-figma-placeholder-title")).toHaveText("Private reference");
  await expect.poll(() => lookups.some(({ url }) => url.includes("private-again"))).toBe(true);
  await expect(privateFrame.locator(".ub-figma-placeholder")).toContainText(PRIVATE);
  await expect(privateFrame.locator("iframe")).toHaveCount(0);
});

// The lookup answers every non-404 failure the same way; its unit test owns the kinds.
test("a failed lookup falls back to the stored link title without a private warning", async ({ browser }) => {
  const created = await create(writer());
  const { page } = await open(browser, created.uuid, (route) => route.fulfill({ status: 503, body: "Unavailable", headers: CORS }));
  const frame = page.locator(".ub-figma");
  await expect(frame.locator("iframe")).toHaveAttribute("title", "Stored file name");
  await expect(frame.locator(".ub-block-label")).toHaveCount(0);
  await expect(frame.locator(".ub-figma-placeholder")).not.toContainText(PRIVATE);
  await expect(frame.getByRole("button", { name: "Load", exact: true })).toBeHidden();
});

test("offline and distant blocks wait until eligible, and revisiting a block reuses its title", async ({ browser }) => {
  const created = await create(writer(), [source(), { type: "code", text: Array.from({ length: 100 }, (_, index) => `Separation line ${index + 1}`).join("\n") }, source(LINK.replace("lookup123", "distant123"))]);
  const { page, lookups } = await open(browser, created.uuid, (route) => answerFigmaLookup(route, "Cached title"), { offline: true });
  const frames = page.locator(".ub-figma");
  await expect(frames.first().locator(".ub-figma-placeholder > span")).toHaveText("The Figma preview needs a connection.");
  await expect(frames.first().locator("iframe")).toHaveCount(0);
  expect(lookups).toEqual([]);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
    dispatchEvent(new Event("online"));
  });
  await expect(frames.first().locator("iframe")).toHaveAttribute("title", "Cached title");
  expect(lookups.map(({ url }) => url)).toEqual([LINK]);
  await expect(frames.last().locator(".ub-figma-placeholder-title")).toHaveText("Stored file name");
  await frames.last().scrollIntoViewIfNeeded();
  await expect(frames.last().locator("iframe")).toHaveAttribute("title", "Cached title");
  await expect(frames.first().locator("iframe")).toHaveCount(0);
  await frames.first().scrollIntoViewIfNeeded();
  await expect(frames.first().locator("iframe")).toHaveAttribute("title", "Cached title");
  expect(lookups.map(({ url }) => url)).toEqual([LINK, LINK.replace("lookup123", "distant123")]);
});

test("link changes discard the old title and status and ignore an earlier link's late answer", async ({ browser }) => {
  const session = writer();
  const created = await create(session);
  const pending: Route[] = [];
  const { page, lookups } = await open(browser, created.uuid, async (route) => { pending.push(route); });
  const frame = page.locator(".ub-figma");
  await expect.poll(() => pending.length).toBe(1);
  const next = LINK.replace("lookup123", "next123").replace("Stored-file-name", "Next-file-name");
  await editLink(session, created, next);
  await expect.poll(() => pending.length).toBe(2);
  await expect(frame.locator(".ub-figma-placeholder-title")).toHaveText("Next file name");
  const old = pending[0]; const current = pending[1];
  if (old === undefined || current === undefined) throw new Error("e2e: lookup requests are missing");
  await current.fulfill({ status: 404, body: "Missing", headers: CORS });
  await expect(frame.locator(".ub-figma-placeholder")).toContainText(PRIVATE);
  const oldAnswered = page.waitForResponse((response) => new URL(response.url()).searchParams.get("url") === LINK);
  await answerFigmaLookup(old, "Wrong old title");
  await (await oldAnswered).finished();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }));
  await expect(frame.locator(".ub-figma-placeholder-title")).toHaveText("Next file name");
  await expect(frame.locator("iframe")).toHaveCount(0);
  await expect(frame.getByRole("button", { name: "Load", exact: true })).toBeVisible();
  const third = LINK.replace("lookup123", "third123").replace("Stored-file-name", "Third-file-name");
  await editLink(session, created, third);
  await expect.poll(() => lookups.length).toBe(3);
  await expect(frame.locator(".ub-figma-placeholder-title")).toHaveText("Third file name");
  await expect(frame.locator(".ub-figma-placeholder")).not.toContainText(PRIVATE);
  const latest = pending[2];
  if (latest === undefined) throw new Error("e2e: latest lookup request is missing");
  await answerFigmaLookup(latest, "Current title");
  await expect(frame.locator("iframe")).toHaveAttribute("title", "Current title");
  const fourth = LINK.replace("lookup123", "fourth123").replace("Stored-file-name", "Fourth-file-name");
  await editLink(session, created, fourth);
  await expect.poll(() => pending.length).toBe(4);
  await expect(frame.locator(".ub-figma-placeholder-title")).toHaveText("Fourth file name");
  await expect(frame.locator("iframe")).toHaveCount(0);
  const final = pending[3];
  if (final === undefined) throw new Error("e2e: final lookup request is missing");
  await final.fulfill({ status: 404, body: "Missing", headers: CORS });
  await expect(frame.locator(".ub-figma-placeholder")).toContainText(PRIVATE);
  await expect(frame.locator(".ub-figma-placeholder-title")).toHaveText("Fourth file name");
});
