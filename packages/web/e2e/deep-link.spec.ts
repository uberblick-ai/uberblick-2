/**
 * Deep links, in a real browser (#68).
 *
 * One spec, because only two of this feature's claims are out of jsdom's reach
 * and both are in the same story:
 *
 * - **A fresh browser opens a link.** No prior visit, straight
 *   to `/<workspace>/<uuid>`. That exercises the server's SPA fallback (a deep path has
 *   no file behind it, so something has to answer with index.html), the
 *   hydration of a replica that starts with nothing, and the waiting state
 *   resolving into the document — none of which a stubbed connection can show.
 * - **Back and Forward are the browser's, not ours.** jsdom queues `popstate`
 *   and the unit test drives it directly; whether a real session history holds
 *   the entries the sidebar pushed is a claim about a browser.
 * - **An unreachable routed room reveals nothing.** Reloading a document after
 *   its server stops leaves an offline waiting screen, never the content this
 *   browser rendered before the reload.
 *
 * Everything else the feature does — what an address parses to, an unknown
 * workspace, a malformed link, the waiting-state copy — is pinned in
 * `test/route.test.tsx` against no browser at all, and is not repeated here.
 *
 * The switcher (#151) is here for the same reason: that two configured
 * workspaces are two corpora is a claim about rooms and a hub, and jsdom has
 * neither. What the list *means* is pinned in `test/workspaces.test.tsx`.
 *
 * And the served configuration (#189), because the deployed client is the one
 * this repository keeps getting wrong: a real bundle, a real fetch of
 * `/uberblick-config.json`, and a workspace — and a credential — the build was
 * never told about.
 * Where the value comes from is pinned in `test/hub-config.test.ts`; that a
 * whole browser then opens the right corpus is only provable here.
 */

import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createDoc, docButton, docTitle, editor, openPath, setupHarness } from "./app-helpers.js";
import type { Page } from "@playwright/test";

const { harness, openApp, trackContext, ws } = setupHarness();

/** These fixtures are unnamed; their short UUID distinguishes the menu rows. */
function unnamedLabel(segment: string): string {
  return `Unnamed workspace · ${segment.slice(-36, -28)}`;
}

/**
 * Start recording whether `selector` is ever inserted into the page.
 *
 * The mutation records are inspected rather than the live DOM, because the
 * thing being ruled out is precisely an element that appears and is gone again
 * before anyone could query for it.
 */
async function watchForInsertion(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const w = window as unknown as Record<string, unknown>;
    w.__flashSeen = document.querySelector(sel) !== null;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(sel) || node.querySelector(sel) !== null) {
            w.__flashSeen = true;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    w.__flashStop = () => observer.disconnect();
  }, selector);
}

async function wasEverInserted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    (w.__flashStop as (() => void) | undefined)?.();
    return w.__flashSeen === true;
  });
}

interface StatusClaim {
  path: string;
  words: string[];
}

/** Record every sync word painted during a navigation. */
async function watchStatusClaims(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const claims: StatusClaim[] = [];
    const read = (): void => {
      claims.push({
        path: window.location.pathname,
        words: [...document.querySelectorAll(".ub-status-word")].map(
          (node) => node.textContent ?? "",
        ),
      });
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    w.__statusClaims = claims;
    w.__statusClaimsStop = () => {
      read();
      observer.disconnect();
    };
  });
}

async function statusClaims(page: Page): Promise<StatusClaim[]> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    (w.__statusClaimsStop as (() => void) | undefined)?.();
    return (w.__statusClaims as StatusClaim[] | undefined) ?? [];
  });
}

/** Set on the window, and gone the moment anything reloads the page. */
const KEEPALIVE = "__uberblickSameDocument";

async function markSession(page: Page): Promise<void> {
  await page.evaluate((key) => {
    (window as unknown as Record<string, unknown>)[key] = true;
  }, KEEPALIVE);
}

async function sessionSurvived(page: Page): Promise<boolean> {
  return page.evaluate(
    (key) => (window as unknown as Record<string, unknown>)[key] === true,
    KEEPALIVE,
  );
}

test("a workspace answers to both its spellings, and to neither of somebody else's", async ({
  browser,
}) => {
  // The slug is display: `<slug>-<uuid>` and `<uuid>` are one workspace, so
  // both addresses open one document — from a browser that has never seen
  // either, over the real transport.
  const author = await openApp(browser);
  const title = docTitle("both-spellings");
  const uuid = await createDoc(author, title, { pin: true });

  const bare = await openApp(browser, `/${harness().workspaceUuid}/${uuid}`);
  await expect(bare.locator(".ub-title")).toHaveValue(title);
  await expect(editor(bare)).toBeVisible();
  // Kept as typed — a link travels with the spelling it was written with.
  expect(openPath(bare)).toBe(`/${harness().workspaceUuid}/${uuid}`);

  const decorated = await openApp(browser, `/${ws()}/${uuid}`);
  await expect(decorated.locator(".ub-title")).toHaveValue(title);
  expect(openPath(decorated)).toBe(`/${ws()}/${uuid}`);

  // And a first segment that is no workspace id opens nothing at all.
  const wrong = await openApp(browser, `/main/${uuid}`);
  await expect(wrong.locator(".ub-notice")).toContainText("Not a document link");
  expect(openPath(wrong)).toBe(`/main/${uuid}`);
});

test("a document's URL is its address: the sidebar writes it, history walks it, a fresh browser opens it", async ({
  browser,
}) => {
  const author = await openApp(browser);
  await expect(author.locator(".ub-list-head")).toBeVisible();

  // `/` is not an address; the workspace is. The redirect comes from the
  // build-time `WORKSPACE_ID`, which is the only thing that answers `/`.
  await expect(author).toHaveURL(new RegExp(`/${ws()}$`));

  const firstTitle = docTitle("first");
  const secondTitle = docTitle("second");
  const first = await createDoc(author, firstTitle, { pin: true });
  const second = await createDoc(author, secondTitle, { pin: true });
  expect(openPath(author)).toBe(`/${ws()}/${second}`);

  // ---- the sidebar writes the address, without reloading ----
  await markSession(author);
  // Moving between two documents this replica already holds must be a quiet
  // swap. The connection is paired with its room one render after the address
  // changes, and that render must not put "waiting for sync", a synthetic
  // offline reading on the screen.
  await watchForInsertion(author, ".ub-notice");
  await watchStatusClaims(author);
  await docButton(author, firstTitle).click();
  await expect(author).toHaveURL(new RegExp(`/${ws()}/${first}$`));
  await expect(author.locator(".ub-title")).toHaveValue(firstTitle);
  await expect(author.locator(".ub-status-word--saved")).toHaveText("saved here");
  expect(await sessionSurvived(author)).toBe(true);
  expect(await wasEverInserted(author)).toBe(false);
  const claims = await statusClaims(author);
  expect(claims.flatMap(({ words }) => words)).not.toContain("offline");

  // ---- Back and Forward re-open what was viewed ----
  await author.goBack();
  await expect(author.locator(".ub-title")).toHaveValue(secondTitle);
  expect(openPath(author)).toBe(`/${ws()}/${second}`);

  await author.goForward();
  await expect(author.locator(".ub-title")).toHaveValue(firstTitle);
  expect(openPath(author)).toBe(`/${ws()}/${first}`);
  // Still the same document instance: pushState navigation all the way.
  expect(await sessionSurvived(author)).toBe(true);

  // ---- reload restores the same document ----
  await author.reload();
  await expect(author.locator(".ub-title")).toHaveValue(firstTitle);
  expect(openPath(author)).toBe(`/${ws()}/${first}`);

  const shareable = new URL(`/${ws()}/${first}`, harness().appUrl).href;

  // ---- a fresh browser session opens the link, with no navigation of its own ----
  // Its own context has no history. The server has no file at this path — only
  // the SPA fallback answers it — and the room starts empty until it syncs.
  const reader = await openApp(browser, `/${ws()}/${first}`);
  await expect(reader.locator(".ub-title")).toHaveValue(firstTitle);
  await expect(editor(reader)).toBeVisible();
  expect(openPath(reader)).toBe(`/${ws()}/${first}`);
  // The link the author would have copied is the one that just worked.
  expect(reader.url()).toBe(shareable);
});

test("a reloaded document whose server is unreachable shows no prior content", async ({
  browser,
}) => {
  // Bypass `ub open` for this case: its local store is itself a reachable
  // server when the upstream stops, while this contract needs the routed room
  // to have no server answering at all.
  const page = await openApp(browser, "/", { workspaces: [ws()] });
  const title = docTitle("unreachable");
  await createDoc(page, title, { pin: true });
  await expect(page.locator(".ub-title")).toHaveValue(title);
  await expect(editor(page)).toBeVisible();

  await harness().stopHub();
  try {
    await page.reload();

    await expect(page.locator(".ub-status-word")).toHaveText("offline");
    await expect(page.locator(".ub-notice")).toContainText("Waiting for sync");
    await expect(page.locator(".ub-title")).toHaveCount(0);
    await expect(editor(page)).toHaveCount(0);
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  } finally {
    await harness().startHub();
  }
});

test("the switcher moves between two workspaces, and their corpora do not mix", async ({
  browser,
}) => {
  // Switching is navigating: the control writes an address, and the app joins
  // that workspace's rooms. Nothing carries across, because two workspaces are
  // two corpora on one hub — separated by the room key and nothing else.
  // `ub open` serves this machine's one configured workspace. The switcher
  // proof owns its two-workspace document explicitly, just like the
  // different-document proof below, so it does not rely on a build-time list.
  const page = await openApp(browser, "/", { workspaces: [ws(), harness().secondWorkspace] });
  const title = docTitle("uberblick-only");
  await createDoc(page, title, { pin: true });

  await page.locator(".ub-workspace").click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveCount(
    // Two workspaces, and the two management items that are always there.
    4,
  );

  await page.getByRole("menuitem", { name: unnamedLabel(harness().secondWorkspace) }).click();
  await expect(page).toHaveURL(new RegExp(`/${harness().secondWorkspace}$`));
  // Synced *and* empty — the difference between a corpus this hub kept to
  // itself and a directory that simply had not arrived yet.
  await expect(page.locator(".ub-list-head .ub-muted")).toHaveText("directory synced");
  // The sidebar is per workspace like every other room, so the second one has
  // nothing pinned in it — not even the document just made in the first.
  await expect(page.locator(".ub-empty")).toContainText("Nothing pinned yet");
  await expect(docButton(page, title)).toHaveCount(0);

  // And back: the first workspace is exactly where it was left.
  await page.locator(".ub-workspace").click();
  await page.getByRole("menuitem", { name: unnamedLabel(ws()) }).click();
  await expect(page).toHaveURL(new RegExp(`/${ws()}$`));
  await expect(docButton(page, title)).toBeVisible();
});

test("the served configuration names the workspaces, and the build's define is only the fallback", async ({
  browser,
}) => {
  // Every context reads `/uberblick-config.json`; this one is answered by the
  // browser rather than by the dev server, with a document naming workspaces
  // the build was never told about. Everything downstream is real: the bundle
  // reads it, mints from the secret it carries, dials the endpoint it names,
  // and joins that workspace's rooms.
  const served = [`served-${randomUUID()}`, randomUUID()];
  const context = await browser.newContext();
  trackContext(context);
  await context.route("**/uberblick-config.json", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hubUrl: harness().hubUrl,
        workspaces: served,
        // The whole configuration comes from this document since #426, the
        // credential included — a body without it could not connect at all.
        hubAuthToken: harness().authSecret,
      }),
    });
  });
  const page = await context.newPage();
  await page.goto(harness().appUrl);

  // `/` opens the *served* list's first entry — not the `WORKSPACE_ID` the
  // bundle carries, which is what every other test in this file redirects to.
  await expect(page).toHaveURL(new RegExp(`/${served[0]}$`));
  expect(openPath(page)).not.toBe(`/${ws()}`);
  await page.locator(".ub-workspace").click();
  for (const workspace of served) {
    await expect(
      page.getByRole("menuitem", { name: unnamedLabel(workspace as string) }),
    ).toBeVisible();
  }
  await page.keyboard.press("Escape");

  // The endpoint came out of the same document: an empty corpus that reports
  // itself *synced* is a hub that answered, not a socket that never opened.
  await expect(page.locator(".ub-list-head .ub-muted")).toHaveText("directory synced");

  // And the surfaces say *which* document decided it (#362). This is the only
  // place that can be shown end to end: `resolveClientConfig` memoises per
  // module, so a component test can hold one resolved endpoint, never the path
  // from a served document through the shell to both surfaces. On a document
  // route, because that is where the status surfaces are (#424).
  await createDoc(page, docTitle("served"), { pin: true });
  await page.locator(".ub-sync-toggle").click();
  const source = page.locator('.ub-sync-fact:has(dt:text-is("Source")) dd');
  // "served …", not either of the two "… not used" answers: falling back to
  // the compiled value while still reading *synced* is the failure #362 exists
  // to remove. The wording itself is `config.ts`'s, pinned in
  // `test/sync-panel.test.tsx` — matched loosely here so this test says only
  // what it is for.
  await expect(source).toHaveText(/^served\b/);
  // The pill a reader glances at carries the panel's own answer. Read from one
  // surface and matched against the other, because what breaks is one of them
  // keeping the resolved endpoint while the other quietly falls back.
  expect(await page.locator(".ub-sync-toggle").getAttribute("title")).toContain(
    `(${(await source.innerText()).trim()})`,
  );
  await page.keyboard.press("Escape");

  // And the menu navigates, exactly as it does for a configured build.
  await page.locator(".ub-workspace").click();
  await page.getByRole("menuitem", { name: unnamedLabel(served[1] as string) }).click();
  await expect(page).toHaveURL(new RegExp(`/${served[1]}$`));
});

test("a rebound local-serving document stays visible without blocking the page", async ({
  browser,
}) => {
  const context = await browser.newContext();
  trackContext(context);
  await context.route("**/uberblick-config.json", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hubUrl: harness().appUrl.replace(/^http:/, "ws:").replace(/\/$/, ""),
        workspaces: [ws()],
        hubAuthToken: harness().authSecret,
        remoteHubUrl: harness().hubUrl,
        rebound: true,
      }),
    });
  });
  const page = await context.newPage();
  await page.goto(new URL(`/${ws()}`, harness().appUrl).href);

  const notice = page.locator(".ub-rebound-notice");
  await expect(notice).toContainText(`workspace ${ws()}`);
  await expect(notice).toContainText(harness().hubUrl);
  await expect(notice.getByRole("button")).toHaveCount(0);

  // The state is information, not an interlock: an ordinary write still takes
  // the same path to the local serving process underneath it.
  await page.getByRole("button", { name: "+ new doc" }).click();
  await expect(page.locator(".ub-title")).toHaveValue("Untitled");
  await expect(notice).toBeVisible();

  await page.evaluate((path) => {
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/${ws()}/not-a-document`);
  await expect(page.getByText("Not a document link.", { exact: false })).toBeVisible();
  await expect(notice).toBeVisible();
});
