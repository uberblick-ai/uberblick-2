/** Native sidebar geometry and input: clipping an oversized scroller is not a fix. */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { setupHarness } from "./app-helpers.js";
import { createPinnedDoc } from "./sidebar-helpers.js";

const { harness } = setupHarness({ scope: "test" });
let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(harness().appUrl);
  await expect(page.locator(".ub-list-head")).toBeVisible();
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const activePane = (page: Page): Locator => page.locator(".ub-sidebar-pane:not([inert])");

async function openSidebar(page: Page, settings = false): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) >= 1280) return;
  if (await page.getByRole("dialog", { name: "Sidebar", exact: true }).count() === 0) {
    await page.getByRole("button", { name: settings ? "Show sidebar" : "Show document list", exact: true }).click();
  }
  await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toBeVisible();
}

async function settleSidebar(page: Page): Promise<void> {
  await page.locator(".ub-body").evaluate(async (body) => {
    await Promise.all(body.getAnimations({ subtree: true }).map((animation) =>
      animation.finished.catch(() => undefined),
    ));
  });
}

async function expectHorizontalFit(page: Page): Promise<void> {
  const geometry = await page.locator(".ub-list").evaluate((sidebar) => {
    const boxes = [sidebar, ...sidebar.querySelectorAll("*")]
      .filter((box): box is HTMLElement => box instanceof HTMLElement);
    return {
      // Hidden ellipsis labels intentionally have wider text. Only native
      // user-scrollable boxes owe equal content and visible widths.
      overflowing: boxes.filter((box) => {
        const style = getComputedStyle(box);
        return [style.overflowX, style.overflowY].some((overflow) => /^(auto|scroll)$/.test(overflow))
          && box.scrollWidth > box.clientWidth;
      })
        .map((box) => ({ className: box.className, width: box.clientWidth, content: box.scrollWidth })),
      panned: boxes.filter((box) => box.scrollLeft !== 0)
        .map((box) => ({ className: box.className, left: box.scrollLeft })),
    };
  });
  expect(geometry.overflowing).toEqual([]);
  expect(geometry.panned).toEqual([]);
}

async function horizontalWheel(page: Page): Promise<void> {
  const pane = activePane(page);
  await expect(pane).toBeVisible();
  await settleSidebar(page);
  const box = await pane.boundingBox();
  if (box === null) throw new Error("e2e: missing sidebar pane");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (const delta of [240, -240]) {
    // mouse.wheel returns before the renderer consumes the native event.
    // Wait for its wheel event and two frames before observing the offset.
    await activePane(page).evaluate((pane) => {
      pane.dataset.wheelConsumed = "false";
      pane.addEventListener("wheel", () => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          pane.dataset.wheelConsumed = "true";
        }));
      }, { once: true });
    });
    await page.mouse.wheel(delta, 0);
    await expect(activePane(page)).toHaveAttribute("data-wheel-consumed", "true");
    await expectHorizontalFit(page);
  }
}

async function addGroup(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "+ group", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Group name" });
  await expect(field).toBeFocused();
  await expectHorizontalFit(page);
  await field.fill(name);
  await field.press("Enter");
  await expect(page.locator(".ub-group-label").filter({ hasText: name })).toBeVisible();
}

test("empty and long-label sidebars fit supported widths and breakpoint edges in both modes", async ({ page }) => {
  for (const content of ["empty", "long labels"]) {
    if (content === "long labels") {
      await page.setViewportSize({ width: 1280, height: 832 });
      await createPinnedDoc(page, "A document title long enough to truncate within its sidebar row ".repeat(3));
      await createPinnedDoc(page, "unbreakable".repeat(25));
      await addGroup(page, "A group name long enough to truncate within its heading ".repeat(3));
      await addGroup(page, "unbreakablegroup".repeat(25));
    }
    for (const width of [320, 375, 744, 768, 932, 1024, 1279, 1280, 1366, 1470]) {
      await test.step(`${content} at ${width}px`, async () => {
        await page.setViewportSize({ width, height: 832 });
        await openSidebar(page);
        await settleSidebar(page);
        await expectHorizontalFit(page);
        await horizontalWheel(page);
        const pane = activePane(page);
        // The header, handles and hover-revealed group actions must fit as
        // boxes, rather than becoming invisible under an overflow rule.
        if (content === "long labels") await pane.locator(".ub-group-head").last().hover();
        const outside = await pane.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return [...element.querySelectorAll<HTMLElement>(
            ".ub-workspace, .ub-drag-handle, .ub-group-act, .ub-settings-entry, .ub-user-card",
          )].filter((control) => {
            const box = control.getBoundingClientRect();
            return box.left < bounds.left || box.right > bounds.right;
          }).map((control) => control.className);
        });
        expect(outside).toEqual([]);
        await page.locator(".ub-settings-entry").click();
        await openSidebar(page, true);
        await expect(page.locator(".ub-list")).toHaveAttribute("data-mode", "settings");
        await settleSidebar(page);
        await horizontalWheel(page);
        await page.locator(".ub-settings-back").click();
        await openSidebar(page);
        await settleSidebar(page);
        await expectHorizontalFit(page);
      });
    }
  }

  // The docked hide control overhangs its frame; the drawer's close control
  // fits inside it. Exercise the outer half of each to defend their hit area.
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 832 });
    await openSidebar(page);
    const hide = page.getByRole("button", { name: width < 1280 ? "Close document list" : "Hide document list", exact: true });
    const box = await hide.boundingBox();
    if (box === null) throw new Error("e2e: missing close control");
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
    if (width < 1280) {
      await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toHaveCount(0);
    } else {
      await expect(page.locator(".ub-list")).toHaveAttribute("inert", "");
    }
    await expect(page.getByRole("button", { name: "Show document list", exact: true })).toBeFocused();
    await settleSidebar(page);
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
    await settleSidebar(page);
    await expect(hide).toBeFocused();
    await expectHorizontalFit(page);
  }
});

test("edge-held drags never pan sideways and a tall sidebar still scrolls vertically", async ({ page }) => {
  for (let index = 0; index < 18; index += 1) await createPinnedDoc(page, `Document ${index}`);

  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 500 });
    await openSidebar(page);
    await settleSidebar(page);
    const pane = activePane(page);
    await pane.evaluate((element) => { element.scrollTop = 0; });
    await pane.hover();
    await page.mouse.wheel(0, 240);
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expectHorizontalFit(page);

    for (const edge of ["right", "left"] as const) {
      await pane.evaluate((element) => { element.scrollTop = 0; });
      const source = pane.locator(".ub-pin-row .ub-drag-handle").first();
      const from = await source.boundingBox();
      const bounds = await pane.boundingBox();
      if (from === null || bounds === null) throw new Error("e2e: missing drag source or pane");
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 8);
      await expect(source).toHaveAttribute("aria-pressed", "true");
      await page.mouse.move(edge === "right" ? bounds.x + bounds.width - 1 : bounds.x + 1,
        bounds.y + bounds.height - 5, { steps: 12 });
      // Reaching the bottom edge also proves the dnd-kit auto-scroller still
      // works vertically. Stay there for multiple frames and inspect every
      // box throughout the hold, so a transient pan cannot be hidden by drop.
      await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      const pannedDuringHold = await page.locator(".ub-list").evaluate(async (sidebar) => {
        const panned = new Set<string>();
        for (let frame = 0; frame < 30; frame += 1) {
          for (const box of [sidebar, ...sidebar.querySelectorAll("*")]) {
            if (!(box instanceof HTMLElement)) continue;
            if (box.scrollLeft !== 0) panned.add(box.className);
          }
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        return [...panned];
      });
      expect(pannedDuringHold).toEqual([]);
      if (edge === "left") {
        await page.keyboard.press("Escape");
        if (width < 1280) await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toBeVisible();
      }
      await page.mouse.up();
      await expect(page.locator("[data-dnd-dragging], [data-dnd-dropping]")).toHaveCount(0);
      await expectHorizontalFit(page);
    }
  }
});
