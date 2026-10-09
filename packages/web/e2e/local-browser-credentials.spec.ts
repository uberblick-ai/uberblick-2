/** An open page survives local serving restarts and credential changes. */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createDoc, docTitle, editor, openDoc, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";

const { harness, openApp } = setupHarness({ app: { readySelector: ".ub-list-head" } });

async function documentText(page: Page): Promise<string | null> {
  return editor(page).evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement;
    for (const cursor of copy.querySelectorAll(".ProseMirror-yjs-cursor")) cursor.remove();
    return copy.textContent;
  });
}

async function statusGeometry(page: Page) {
  const [status, prose, updated] = await Promise.all([
    page.locator(".ub-status").boundingBox(),
    editor(page).locator(":scope > *").first().boundingBox(),
    page.locator(".ub-last-updated").boundingBox(),
  ]);
  expect(status).not.toBeNull();
  expect(prose).not.toBeNull();
  expect(updated).not.toBeNull();
  return { status, proseY: prose?.y, updated };
}

test("local-only edits survive a restart and reach the hub after authentication returns", async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await openApp(browser, "/", { contextOptions: { reducedMotion: "reduce" } });
  // A shared-secret connection has no GitHub account to claim, even though
  // the hub accepts edits from this running local service.
  await expect(page.getByTestId("account-menu")).toContainText("Not signed in");
  await createDoc(page, docTitle("local-credentials"), { pin: true });
  await placeCaret(page);
  await page.keyboard.type("before restart");
  const observer = await openApp(browser, new URL(page.url()).pathname, { upstream: true });
  await expect.poll(() => documentText(observer)).toBe("before restart");

  const pageInstance = await page.evaluate(() => performance.timeOrigin);
  const saved = page.locator(".ub-status-word--saved");
  const shared = page.locator(".ub-status-word--hub");
  const reason = page.locator("[data-sonner-toast]").filter({ has: page.locator("[data-description]", { hasText: "this machine has no credentials for its hub" }) });
  await expect(shared).toHaveText("synced with hub");
  const authenticatedGeometry = await statusGeometry(page);

  await harness().restartOpen({ authenticated: false });
  await expect(saved).toHaveText("saved here");
  await expect(shared).toHaveText("not shared with hub");
  await expect(reason).toBeVisible();
  await expect(reason).toHaveAttribute("data-type", "warning");
  await expect(page.locator(".ub-status")).not.toContainText("this machine has no credentials for its hub");
  await expect(page.getByTestId("account-menu")).toContainText("Account unavailable");
  expect(await statusGeometry(page)).toEqual(authenticatedGeometry);
  for (const width of [320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(reason).toBeInViewport({ ratio: 1 });
    const trigger = page.locator(".ub-sync-toggle");
    await expect(trigger).toBeInViewport({ ratio: 1 });
    await trigger.click();
    await expect(page.locator('.ub-sync-fact:has(dt:text-is("Reason")) dd'))
      .toHaveText("this machine has no credentials for its hub");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Sync and presence", exact: true })).toHaveCount(0);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await placeCaret(page);
  await page.keyboard.type("; saved locally");
  await expect(saved).toHaveText("saved here");
  await expect.poll(() => documentText(observer)).toBe("before restart");
  const localGeometry = await statusGeometry(page);

  // This page retains its original imported browser key on another local-only
  // boot, as well as across both authentication transitions below.
  await harness().restartOpen({ authenticated: false });
  await expect(saved).toHaveText("saved here");
  await expect(shared).toHaveText("not shared with hub");
  await expect.poll(() => documentText(page)).toBe("before restart; saved locally");
  expect(await statusGeometry(page)).toEqual(localGeometry);

  await harness().restartOpen({ authenticated: true });
  await expect.poll(() => documentText(observer)).toBe("before restart; saved locally");
  await expect(shared).toHaveText("synced with hub");
  await expect(reason).toBeHidden();
  await expect(page.getByTestId("account-menu")).toContainText("Not signed in");
  expect(await statusGeometry(page)).toEqual(localGeometry);

  await harness().restartOpen({ authenticated: false });
  await expect(saved).toHaveText("saved here");
  await expect(shared).toHaveText("not shared with hub");
  await expect(reason).toBeVisible();
  expect(await statusGeometry(page)).toEqual(localGeometry);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(pageInstance);
});

test("local-only status answers leave the readings and prose in place", async ({ browser }) => {
  test.setTimeout(90_000);
  const seed = await openApp(browser);
  const titles = [docTitle("geometry-a"), docTitle("geometry-b")] as const;
  const paths: string[] = [];
  for (const title of titles) {
    await createDoc(seed, title, { pin: true });
    await placeCaret(seed);
    await seed.keyboard.type("the prose stays here");
    await expect(seed.locator(".ub-status-word--saved")).toHaveText("saved here");
    paths.push(new URL(seed.url()).pathname);
  }
  await seed.close();
  await harness().restartOpen({ authenticated: false });

  for (const width of [1280, 820, 320]) {
    // Withhold usable API answers until after the local room has settled. A
    // fresh page has no earlier serving reason to keep through this blank.
    let blankAnswers = true;
    let failNext = false;
    const page = await openApp(browser, paths[0], {
      contextOptions: { viewport: { width, height: 844 }, hasTouch: width === 820, reducedMotion: "reduce" },
      readySelector: ".ub-editor .ProseMirror",
      beforeNavigate: async (opening) => {
        await opening.route("**/api/status", async (route) => {
          if (blankAnswers || failNext) {
            failNext = false;
            await route.abort();
          } else {
            await route.continue();
          }
        });
      },
    });
    const pageInstance = await page.evaluate(() => performance.timeOrigin);
    const saved = page.locator(".ub-status-word--saved");
    const shared = page.locator(".ub-status-word--hub");
    const reason = page.locator("[data-sonner-toast]").filter({ has: page.locator("[data-description]", { hasText: "this machine has no credentials for its hub" }) });
    await expect(saved).toHaveText("saved here");
    await expect(shared).toHaveText("");
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    const beforeFirstAnswer = await statusGeometry(page);
    blankAnswers = false;
    await expect(reason).toBeVisible();
    expect(await statusGeometry(page)).toEqual(beforeFirstAnswer);
    await expect(shared).toHaveText("not shared with hub");
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);
    expect(await statusGeometry(page)).toEqual(beforeFirstAnswer);

    for (const title of [titles[1], titles[0]]) {
      blankAnswers = true;
      if (width < 1280) {
        await page.getByRole("button", { name: "Show document list", exact: true }).focus();
        await page.keyboard.press("Enter");
      }
      await openDoc(page, title);
      await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toHaveCount(0);
      await expect(saved).toHaveText("saved here");
      await expect(shared).toHaveText("");
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      expect(await statusGeometry(page)).toEqual(beforeFirstAnswer);
      blankAnswers = false;
      await expect(shared).toHaveText("not shared with hub");
      await expect(reason).toBeVisible();
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);
      expect(await statusGeometry(page)).toEqual(beforeFirstAnswer);
    }

    failNext = true;
    await expect(shared).toHaveText("");
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    expect(await statusGeometry(page)).toEqual(beforeFirstAnswer);
    await expect(shared).toHaveText("not shared with hub");
    await expect(reason).toBeVisible();
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);
    expect(await statusGeometry(page)).toEqual(beforeFirstAnswer);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(pageInstance);
    // Keyboard navigation leaves the recovery notice undismissed; entering
    // Settings must resolve it when the document header unmounts.
    if (width < 1280) {
      await page.getByRole("button", { name: "Show document list", exact: true }).focus();
      await page.keyboard.press("Enter");
    }
    await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
    await expect(page.locator(".ub-status")).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await page.close();
  }
});


for (const appearance of ["light", "dark"] as const) {
test(`device recovery notices preserve local editing and native tablet touch controls — ${appearance}`, async ({ browser }) => {
  test.setTimeout(90_000);
  await harness().restartOpen({ authenticated: true });
  let notSharedReason: "no-hub-credentials" | "sign-in-required" | "no-workspace-access" | "credential-store" | "renewal-unavailable" | null = null;
  const page = await openApp(browser, "/", {
    contextOptions: { viewport: { width: 820, height: 1180 }, hasTouch: true, colorScheme: appearance },
    readySelector: ".ub-docs-heading",
    beforeNavigate: async (opening) => {
      await opening.route("**/api/status", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.notSharedReason = notSharedReason;
        if (notSharedReason !== null) {
          body.caughtUp = false;
          for (const room of Object.values(body.rooms) as Array<{ hubAcked: boolean }>) {
            room.hubAcked = false;
          }
        }
        await route.fulfill({ response, json: body });
      });
    },
  });
  if ((page.viewportSize()?.width ?? 1280) < 1280) {
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
  }
  await createDoc(page, docTitle("device-recovery"));
  await placeCaret(page);
  await page.keyboard.type("kept here");
  const saved = page.locator(".ub-status-word--saved");
  const shared = page.locator(".ub-status-word--hub");
  await expect(shared).toHaveText("synced with hub");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  // A new document clears this marker; pagehide also catches a departure
  // followed by restoration from the back/forward cache. Clock readings vary.
  const samePageMarker = "__uberblickDeviceRecoveryPage";
  await page.evaluate((key) => {
    const originalWindow = window as unknown as Record<string, unknown>;
    originalWindow[key] = true;
    window.addEventListener("pagehide", () => {
      originalWindow[key] = false;
    }, { once: true });
  }, samePageMarker);

  notSharedReason = "sign-in-required";
  await expect(saved).toHaveText("saved here");
  await expect(shared).toHaveText("not shared with hub");
  const notices = page.locator("[data-sonner-toast]");
  await expect(notices).toHaveCount(1);
  await expect(notices).toHaveAttribute("data-type", "warning");
  await expect(notices).toContainText(/run ub auth login/);
  await expect(notices).toBeInViewport();
  await expect(page.locator(".ub-status")).not.toContainText(/run ub auth login/);
  // The tablet uses the primitive's native close control. Dismissing the
  // notice leaves the unresolved compact fact and its recovery discoverable.
  await notices.getByRole("button", { name: "Dismiss notification" }).tap();
  await expect(notices).toHaveCount(0);
  await expect(shared).toHaveText("not shared with hub");
  await page.getByRole("button", { name: /^Sync details/ }).tap();
  await expect(page.locator('.ub-sync-fact:has(dt:text-is("Reason")) dd')).toContainText(/run ub auth login/);
  await page.keyboard.press("Escape");
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await placeCaret(page);
  await page.keyboard.type("; edited while sign-in is required");
  await expect(saved).toHaveText("saved here");
  await expect(notices).toHaveCount(0);

  notSharedReason = "no-workspace-access";
  await expect(notices).toHaveCount(1);
  await expect(notices).toContainText(/ask its administrator for membership/);
  await expect(notices).toBeInViewport();
  await expect(saved).toHaveText("saved here");
  await expect(shared).toHaveText("not shared with hub");
  await page.locator(".ub-title").focus();
  await page.keyboard.press("Shift+F8");
  await expect(page.locator("[data-sonner-toaster]")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(notices).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(notices.getByRole("button", { name: "Dismiss notification" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(notices).toHaveCount(0);
  await expect(page.locator(".ub-title")).toBeFocused();
  await expect(shared).toHaveText("not shared with hub");
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await placeCaret(page);
  await page.keyboard.type("; edited while membership is refused");
  await expect(saved).toHaveText("saved here");
  await expect.poll(() => documentText(page))
    .toBe("kept here; edited while sign-in is required; edited while membership is refused");

  for (const [cause, recovery] of [
    ["no-hub-credentials", "this machine has no credentials for its hub"],
    ["credential-store", "this machine cannot read its login — run ub auth status and follow its credential-store recovery"],
    ["renewal-unavailable", "this hub cannot renew the login — ask its operator to configure sign-in"],
  ] as const) {
    notSharedReason = cause;
    await expect(notices).toHaveCount(1);
    await expect(notices).toContainText(recovery);
    await expect(notices).toHaveAttribute("data-type", "warning");
    await expect(shared).toHaveText("not shared with hub");
    await expect(saved).toHaveText("saved here");
    await expect(page.locator(".ub-status")).not.toContainText(recovery);
    await page.getByRole("button", { name: /^Sync details/ }).tap();
    await expect(page.locator('.ub-sync-fact:has(dt:text-is("Reason")) dd')).toHaveText(recovery);
    await page.keyboard.press("Escape");
    if (cause === "no-hub-credentials") {
      await page.evaluate(() => {
        (window as unknown as { statusCauseNotice: Element | null }).statusCauseNotice = document.querySelector("[data-sonner-toast]");
      });
    } else {
      expect(await page.evaluate(() => document.querySelector("[data-sonner-toast]") ===
        (window as unknown as { statusCauseNotice: Element | null }).statusCauseNotice), "a changed cause updates its existing notice").toBe(true);
    }
  }

  notSharedReason = null;
  await expect(shared).toHaveText("synced with hub");
  await expect(notices).toHaveCount(0);
  expect(await page.evaluate(
    (key) => (window as unknown as Record<string, unknown>)[key] === true,
    samePageMarker,
  )).toBe(true);
});
}
