/** The shared page frame through real routes, fonts and supported device input. */
import { devices, expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { activateControl, createDoc, setupHarness } from "./app-helpers.js";

async function shell(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  return page.locator(".ub-pane").evaluate((pane) => {
    const column = pane.querySelector<HTMLElement>(":scope > .ub-column");
    const title = pane.querySelector<HTMLElement>(".ub-title");
    const next = title?.nextElementSibling;
    if (!column || !title || !next) throw new Error("e2e: incomplete page shell");
    const c = column.getBoundingClientRect();
    const t = title.getBoundingClientRect();
    const style = getComputedStyle(title);
    const opener = document.querySelector<HTMLElement>(".ub-sidebar-restore");
    const o = opener?.getBoundingClientRect();
    const visibleOpener = opener !== null && o !== undefined && o.width > 0 && o.height > 0;
    const hit = visibleOpener ? document.elementFromPoint(o.left + o.width / 2, o.top + o.height / 2) : null;
    return {
      titleLeft: t.left,
      contentLeft: c.left + Number.parseFloat(getComputedStyle(column).paddingLeft),
      columnWidth: c.width,
      gap: next.getBoundingClientRect().top - t.bottom,
      face: style.fontFamily,
      size: style.fontSize,
      leading: style.lineHeight,
      weight: style.fontWeight,
      tracking: style.letterSpacing,
      paneOverflow: pane.scrollWidth - pane.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      openerClear: !visibleOpener || (innerWidth < 1280
        ? pane.getBoundingClientRect().top >= o.bottom && t.top >= o.bottom : t.left >= o.right),
      openerReachable: !visibleOpener || (hit !== null && opener.contains(hit)),
    };
  });
}

type Shell = Awaited<ReturnType<typeof shell>>;

async function expectShell(page: Page, reference?: Shell): Promise<Shell> {
  const actual = await shell(page);
  expect(actual.face).toContain("Fraunces");
  expect(actual.size).toBe("36px");
  expect(actual.leading).toBe("42px");
  expect(actual.weight).toBe("500");
  expect(actual.titleLeft).toBeCloseTo(actual.contentLeft, 1);
  expect(actual.paneOverflow).toBeLessThanOrEqual(1);
  expect(actual.pageOverflow).toBeLessThanOrEqual(1);
  expect(actual.openerClear).toBe(true);
  expect(actual.openerReachable).toBe(true);
  if (reference !== undefined) {
    expect(Math.abs(actual.titleLeft - reference.titleLeft)).toBeLessThanOrEqual(1);
    expect(actual.columnWidth).toBeLessThanOrEqual(reference.columnWidth + 1);
    expect(Math.abs(actual.gap - reference.gap)).toBeLessThanOrEqual(1);
    expect(actual.tracking).toBe(reference.tracking);
  }
  if (reference !== undefined && await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)) {
    const shortControls = await page.locator(".ub-pane button:visible, .ub-pane input:visible, .ub-pane select:visible, .ub-pane textarea:visible")
      .evaluateAll((elements) => elements.filter((element) => element.getBoundingClientRect().height < 44).map((element) => element.getAttribute("aria-label") ?? element.id ?? element.textContent));
    expect(shortControls).toEqual([]);
  }
  return actual;
}

test.describe("one page shell", () => {
  const { harness, openApp } = setupHarness({ accessRole: "admin", hubAdmin: true });
  let documentUuid = "";

  test.beforeAll(async ({ browser }) => {
    const page = await openApp(browser, "/", {
      contextOptions: { viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false },
      readySelector: ".ub-document-sidebar",
    });
    documentUuid = await createDoc(page, "The shared page frame");
    await page.locator(".ub-editor .ProseMirror").click();
    await page.keyboard.type("A document supplies the reference reading edge.");
    await expect.poll(() => harness().hubText(`${harness().workspaceUuid}/${documentUuid}`)).toContain("A document supplies the reference reading edge.");
    await page.context().close();
  });

  test("documents, list and Settings keep one frame", { tag: "@webkit" }, async ({ browser }, info) => {
    test.setTimeout(120_000);
    const touch = info.project.use.hasTouch === true;
    const page = await openApp(browser, `/${harness().workspace}/${documentUuid}`, {
      contextOptions: { ...(touch ? devices["iPad (gen 7)"] : { viewport: { width: 1440, height: 900 } }), reducedMotion: "reduce" },
      readySelector: ".ub-editor .ProseMirror",
    });
    for (const layout of touch ? ["ipad", "narrow-ipad"] as const : ["docked", "collapsed", "drawer"] as const) {
      await page.setViewportSize({ width: layout === "narrow-ipad" ? 600 : layout === "ipad" || layout === "drawer" ? 810 : 1440, height: 900 });
      await page.goto(new URL(`/${harness().workspace}/${documentUuid}`, harness().appUrl).href);
      await expect(page.locator(".ub-editor .ProseMirror")).toBeVisible();
      if (layout === "collapsed") await activateControl(page.getByRole("button", { name: "Hide document list", exact: true }));
      const reference = await expectShell(page);
      const proseLeft = await page.locator(".ub-editor .ub-paragraph").first().evaluate((node) => node.getBoundingClientRect().left);
      expect(proseLeft).toBeCloseTo(reference.titleLeft, 1);
      if (layout === "docked") expect(reference.titleLeft).toBe(332);
      if (layout === "collapsed") expect(reference.titleLeft).toBe(92);
      if (layout === "ipad" || layout === "drawer") expect(reference.titleLeft).toBe(44);
      const documentImage = info.outputPath(`document-${layout}.png`);
      await page.screenshot({ path: documentImage });
      await info.attach(`Document ${layout}`, { path: documentImage, contentType: "image/png" });
      for (const [suffix, title, ready] of [
        ["all", "All documents", ".ub-docs-table"],
        ["settings", "General", "#ub-workspace-name"],
        ["settings/tags", "Tags", "#ub-new-tag"],
        ["settings/members", "Members", 'table[aria-label="Members"]'],
        ["settings/preferences", "Preferences", '.ub-appearance'],
        ["settings/devices", "Devices", 'table[aria-label="Devices"]'],
        ["settings/hub-admins", "Admins", 'table[aria-label="Hub admins"]'],
        ["settings/hub-workspaces", "Workspaces", 'table[aria-label="Hub workspaces"]'],
      ] as const) {
        await test.step(`${layout}: ${title}`, async () => {
          await page.goto(new URL(`/${harness().workspace}/${suffix}`, harness().appUrl).href);
          await expect(page.locator(ready)).toBeVisible();
          await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
          await expectShell(page, reference);
          if (suffix.startsWith("settings")) await expect(page.locator("[data-settings-page]")).toHaveAttribute("aria-labelledby", "ub-settings-title");
          const image = info.outputPath(`${suffix.replaceAll("/", "-")}-${layout}.png`);
          await page.screenshot({ path: image });
          await info.attach(`${title} ${layout}`, { path: image, contentType: "image/png" });
          if (suffix === "all") {
            const count = page.getByRole("tab", { name: /^Documents/ }).locator(".ub-docs-tab-count");
            await expect(count).toHaveCSS("font-size", "13px");
            await expect(count).toHaveText("1");
            const search = page.getByRole("searchbox");
            await search.focus();
            await expect(search).toBeFocused();
          }
        });
      }
      if (touch) {
        const opener = page.getByRole("button", { name: "Show sidebar", exact: true });
        await opener.tap();
        await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(opener).toBeFocused();
      }
    }
  });

  test("loading and unavailable Settings retain the document frame", { tag: "@webkit" }, async ({ browser }, info) => {
    test.setTimeout(90_000);
    const touch = info.project.use.hasTouch === true;
    const contextOptions = { ...(touch ? devices["iPad (gen 7)"] : { viewport: { width: 1440, height: 900 } }), reducedMotion: "reduce" as const };
    const referencePage = await openApp(browser, `/${harness().workspace}/${documentUuid}`, { contextOptions, readySelector: ".ub-editor .ProseMirror" });
    const reference = await expectShell(referencePage);
    for (const [suffix, loading] of [["devices", "Reading devices from the hub…"], ["hub-admins", "Reading from the hub…"], ["hub-workspaces", "Reading from the hub…"]] as const) {
      const pending: Route[] = [];
      const page = await openApp(browser, `/${harness().workspace}/settings/${suffix}`, {
        contextOptions,
        beforeNavigate: async (target) => {
          await target.route("**/api/access", (route) => {
            const action = route.request().postDataJSON() as { operation: string };
            if (action.operation === "own-hub-role" || action.operation === "own-role" || action.operation === "list-member-usernames" ||
              (suffix !== "devices" && action.operation === "list-devices")) return route.continue();
            pending.push(route);
          });
        },
      });
      await expect(page.getByText(loading, { exact: true })).toBeVisible();
      await expectShell(page, reference);
      await expect.poll(() => pending.length).toBe(1);
      for (const route of pending) await route.fulfill({ json: { status: "hub-down", hub: null } });
      await expect(page.getByRole("alert").filter({ hasText: "The hub cannot be reached." })).toBeVisible();
      await expectShell(page, reference);
      await page.context().close();
    }
    for (const suffix of ["all", "settings/tags"]) {
      const replies: Array<() => void> = [];
      let hold = true;
      const waiting = await openApp(browser, `/${harness().workspace}/${suffix}`, {
        contextOptions,
        beforeNavigate: async (target) => {
          await target.routeWebSocket("**", (socket) => {
            const server = socket.connectToServer();
            server.onMessage((message) => { if (hold) replies.push(() => socket.send(message)); else socket.send(message); });
          });
        },
      });
      let searchTop: number | undefined;
      if (suffix === "all") {
        await expect(waiting.getByRole("tab", { name: /^Documents/ })).toBeVisible();
        await expect(waiting.locator(".ub-docs-tab-count")).toHaveCount(0);
        searchTop = (await waiting.getByRole("searchbox").boundingBox())?.y;
      } else await expect(waiting.getByText("Waiting for the tag catalog…", { exact: true })).toBeVisible();
      await expectShell(waiting, reference);
      hold = false;
      for (const send of replies.splice(0)) send();
      if (suffix === "all") {
        await expect(waiting.getByRole("tab", { name: /^Documents/ }).locator(".ub-docs-tab-count")).toHaveText("1");
        expect((await waiting.getByRole("searchbox").boundingBox())?.y).toBe(searchTop);
      } else await expect(waiting.locator("#ub-new-tag")).toBeEnabled();
      await expectShell(waiting, reference);
      await waiting.context().close();
    }
  });
});
