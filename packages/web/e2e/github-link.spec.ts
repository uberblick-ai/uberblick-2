import { expectOpenPages, provePageArrival } from "./settle.js";
/** GitHub pills change presentation while native links, selection and storage stay intact. */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { appendBlock, createAnnotation, githubItemKey, githubItemUrl, initDoc } from "@uberblick/schema";
import type { GitHubItemState, InlineRun } from "@uberblick/schema";
import { createDoc, docTitle, editor, setupHarness } from "./app-helpers.js";
import { placeCaret, placeCaretIn } from "./harness.js";

const { harness, openApp } = setupHarness();
const TARGET = "https://github.com/Example/SomeRepo/pull/12/files#diff-abc";
const STORED = "Example/SomeRepo#12";

test("workspace GitHub readings reach hub and local readers live, while personal answers win until unavailable", { tag: "@webkit" }, async ({ browser }) => {
  const now = Date.now();
  const hour = 60 * 60_000;
  const first = githubItemUrl("https://github.com/Example/SharedState/issues/2437");
  const second = githubItemUrl("https://github.com/Example/SharedState/issues/2438");
  if (first === null || second === null) throw new Error("e2e: invalid shared-state fixture");
  const doc = new Y.Doc();
  const uuid = randomUUID();
  initDoc(doc, { uuid, title: "Shared GitHub readings" });
  const firstUrl = "https://github.com/Example/SharedState/issues/2437";
  const secondUrl = "https://github.com/Example/SharedState/issues/2438";
  const block = appendBlock(doc, { type: "paragraph", inline: [
    { text: "#2437", marks: { link: firstUrl } }, { text: " ", marks: {} },
    { text: "#2438", marks: { link: secondUrl } },
  ] });
  createAnnotation(doc, block, 0, 1, "Reader", firstUrl);
  await harness().seedDocument(doc);
  doc.destroy();
  await harness().recordGitHubItem(first, { state: "issue-completed", seenAt: now - 3 * hour, isPublic: false });
  const upstreamRequests: string[] = [];
  const upstream = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    upstream: true,
    beforeNavigate: async (opened) => {
      await opened.clock.install({ time: now });
      opened.on("request", (request) => { if (request.url().endsWith("/api/github-item-states")) upstreamRequests.push(request.url()); });
    },
  });
  const upstreamPills = upstream.locator(".ub-editor .ub-github-pill");
  const initialLabel = "Issue Example/SharedState#2437 · Closed as completed · seen 3 hours ago";
  await expect(upstreamPills.first()).toHaveAttribute("data-github-state", "issue-completed");
  await expect(upstreamPills.first().locator("xpath=ancestor::a[1]")).toHaveAccessibleName(initialLabel);
  await expect(upstreamPills.first().locator("xpath=ancestor::a[1]")).toHaveAttribute("title", initialLabel);
  let personal = true;
  const local = await openApp(browser, `/${harness().workspace}/${uuid}`, {
    beforeNavigate: async (opened) => {
      await opened.clock.install({ time: now });
      await opened.route("**/api/github-item-states", (route) => route.fulfill({ json: {
        states: personal ? { [githubItemKey(first)]: "issue-open" } : {},
      } }));
    },
  });
  const localPills = local.locator(".ub-editor .ub-github-pill");
  await expect(localPills.first()).toHaveAttribute("data-github-state", "issue-open");
  await expect(localPills.first().locator("xpath=ancestor::a[1]")).toHaveAccessibleName("Issue Example/SharedState#2437 · Open");
  await harness().recordGitHubItem(first, { state: "issue-not-planned", seenAt: now - 2 * hour, isPublic: false });
  await harness().recordGitHubItem(second, { state: "issue-completed", seenAt: now, isPublic: true });
  await expect(upstreamPills.first()).toHaveAttribute("data-github-state", "issue-not-planned");
  // The second pill proves this record update reached the local reader before testing precedence.
  await expect(localPills.nth(1)).toHaveAttribute("data-github-state", "issue-completed");
  await expect(localPills.first()).toHaveAttribute("data-github-state", "issue-open");
  personal = false;
  await local.clock.fastForward(5 * 60_000);
  await expect(localPills.first()).toHaveAttribute("data-github-state", "issue-not-planned");
  await expect(localPills.first().locator("xpath=ancestor::a[1]"))
    .toHaveAccessibleName("Issue Example/SharedState#2437 · Closed as not planned · seen 2 hours ago");
  if ((upstream.viewportSize()?.width ?? 1280) < 1280) await upstream.locator(".ub-threads-toggle").click();
  const comment = upstream.locator(".ub-thread-text .ub-github-pill");
  await expect(comment).toHaveAttribute("data-github-state", "issue-not-planned");
  await expect(comment.locator("xpath=ancestor::a[1]"))
    .toHaveAccessibleName("Issue Example/SharedState#2437 · Closed as not planned · seen 2 hours ago");
  expect(upstreamRequests).toEqual([]);
});

test("one local reading repaints every GitHub state in prose and comments with only icon paint changing", { tag: "@webkit" }, async ({ browser }, info) => {
  const cases: Array<{ kind: "issue" | "pull"; number: number; state: GitHubItemState; label: string; color: "green" | "purple" | "grey" | "red" }> = [
    { kind: "issue", number: 101, state: "issue-open", label: "Open", color: "green" },
    { kind: "issue", number: 102, state: "issue-completed", label: "Closed as completed", color: "purple" },
    { kind: "issue", number: 103, state: "issue-not-planned", label: "Closed as not planned", color: "grey" },
    { kind: "issue", number: 104, state: "issue-duplicate", label: "Closed as duplicate", color: "grey" },
    { kind: "pull", number: 105, state: "pull-open", label: "Open", color: "green" },
    { kind: "pull", number: 106, state: "pull-draft", label: "Draft", color: "grey" },
    { kind: "pull", number: 107, state: "pull-merged", label: "Merged", color: "purple" },
    { kind: "pull", number: 108, state: "pull-closed", label: "Closed without merging", color: "red" },
  ];
  const refs = cases.map((entry) => ({ ...entry, href: `https://github.com/Example/SomeRepo/${entry.kind === "issue" ? "issues" : "pull"}/${entry.number}` }));
  const doc = new Y.Doc();
  const uuid = randomUUID();
  initDoc(doc, { uuid, title: "GitHub state proof" });
  const inline: InlineRun[] = refs.flatMap(({ number, href }) => [
    { text: `SomeRepo#${number}`, marks: { link: href } }, { text: " ", marks: {} },
  ]);
  const block = appendBlock(doc, { type: "paragraph", inline });
  createAnnotation(doc, block, 0, 1, "Reader", refs.map(({ href }) => href).join(" "));
  await harness().seedDocument(doc);
  doc.destroy();
  let release = (): void => {};
  const responseReady = new Promise<void>((resolve) => { release = resolve; });
  const requests: Array<{ items: unknown[] }> = [];
  try {
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      beforeNavigate: async (opened) => {
        await opened.route("**/api/github-item-states", async (route) => {
          requests.push(route.request().postDataJSON() as { items: unknown[] });
          await responseReady;
          const states = Object.fromEntries(refs.map(({ href, state }) => {
            const item = githubItemUrl(href);
            if (item === null) throw new Error("e2e: state fixture needs GitHub addresses");
            return [githubItemKey(item), state];
          }));
          await route.fulfill({ json: { states } });
        });
      },
    });
    const prose = page.locator(".ub-editor .ub-github-pill");
    await expect(prose).toHaveCount(cases.length);
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]?.items).toHaveLength(cases.length);
    const revision = await page.locator(".ub-doc-rev").innerText();
    const unknownPaths = await prose.locator("path").evaluateAll((paths) => paths.map((path) => path.getAttribute("d")));
    const baselines = new Map<string, Array<Record<string, string>>>();
    for (const appearance of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: appearance });
      baselines.set(appearance, await Promise.all(cases.map((_entry, index) => pillStyle(prose.nth(index)))));
      await expect(prose.first().locator("svg")).toHaveCSS("color", await prose.first().locator(".ub-github-pill-repo").evaluate((node) => getComputedStyle(node).color));
    }
    release();
    for (const [index, entry] of cases.entries()) {
      const pill = prose.nth(index);
      await expect(pill).toHaveAttribute("data-github-state", entry.state);
      const label = `${entry.kind === "issue" ? "Issue" : "Pull request"} Example/SomeRepo#${entry.number} · ${entry.label}`;
      await expect(pill.locator("xpath=ancestor::a[1]")).toHaveAccessibleName(label);
      await expect(pill.locator("xpath=ancestor::a[1]")).toHaveAttribute("title", label);
    }
    if ((page.viewportSize()?.width ?? 1280) < 1280) await page.locator(".ub-threads-toggle").click();
    const comments = page.locator(".ub-thread-text .ub-github-pill");
    await expect(comments).toHaveCount(cases.length);
    const paths = await prose.locator("path").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("d")));
    expect(paths[0]).toBe(unknownPaths[0]);
    expect(paths[4]).toBe(unknownPaths[4]);
    expect(new Set([paths[0], paths[1], paths[2]]).size).toBe(3);
    expect(paths[2]).toBe(paths[3]);
    expect(new Set(paths.slice(4)).size).toBe(4);
    for (const appearance of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: appearance });
      const expected = {
        green: appearance === "light" ? "rgb(26, 127, 55)" : "rgb(63, 185, 80)",
        purple: appearance === "light" ? "rgb(130, 80, 223)" : "rgb(163, 113, 247)",
        red: appearance === "light" ? "rgb(207, 34, 46)" : "rgb(248, 81, 73)",
        grey: await prose.first().locator(".ub-github-pill-repo").evaluate((node) => getComputedStyle(node).color),
      };
      for (const [index, entry] of cases.entries()) {
        const pill = prose.nth(index);
        await expect(pill.locator("svg")).toHaveCSS("color", expected[entry.color]);
        await expect(comments.nth(index)).toHaveAttribute("data-github-state", entry.state);
        await expect(comments.nth(index).locator("svg")).toHaveCSS("color", expected[entry.color]);
        expect(await pillStyle(pill)).toEqual(baselines.get(appearance)?.[index]);
        expect(await pill.locator("path").evaluate((node) => (node as SVGPathElement).getTotalLength())).toBeGreaterThan(10);
      }
      if (process.env.UB_AGENTS_SCRATCH !== undefined) await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH, `github-states-${info.project.name}-${appearance}.png`) });
    }
    await expect(page.locator(".ub-doc-rev")).toHaveText(revision);
    expect(requests).toHaveLength(1);
    const upstreamRequests: string[] = [];
    const upstream = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      upstream: true,
      beforeNavigate: async (opened) => {
        opened.on("request", (request) => { if (request.url().endsWith("/api/github-item-states")) upstreamRequests.push(request.url()); });
      },
    });
    await expect(upstream.locator(".ub-editor .ub-github-pill")).toHaveCount(cases.length);
    await expect(upstream.locator(".ub-editor .ub-github-pill").first()).toHaveAttribute("data-github-state", "unknown");
    await expect(upstream.locator(".ub-editor .ub-github-pill").first().locator("xpath=ancestor::a[1]"))
      .toHaveAccessibleName("Issue Example/SomeRepo#101 · State unknown");
    expect(upstreamRequests).toEqual([]);
  } finally { release(); }
});

async function newDoc(page: Page): Promise<string> {
  await page.goto(harness().appUrl);
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  const uuid = await createDoc(page, docTitle("GitHub pills"));
  await placeCaret(page);
  return uuid;
}

async function typeFixture(page: Page): Promise<void> {
  await newDoc(page);
  await page.keyboard.type(`before [${STORED}](${TARGET}) after`);
  await expect(page.locator(".ub-github-pill")).toHaveCount(1);
}

async function pastePlain(page: Page, text: string): Promise<void> {
  await editor(page).evaluate((element, value) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", value);
    element.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData: clipboard, bubbles: true, cancelable: true,
    }));
  }, text);
}

async function expectPopup(page: Page, activate: () => Promise<unknown>): Promise<void> {
  await page.context().route("https://github.com/**", route => route.fulfill({
    contentType: "text/html", body: "<p>GitHub destination</p>",
  }));
  const count = page.context().pages().length;
  const [popup] = await Promise.all([
    page.context().waitForEvent("page", { timeout: 5_000 }), activate(),
  ]);
  try {
    await popup.waitForLoadState();
    await expect(popup).toHaveURL(TARGET);
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    expect(await popup.evaluate(() => document.referrer)).toBe("");
    await expectOpenPages(page.context(), count + 1);
  } finally {
    await popup.close();
    await page.bringToFront();
  }
}

async function selectParagraph(page: Page): Promise<void> {
  await placeCaret(page, "start");
  await editor(page).locator(":scope > p").first().evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press("Shift");
  await expect(page.getByRole("toolbar", { name: "Text formatting and comment" })).toBeVisible();
}

async function selectLinkText(link: Locator, from: number, to: number): Promise<void> {
  await link.evaluate((element, offsets) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest(".ub-github-pill, .ProseMirror-yjs-cursor") === null
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    const point = (offset: number): [Text, number] => {
      for (const text of texts) {
        if (offset <= text.length) return [text, offset];
        offset -= text.length;
      }
      throw new Error("e2e: reference selection is outside the stored text");
    };
    const range = document.createRange();
    range.setStart(...point(offsets.from));
    range.setEnd(...point(offsets.to));
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { from, to });
  await link.page().keyboard.press("Shift");
}

async function archiveDoc(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Archive document" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive", exact: true }).click();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
}

test("only link text naming its GitHub issue or pull request becomes a pill", async ({ page }) => {
  await newDoc(page);
  const accepted = [
    { text: "#12", href: "https://github.com/Example/SomeRepo/issues/12#issuecomment-1", name: "Issue Example/SomeRepo#12 · State unknown" },
    { text: "somerepo#12", href: TARGET, name: "Pull request Example/SomeRepo#12 · State unknown" },
    { text: "example/SOMEREPO#12", href: TARGET, name: "Pull request Example/SomeRepo#12 · State unknown" },
    { text: "http://github.com/Other/repo/issues/9", href: "http://github.com/Other/repo/issues/9", name: "Issue Other/repo#9 · State unknown" },
  ];
  const ordinary = [
    { text: "the launcher fix", href: TARGET },
    { text: "#13", href: TARGET },
    { text: "wrong-repo#12", href: TARGET },
    { text: "another/SomeRepo#12", href: TARGET },
    { text: "#12", href: "https://github.com/Example/SomeRepo" },
    { text: "#12", href: "https://github.com/Example/SomeRepo/commit/12" },
    { text: "#12", href: "https://github.com/Example/SomeRepo/discussions/12" },
    { text: "#12", href: "https://github.com/Example/SomeRepo/blob/main/12" },
    { text: "#12", href: "https://github.example.com/Example/SomeRepo/issues/12" },
  ];
  for (const item of [...accepted, ...ordinary]) await page.keyboard.type(`[${item.text}](${item.href}) · `);
  const links = page.locator(".ub-editor a.ub-link");
  await expect(links).toHaveCount(accepted.length + ordinary.length);
  await expect(page.locator(".ub-github-pill")).toHaveCount(accepted.length);
  for (const [index, item] of accepted.entries()) {
    const link = links.nth(index);
    await expect(link).toHaveAttribute("href", item.href);
    await expect(link).toHaveAccessibleName(item.name);
    await expect(link).toHaveAttribute("title", item.name);
    await expect(link.locator(".ub-github-pill-repo")).toHaveText(index === 3 ? "repo" : "SomeRepo");
    await expect(link.locator(".ub-github-pill-number")).toHaveText(index === 3 ? "#9" : "#12");
    await expect(link.locator("svg")).toHaveCount(1);
  }
  for (const [offset, item] of ordinary.entries()) {
    const link = links.nth(accepted.length + offset);
    await expect(link).toHaveText(item.text);
    await expect(link.locator(".ub-github-pill")).toHaveCount(0);
  }
  await page.locator(".ub-title").click();
  const rev = await page.locator(".ub-doc-rev").innerText();
  await page.reload();
  await expect(page.locator(".ub-github-pill")).toHaveCount(accepted.length);
  await expect(page.locator(".ub-doc-rev")).toHaveText(rev);
});

test("lone plain-text GitHub paste keeps the original address and immediately shows the full-reference pill", { tag: "@webkit" }, async ({ page }) => {
  await newDoc(page);
  await pastePlain(page, TARGET);
  const link = page.locator(".ub-editor a.ub-link");
  await expect(link).toHaveAttribute("href", TARGET);
  await expect(link.locator(".ub-github-pill")).toBeVisible();
  await expect(link.locator(".ub-github-link-text")).toHaveText(STORED);
  // The paste ends at the link's edge, where it must already be a pill.
  await page.keyboard.press("ArrowLeft");
  await expect(link.locator(".ub-github-pill")).toHaveCount(0);
  await expect(link).toHaveText(STORED);
  await page.keyboard.press("ArrowRight");
  await expect(link.locator(".ub-github-pill")).toBeVisible();
  await page.keyboard.press("Enter");
  await pastePlain(page, `see ${TARGET} first`);
  const second = page.locator(".ub-editor a.ub-link").nth(1);
  await expect(second).toHaveAttribute("href", TARGET);
  await expect(second.locator(".ub-github-link-text")).toHaveText(TARGET);
  await page.keyboard.press("Enter");
  await pastePlain(page, "https://example.invalid/plain");
  await expect(page.locator('.ub-editor a.ub-link[href="https://example.invalid/plain"]')).toHaveText("https://example.invalid/plain");
  await page.reload();
  await expect(page.locator(".ub-github-pill")).toHaveCount(2);
});

test("GitHub paste shortcuts preserve a table cell's single paragraph and longer pasted text", { tag: "@webkit" }, async ({ page }, info) => {
  await newDoc(page);
  await page.keyboard.type("/table");
  await page.keyboard.press("Enter");
  const headers = page.locator(".ub-table th");
  await expect(headers).toHaveCount(3);
  await placeCaretIn(headers.first(), { touch: info.project.use.hasTouch === true });
  await pastePlain(page, TARGET);
  await expect(headers.first().locator(".ub-github-pill")).toBeVisible();
  await expect(headers.first().locator(".ub-github-link-text")).toHaveText(STORED);
  await expect(headers.first().locator("p")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await pastePlain(page, `see ${TARGET} first`);
  await expect(headers.nth(1)).toHaveText(`see ${TARGET} first`);
  await expect(headers.nth(1).locator("a.ub-link")).toHaveCount(0);
  await expect(headers.nth(1).locator("p")).toHaveCount(1);
  await expect(headers).toHaveCount(3);
});

test("strict interior caret and ranges reveal editable stored text; both edges keep the pill", { tag: "@webkit" }, async ({ page }) => {
  await typeFixture(page);
  const pill = page.locator(".ub-github-pill");
  const link = page.locator(".ub-editor a.ub-link");
  await placeCaret(page);
  for (let index = 0; index < " after".length; index += 1) await page.keyboard.press("ArrowLeft");
  await expect(pill).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(pill).toHaveCount(0);
  await expect(link).toHaveText(STORED);
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("1");
  await expect(pill).toHaveCount(0);
  await placeCaret(page, "start");
  for (let index = 0; index < "before ".length; index += 1) await page.keyboard.press("ArrowRight");
  await expect(pill).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(pill).toHaveCount(0);
  await page.keyboard.type("x");
  await placeCaret(page);
  await expect(pill).toHaveCount(0);
  await expect(link).toHaveText("Exxample/SomeRepo#12");
});

test("local and remote edits to text and address repaint without reloading either reader", async ({ browser }) => {
  const page = await openApp(browser);
  await newDoc(page);
  await page.keyboard.type(`[#the blocker12](${TARGET})`);
  const peer = await openApp(browser, new URL(page.url()).pathname, { upstream: true });
  await expect(peer.locator(".ub-editor a.ub-link")).toHaveText("#the blocker12");
  await placeCaret(page, "start");
  await selectLinkText(page.locator(".ub-editor a.ub-link"), 1, 12);
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("the blocker");
  await page.keyboard.press("Backspace");
  await placeCaret(page);
  await expect(page.locator(".ub-github-pill")).toBeVisible();
  await expect(peer.locator(".ub-github-pill")).toBeVisible();
  await selectParagraph(peer);
  await peer.getByRole("button", { name: "External link", exact: true }).click();
  await peer.getByLabel("External link URL").fill("https://github.com/Example/SomeRepo/issues/13");
  await peer.getByRole("button", { name: "Apply", exact: true }).click();
  await peer.locator(".ub-title").click();
  await expect(page.locator(".ub-github-pill")).toHaveCount(0);
  await expect(peer.locator(".ub-github-pill")).toHaveCount(0);
  await selectParagraph(peer);
  await peer.getByRole("button", { name: "External link", exact: true }).click();
  await peer.getByLabel("External link URL").fill(TARGET);
  await peer.getByRole("button", { name: "Apply", exact: true }).click();
  await peer.locator(".ub-title").click();
  await expect(page.locator(".ub-github-pill")).toBeVisible();
  await expect(peer.locator(".ub-github-pill")).toBeVisible();
  await placeCaret(peer, "start");
  await peer.keyboard.press("ArrowRight");
  await peer.keyboard.type("other");
  await peer.locator(".ub-title").click();
  await expect(page.locator(".ub-github-pill")).toHaveCount(0);
  await expect(page.locator(".ub-editor a.ub-link")).toHaveText("#other12");
});

test("copying a range serializes stored text and its ordinary link, with no presentation DOM", async ({ page }) => {
  await typeFixture(page);
  await selectParagraph(page);
  const copied = await editor(page).evaluate((element) => {
    const clipboard = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { clipboardData: clipboard, bubbles: true, cancelable: true }));
    return { text: clipboard.getData("text/plain"), html: clipboard.getData("text/html") };
  });
  expect(copied.text).toBe(`before ${STORED} after`);
  expect(copied.html).toContain(`href="${TARGET}"`);
  expect(copied.html).toContain(STORED);
  expect(copied.html).not.toContain("ub-github");
  expect(copied.html).not.toContain("<svg");
});

test("pill clicks follow the address in editable and read-only prose while Shift extends selection", { tag: "@webkit" }, async ({ page }) => {
  await typeFixture(page);
  const pill = page.locator(".ub-github-pill");
  await page.reload();
  await expect(pill).toBeVisible();
  await expectPopup(page, () => pill.click());
  await placeCaret(page, "start");
  await pill.click({ modifiers: ["Shift"] });
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString() ?? "")).toMatch(/^before /);
  await expect(page.getByRole("toolbar", { name: "Text formatting and comment" })).toBeVisible();
  await provePageArrival(page, { path: "browser context" });
  await expectOpenPages(page.context(), 1);
  await placeCaret(page);
  await archiveDoc(page);
  await page.reload();
  await expect(pill).toBeVisible();
  await expectPopup(page, () => pill.click());
});

async function commentPill(page: Page): Promise<void> {
  await placeCaret(page);
  await selectLinkText(page.locator(".ub-editor a.ub-link"), STORED.length - 2, STORED.length);
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("12");
  await expect(page.getByRole("toolbar", { name: "Text formatting and comment" })).toBeVisible();
  await page.getByRole("button", { name: "Comment", exact: true }).and(page.locator("[data-selection-tool], .ub-composer button")).click();
  await page.getByPlaceholder(/Comment as/).fill("Pill evidence comment");
  await page.keyboard.press("Enter");
  await page.reload();
  const pill = page.locator(".ub-github-pill");
  await expect(pill).toBeVisible();
  const link = pill.locator("xpath=ancestor::a[1]");
  await expect(link).toHaveAccessibleName("Pull request Example/SomeRepo#12 · State unknown");
  await expect(link).toHaveAttribute("href", TARGET);
  await expect.poll(() => pill.evaluate(element => {
    const comment = element.closest("[data-comment-thread]");
    return comment !== null && getComputedStyle(comment).backgroundColor !== "rgba(0, 0, 0, 0)";
  })).toBe(true);
}

test("comment highlights stay visible on a pill and Comments can open its thread", async ({ page }, info) => {
  await typeFixture(page);
  await commentPill(page);
  if (process.env.UB_AGENTS_SCRATCH !== undefined) {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH, `github-pill-comment-${info.project.name}-${colorScheme}.png`) });
    }
  }
  await expectPopup(page, () => page.locator(".ub-github-pill").click());
  await expect(page.locator('.ub-thread[aria-current="true"]')).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 1280) < 1280) await page.locator(".ub-threads-toggle").click();
  await page.locator(".ub-thread-card .ub-thread").filter({ hasText: "Pill evidence comment" }).click();
  await expect(page.locator('.ub-thread[aria-current="true"]')).toHaveCount(1);
});

async function pillStyle(pill: Locator): Promise<Record<string, string>> {
  return pill.evaluate((element) => {
    const style = getComputedStyle(element);
    const repo = element.querySelector(".ub-github-pill-repo");
    const number = element.querySelector(".ub-github-pill-number");
    if (repo === null || number === null) throw new Error("e2e: pill parts are missing");
    const repoStyle = getComputedStyle(repo);
    const numberStyle = getComputedStyle(number);
    return { fill: style.backgroundColor, border: style.borderTopWidth, radius: style.borderTopLeftRadius,
      decoration: style.textDecorationLine, transform: style.textTransform, spacing: style.letterSpacing,
      weight: style.fontWeight, repoColor: repoStyle.color, repoWeight: repoStyle.fontWeight,
      numberColor: numberStyle.color, numberWeight: numberStyle.fontWeight };
  });
}

test("light and dark pills keep the same typography in prose, table headers and card footers", { tag: "@webkit" }, async ({ page }, info) => {
  await typeFixture(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type("/table");
  await page.keyboard.press("Enter");
  const header = page.locator(".ub-table th").first();
  await placeCaretIn(header, { touch: info.project.use.hasTouch === true });
  await page.keyboard.type(`[${STORED}](${TARGET})`);
  await page.locator(".ub-title").click();
  await expect(header.locator(".ub-github-pill")).toBeVisible();
  // Insert through block chrome rather than using Enter inside the cell.
  await placeCaretIn(page.locator(".ub-table th").last(), { touch: info.project.use.hasTouch === true });
  await page.getByRole("button", { name: "Insert block below", exact: true }).click();
  await page.getByRole("option", { name: "Card", exact: true }).click();
  await page.keyboard.type("Evidence");
  const footer = page.locator(".ub-card-footer");
  await footer.locator("p").click();
  await page.keyboard.type(`source [${STORED}](${TARGET})`);
  await page.locator(".ub-title").click();
  const prose = editor(page).locator(":scope > p .ub-github-pill").first();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const baseline = await pillStyle(prose);
    expect(baseline).toMatchObject({ border: "1px", decoration: "none", transform: "none" });
    expect(baseline.fill).not.toBe("rgba(0, 0, 0, 0)");
    expect(baseline.repoColor).not.toBe(baseline.numberColor);
    expect(Number(baseline.numberWeight)).toBeGreaterThan(Number(baseline.repoWeight));
    expect(await pillStyle(header.locator(".ub-github-pill"))).toEqual(baseline);
    expect(await pillStyle(footer.locator(".ub-github-pill"))).toEqual(baseline);
    await expect(footer).toHaveCSS("text-transform", "uppercase");
    if (process.env.UB_AGENTS_SCRATCH !== undefined) {
      await page.screenshot({ path: join(process.env.UB_AGENTS_SCRATCH, `github-pills-${info.project.name}-${colorScheme}.png`) });
    }
  }
});

test("hovering a pill shows the link cursor, underlines its text and lifts its fill; the issue icon is a ring around a dot", { tag: "@webkit" }, async ({ page }, info) => {
  test.skip(info.project.use.hasTouch === true, "Hover needs a pointer.");
  await newDoc(page);
  await page.keyboard.type(`[${STORED}](${TARGET}) and [#7](https://github.com/Example/SomeRepo/issues/7)`);
  await page.locator(".ub-title").click();
  const pills = page.locator(".ub-github-pill");
  await expect(pills).toHaveCount(2);
  await expect(pills.nth(0).locator("svg circle")).toHaveCount(0);
  await expect(pills.nth(1).locator("svg circle")).toHaveCount(1);
  const pill = pills.first();
  const number = pill.locator(".ub-github-pill-number");
  await expect(number).toHaveCSS("text-decoration-line", "none");
  const resting = await pill.evaluate(element => getComputedStyle(element).backgroundColor);
  await pill.hover();
  for (const part of [pill, number, pill.locator(".ub-github-pill-repo"), pill.locator("svg")]) {
    await expect(part).toHaveCSS("cursor", "pointer");
  }
  await expect(number).toHaveCSS("text-decoration-line", "underline");
  await expect(pill.locator(".ub-github-pill-repo")).toHaveCSS("text-decoration-line", "underline");
  await expect.poll(() => pill.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(resting);
  if (process.env.UB_AGENTS_SCRATCH !== undefined) {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await editor(page).locator(":scope > p").first().screenshot({
        path: join(process.env.UB_AGENTS_SCRATCH, `github-pill-hover-${info.project.name}-${colorScheme}.png`),
      });
    }
  }
  await page.mouse.move(0, 0);
  await expect(number).toHaveCSS("text-decoration-line", "none");
});
