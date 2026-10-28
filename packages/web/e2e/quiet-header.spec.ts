/** The quiet header keeps real sync feedback and native document controls. */
import { expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { alphaOf, composite, contrast, pageGrounds } from "../test/colour.js";
import { createDoc, editor, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";

const { harness, openApp } = setupHarness();

async function pulseCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { headerPulses: number }).headerPulses);
}

async function expectNoRing(dot: Locator): Promise<void> {
  await expect.poll(() => dot.evaluate((node) => ({
    animations: node.getAnimations({ subtree: true }).length,
    opacity: getComputedStyle(node, "::after").opacity,
    name: getComputedStyle(node, "::after").animationName,
  }))).toEqual({ animations: 0, opacity: "0", name: "none" });
}

/** Sample the CSS separately from sync events, without racing the pulse cleanup timer. */
async function inspectRing(page: Page, info: TestInfo): Promise<void> {
  const dot = page.locator(".ub-status .ub-sync-dot");
  const geometry = () => page.locator(".ub-status").locator(".ub-sync-dot, .ub-last-updated, .ub-doc-rev").evaluateAll((nodes) =>
    nodes.map((node) => ({ rect: node.getBoundingClientRect().toJSON(), colour: getComputedStyle(node).backgroundColor })));
  const resting = await geometry();
  await dot.evaluate((node) => {
    node.classList.add("ub-sync-dot--pulse");
    for (const animation of node.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = 0;
    }
  });
  const row = await page.locator(".ub-status").boundingBox();
  if (row === null) throw new Error("Missing header row");
  const samples = [];
  for (const time of [0, 250, 500]) {
    const paint = await dot.evaluate((node, currentTime) => {
      const animations = node.getAnimations({ subtree: true });
      if (animations.length !== 1) throw new Error("Expected one ring animation");
      const animation = animations[0];
      if (animation === undefined) throw new Error("Missing ring animation");
      animation.currentTime = currentTime;
      const ring = getComputedStyle(node, "::after");
      return {
        inset: Number.parseFloat(ring.top), opacity: Number(ring.opacity), border: ring.borderTopWidth,
        duration: animation.effect?.getTiming().duration, iterations: animation.effect?.getTiming().iterations,
        endOpacity: animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes().at(-1)?.opacity : null,
        dotAnimation: getComputedStyle(node).animationName,
      };
    }, time);
    expect(paint.duration).toBe(650);
    expect(paint.iterations).toBe(1);
    expect(paint.endOpacity).toBe("0");
    expect(paint.dotAnimation).toBe("none");
    expect(paint.border).toBe("1px");
    expect(await geometry()).toEqual(resting);
    samples.push(paint);
    const path = info.outputPath(`sync-ring-${time}ms.png`);
    await page.screenshot({ path, clip: { x: Math.max(0, row.x - 8), y: row.y - 8, width: row.width + 16, height: row.height + 16 } });
    await info.attach(`sync ring ${time}ms`, { path, contentType: "image/png" });
  }
  expect(samples[0]?.inset).toBe(0);
  expect(samples[1]?.inset).toBeLessThan(samples[0]?.inset ?? 0);
  expect(samples[2]?.inset).toBeLessThan(samples[1]?.inset ?? 0);
  expect(samples[0]?.opacity).toBeGreaterThan(0);
  expect(samples[1]?.opacity).toBeLessThan(samples[0]?.opacity ?? 0);
  expect(samples[2]?.opacity).toBeLessThan(samples[1]?.opacity ?? 0);
  // A red state cancels even a ring that was already playing.
  for (const state of ["offline", "error"]) {
    await dot.evaluate((node, value) => { node.setAttribute("data-state", value); }, state);
    await expectNoRing(dot);
  }
  await dot.evaluate((node) => {
    node.classList.remove("ub-sync-dot--pulse");
    node.setAttribute("data-state", "resting");
  });
  await expectNoRing(dot);
}

async function expectDotContrast(dot: Locator): Promise<void> {
  const paint = await dot.evaluate((element) => {
    const style = getComputedStyle(element);
    const layers = [];
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
      const parent = getComputedStyle(node);
      layers.push({ colour: parent.backgroundColor, image: parent.backgroundImage, body: node === document.body });
    }
    return { colour: style.backgroundColor, opacity: Number(style.opacity), layers };
  });
  const fills: string[] = [];
  let grounds: string[] = [];
  for (const layer of paint.layers) {
    if (layer.image !== "none") {
      expect(layer.body, "the page owns its background image").toBe(true);
      grounds = pageGrounds(layer.image, layer.colour);
      break;
    }
    if (alphaOf(layer.colour) === 1) {
      grounds = [layer.colour];
      break;
    }
    if (alphaOf(layer.colour) > 0) fills.push(layer.colour);
  }
  expect(grounds.length).toBeGreaterThan(0);
  for (let ground of grounds) {
    for (const fill of fills.toReversed()) ground = composite(fill, ground);
    expect(contrast(composite(paint.colour, ground, paint.opacity), ground)).toBeGreaterThanOrEqual(3);
  }
}

for (const scheme of ["light", "dark"] as const) {
  test(`quiet header sync, revision and narrow-iPad controls — ${scheme} @webkit`, async ({
    browser, contextOptions, viewport, hasTouch, isMobile, deviceScaleFactor, userAgent,
  }, info) => {
    const input = {
      ...contextOptions, viewport, hasTouch, isMobile, colorScheme: scheme,
      ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
      ...(userAgent === undefined ? {} : { userAgent }),
    };
    const seed = await openApp(browser, "/", { contextOptions: input });
    const showList = seed.getByRole("button", { name: "Show document list", exact: true });
    if (await showList.isVisible()) await showList.click();
    const uuid = await createDoc(seed, `Quiet header ${scheme}`);
    await placeCaret(seed);
    await seed.keyboard.insertText("Existing content");
    await expect(seed.locator(".ub-status-sync")).toHaveAttribute("aria-label", /^Synced with hub /);
    const path = new URL(seed.url()).pathname;
    await seed.context().close();
    const beforeNavigate = async (page: Page): Promise<void> => {
      await page.addInitScript(() => {
        const state = window as unknown as { headerPulses: number; revisionCopies: string[] };
        state.headerPulses = 0;
        state.revisionCopies = [];
        document.addEventListener("animationstart", (event) => {
          if (event.target instanceof Element && event.target.matches(".ub-status .ub-sync-dot")
            && event.animationName === "ub-sync-ring" && event.pseudoElement === "::after") state.headerPulses += 1;
        });
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (text: string) => { state.revisionCopies.push(text); } },
        });
      });
    };
    const page = await openApp(browser, path, { contextOptions: input, beforeNavigate });
    const observer = await openApp(browser, path, { upstream: true, contextOptions: input, beforeNavigate });
    const trigger = page.locator(".ub-status-sync");
    const dot = page.locator(".ub-status .ub-sync-dot");
    await expect(trigger).toHaveAttribute("aria-label", /^Synced with hub /);
    await expect(observer.locator(".ub-status-sync")).toHaveAttribute("aria-label", /^Synced with hub /);
    expect(await pulseCount(page), "opening and initial sync stay quiet").toBe(0);
    expect(await pulseCount(observer), "opening and initial sync stay quiet").toBe(0);
    await expect(page.locator(".ub-status")).not.toContainText(/uuid |saved here|synced with hub|syncing/);
    await expect(page.locator(".ub-last-updated")).toContainText("Edited ");
    await expect(page.locator(".ub-sync-announcement")).toHaveText("");
    await expectDotContrast(dot);
    await page.screenshot({ path: info.outputPath("quiet-header.png") });
    await info.attach("quiet header", { path: info.outputPath("quiet-header.png"), contentType: "image/png" });

    await page.bringToFront();
    await placeCaret(page);
    await page.keyboard.insertText("Local ");
    await page.locator(".ub-title").focus();
    await expect.poll(() => pulseCount(page)).toBe(1);
    await expect.poll(() => pulseCount(observer)).toBe(1);
    await expect(page.locator(".ub-sync-announcement")).toHaveText("");
    await expectNoRing(dot);
    await expectNoRing(observer.locator(".ub-status .ub-sync-dot"));

    await page.emulateMedia({ reducedMotion: "reduce" });
    await placeCaret(page);
    await page.keyboard.insertText("Quiet ");
    await page.locator(".ub-title").focus();
    await expect(trigger).toHaveAttribute("aria-label", /^Synced with hub /);
    await expect.poll(() => pulseCount(observer)).toBe(2);
    expect(await pulseCount(page), "reduced motion removes the pulse").toBe(1);
    await expectNoRing(dot);

    for (const width of [810, 767, 744]) {
      await page.setViewportSize({ width, height: 1080 });
      await expect(page.locator(".ub-last-updated")).toBeVisible();
      if (width <= 767) await expect(page.locator(".ub-doc-rev")).toBeHidden();
      else await expect(page.locator(".ub-doc-rev")).toBeVisible();
      const row = await page.locator(".ub-status").boundingBox();
      const revision = width <= 767 ? null : await page.locator(".ub-doc-rev").boundingBox();
      const peers = await page.locator(".ub-peers").boundingBox();
      if (revision !== null && row !== null) {
        expect(revision.x + revision.width).toBeCloseTo(row.x + row.width, 0);
        if (peers !== null) expect(peers.x + peers.width).toBeLessThanOrEqual(revision.x);
      }
      if (hasTouch) {
        const target = await trigger.boundingBox();
        expect(target?.width).toBeGreaterThanOrEqual(44);
        expect(target?.height).toBeGreaterThanOrEqual(44);
        await trigger.tap();
      } else {
        await trigger.focus();
        await trigger.press("Space");
      }
      await expect(page.getByRole("dialog", { name: "Sync details", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const revision = page.locator(".ub-doc-rev");
    const short = await revision.locator(".ub-doc-id").innerText();
    await revision.focus();
    await revision.press("Enter");
    const copied = await page.evaluate(() => (window as unknown as { revisionCopies: string[] }).revisionCopies.at(-1));
    expect(copied).toMatch(/^[0-9a-f]{16}$/);
    expect(copied?.startsWith(short)).toBe(true);
    const copyLink = page.getByRole("button", { name: "Copy link", exact: true });
    if (hasTouch) await copyLink.tap();
    else { await copyLink.focus(); await copyLink.press("Space"); }
    await expect.poll(() => page.evaluate(() => (window as unknown as { revisionCopies: string[] }).revisionCopies.at(-1))).toBe(new URL(path, harness().appUrl).href);
    if (!hasTouch) await expect(copyLink).toBeFocused();
    const actions = page.getByRole("button", { name: "Document actions", exact: true });
    if (hasTouch) await actions.tap();
    else { await actions.focus(); await actions.press("Enter"); }
    const item = page.getByRole("menuitem", { name: "Copy document id", exact: true });
    if (hasTouch) await item.tap();
    else await item.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as unknown as { revisionCopies: string[] }).revisionCopies.at(-1))).toBe(uuid);
    await expect(actions).toBeFocused();

    const observerPulses = await pulseCount(observer);
    await harness().stopHub();
    try {
      await expect(trigger).toHaveAttribute("aria-label", /^Offline since \d{2}:\d{2}$/);
      await expect(page.locator(".ub-status")).toContainText("Offline. Changes are saved on this device.");
      await expect(dot).toHaveAttribute("data-state", "offline");
      await expect(page.locator(".ub-sync-announcement")).toHaveAttribute("aria-live", "polite");
      await expect(page.locator(".ub-sync-announcement")).toHaveText("Offline. Changes are saved on this device.");
      await expectDotContrast(dot);
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    } finally {
      await harness().startHub();
    }
    await expect(trigger).toHaveAttribute("aria-label", /^Synced with hub /, { timeout: 40_000 });
    await expect(page.locator(".ub-status-offline")).toHaveCount(0);
    await expect(page.locator(".ub-sync-announcement")).toHaveText("Synced with hub.");
    await expectDotContrast(dot);
    await expect(observer.locator(".ub-status-sync")).toHaveAttribute("aria-label", /^Synced with hub /, { timeout: 40_000 });
    expect(await pulseCount(observer), "reconnect handshakes stay quiet").toBe(observerPulses);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await inspectRing(page, info);
  });
}
