/** The product scale through real page composition, font loading and device input. */
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { activateControl, editor, setupHarness } from "./app-helpers.js";
import { renderedText } from "./contrast-helpers.js";
import { McpAgent } from "./mcp-agent.js";

const SIZES = [12, 13, 14, 16, 18, 22, 36];
const DRAWN_TEXT = ".ub-wireframe-drawing";

async function expectStep(element: Locator, size: number, leading: number): Promise<void> {
  await expect(element).toHaveCSS("font-size", `${size}px`);
  await expect(element).toHaveCSS("line-height", `${leading}px`);
}

/** Inspect text owners, rather than counting inherited sizes on empty layout boxes. */
async function expectScale(page: Page, surface: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const readings = await page.evaluate((excluded) => {
    const result: Array<{ where: string; size: number }> = [];
    for (const element of document.body.querySelectorAll("*")) {
      // Inline code sits a fixed ratio below the step around it; the code check below owns it.
      if (element.closest(`${excluded}, script, style, .ub-avatar-agent-badge, .ub-inline-code`) !== null) continue;
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0 || style.visibility !== "visible") continue;
      const ancestors: Element[] = [];
      for (let node: Element | null = element; node !== null; node = node.parentElement) ancestors.push(node);
      if (ancestors.some((node) => {
        const parentStyle = getComputedStyle(node);
        return parentStyle.display === "none" || parentStyle.visibility !== "visible" || Number(parentStyle.opacity) === 0;
      })) continue;
      const name = `${element.tagName.toLowerCase()}.${element.getAttribute("class") ?? ""}`;
      const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
      const text = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");
      // The zero-sized ordinary link source preserves native caret movement behind its pill.
      if ((text || field) && !element.matches(".ub-github-link-text")) {
        result.push({ where: name, size: Number.parseFloat(style.fontSize) });
      }
      for (const pseudo of ["::before", "::after"]) {
        if (pseudo === "::after" && element.matches('[data-variant="selection"]')) continue;
        const generated = getComputedStyle(element, pseudo);
        if (["none", "normal", '""', "''"].includes(generated.content) || generated.display === "none") continue;
        result.push({ where: `${name}${pseudo}`, size: Number.parseFloat(generated.fontSize) });
      }
    }
    return result;
  }, DRAWN_TEXT);
  expect(readings.length, surface).toBeGreaterThan(0);
  expect.soft(readings.filter(({ size }) => !SIZES.includes(size)), `${surface}: off-scale text`).toEqual([]);
  const coarse = await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches);
  if (coarse) {
    const fields = await page.locator("input:visible, textarea:visible").evaluateAll((elements) => elements.map((element) => ({
      label: element.getAttribute("aria-label") ?? element.id ?? element.className,
      size: Number.parseFloat(getComputedStyle(element).fontSize),
      height: element.getBoundingClientRect().height,
    })));
    expect.soft(fields.filter(({ size, height }) => size < 16 || height < 44), `${surface}: iPad fields`).toEqual([]);
  }
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${surface}: page overflow`).toBe(true);
}

async function expectHeading(element: Locator, size: number, leading: number, above: number, below: number): Promise<void> {
  await expectStep(element, size, leading);
  await expect(element).toHaveCSS("font-weight", "600");
  const metrics = await element.evaluate((node) => {
    const style = getComputedStyle(node);
    return { face: style.fontFamily, top: Number.parseFloat(style.marginTop), bottom: Number.parseFloat(style.marginBottom) };
  });
  expect(metrics.face).toContain("Geist");
  expect(metrics.face).not.toMatch(/Fraunces|Mono/);
  expect(metrics.top / size).toBeCloseTo(above, 1);
  expect(metrics.bottom / size).toBeCloseTo(below, 1);
}

test.describe("document and workspace typography", () => {
  const { harness, openApp } = setupHarness({ app: { upstream: true } });
  let agent: McpAgent | null = null;
  let documentUuid = "";
  let decisionUuid = "";

  test.beforeAll(async () => {
    agent = new McpAgent({
      workspace: harness().workspace, hubUrl: harness().hubUrl, authSecret: harness().authSecret,
      statePrefix: `uberblick-e2e-type-${process.env.UB_AGENTS_RUN ?? "local"}-`,
    });
    const writer = agent.open({ name: "typography-e2e" });
    const document = await writer.call<{ uuid: string; blocks: Array<{ id: string }> }>("create_doc", {
      title: "A readable document outline", description: "Typography browser acceptance fixture.",
      tldr: "A sentence at the body step.",
      blocks: [
        { type: "paragraph", inline: [{ text: "Prose with ", marks: {} }, { text: "inline code", marks: { inlineCode: true } }, { text: " sits inside its line.", marks: {} }] },
        ...[1, 2, 3, 4, 5, 6].map((level) => ({ type: "heading", level, inline: [{ text: `Level ${level} with `, marks: {} }, { text: "code", marks: { inlineCode: true } }] })),
        { type: "list-item", text: "A body-sized list item." },
        { type: "table", text: "| UI heading | Other heading |\n| --- | --- |\n| Body cell | A value |" },
        { type: "code", language: "typescript", text: "const scale = [12, 13, 14, 16, 18, 22, 36];" },
      ],
    });
    documentUuid = document.uuid;
    const first = document.blocks[0];
    if (first === undefined) throw new Error("e2e: missing prose fixture");
    await writer.call("annotate", { uuid: documentUuid, block_id: first.id, start: 0, end: 5, text: "A UI-sized conversation." });
    const decision = await writer.call<{ uuid: string }>("create_doc", {
      title: "Which scale should readers see?", kind: "decision", status: "decided", related: documentUuid,
      description: "Decision typography browser acceptance fixture.",
      blocks: [{ type: "paragraph", text: "Use one scale for the document and its interface." }],
    });
    decisionUuid = decision.uuid;
    await agent.closeSessions();
  });
  test.afterAll(async () => { await agent?.close(); agent = null; });

  test("one scale on reading and workspace surfaces", { tag: "@webkit" }, async ({ browser }, info) => {
    const touch = info.project.use.hasTouch === true;
    const page = await openApp(browser, `/${harness().workspace}/${documentUuid}`, {
      contextOptions: { ...(touch ? devices["iPad (gen 7)"] : { viewport: { width: 1280, height: 800 } }), reducedMotion: "reduce" },
      readySelector: ".ub-editor .ProseMirror",
    });
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error("e2e: typography proof requires a viewport");
    await expect(editor(page).locator("h6")).toBeVisible();
    await expectStep(page.locator(".ub-title"), 36, 42);
    await expect(page.locator(".ub-title")).toHaveCSS("font-weight", "500");
    await expect(page.locator(".ub-title")).toHaveCSS("font-family", /Fraunces/);
    for (const level of [1, 2, 3, 4, 5, 6]) {
      const heading = editor(page).locator(`h${level}`);
      if (level === 1) {
        await expectStep(heading, 36, 42);
        await expect(heading).toHaveCSS("font-weight", "600");
        const style = await heading.evaluate((node) => ({ font: getComputedStyle(node).fontFamily,
          top: Number.parseFloat(getComputedStyle(node).marginTop), bottom: Number.parseFloat(getComputedStyle(node).marginBottom) }));
        expect(style.font).toContain("Geist");
        expect(style.font).not.toContain("Fraunces");
        expect(style.top).toBeGreaterThan(style.bottom);
      } else await expectHeading(heading, level === 2 ? 22 : 18, level === 2 ? 28 : 24, level === 2 ? 1.9 : 1.5, level === 2 ? 0.45 : 0.35);
    }
    await expectStep(editor(page).locator(":scope > p").first(), 16, 27);
    await expectStep(editor(page).locator("li").first(), 16, 27);
    await expectStep(editor(page).locator("th").first(), 14, 20);
    await expectStep(editor(page).locator("td").first(), 16, 27);
    await expectStep(page.locator(".ub-tldr-body > p"), 16, 27);
    await expectStep(page.locator(".ub-status"), 13, 18);
    await expectStep(page.locator(".ub-block-caption .ub-block-label").first(), 12, 16);
    await expect(editor(page).locator("p code, .ub-heading code")).toHaveCount(7);
    for (const code of await editor(page).locator("p code, .ub-heading code").all()) {
      const fit = await code.evaluate((node) => {
        const own = getComputedStyle(node);
        const around = getComputedStyle(node.parentElement as Element);
        return {
          ratio: Number.parseFloat(own.fontSize) / Number.parseFloat(around.fontSize),
          height: node.getBoundingClientRect().height,
          leading: Number.parseFloat(around.lineHeight),
        };
      });
      expect(fit.ratio).toBeCloseTo(0.85, 2);
      expect(fit.height).toBeLessThanOrEqual(fit.leading);
    }
    const measure = await page.locator(".ub-document-pane > .ub-column").evaluate((column) => {
      const style = getComputedStyle(column);
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;visibility:hidden;width:72ch;font:inherit";
      column.append(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return { token: style.getPropertyValue("--measure").trim(), size: style.fontSize, cap: Number.parseFloat(style.maxWidth), width,
        columnLeft: column.getBoundingClientRect().left, proseLeft: column.querySelector(".ub-paragraph")?.getBoundingClientRect().left,
        gutter: Number.parseFloat(style.paddingLeft) };
    });
    expect(measure.token).toBe("72ch");
    expect(measure.size).toBe("16px");
    expect(measure.cap).toBeCloseTo(measure.width, 1);
    expect(measure.proseLeft).toBeCloseTo(measure.columnLeft + measure.gutter, 1);
    const documentTitle = await page.locator(".ub-title").evaluate((title) => ({
      left: title.getBoundingClientRect().left,
      gap: (title.nextElementSibling?.getBoundingClientRect().top ?? 0) - title.getBoundingClientRect().bottom,
      tracking: getComputedStyle(title).letterSpacing,
    }));
    await expectScale(page, `document ${viewport.width}px`);
    const documentImage = info.outputPath(`document-${viewport.width}.png`);
    await page.screenshot({ path: documentImage });
    await info.attach(`document-${viewport.width}`, { path: documentImage, contentType: "image/png" });

    if (viewport.width < 1280) await activateControl(page.locator(".ub-threads-toggle"));
    await expect(page.locator(".ub-thread-text").filter({ hasText: "A UI-sized conversation." })).toBeVisible();
    await expectStep(page.locator(".ub-thread-text").filter({ hasText: "A UI-sized conversation." }), 14, 20);
    await expectScale(page, `comments ${viewport.width}px`);
    if (viewport.width < 1280) {
      await activateControl(page.getByRole("button", { name: "Close comments", exact: true }));
      await expect(page.getByRole("dialog", { name: "Comments", exact: true })).toHaveCount(0);
    }

    for (const [surface, suffix, ready] of [
      ["decision", decisionUuid, ".ub-editor .ProseMirror"],
      ["All documents", "all", ".ub-docs"],
      ["General settings", "settings", "[data-settings-page]"],
      ["Tags settings", "settings/tags", "[data-settings-page]"],
    ] as const) {
      await page.goto(new URL(`/${harness().workspace}/${suffix}`, page.url()).href);
      await expect(page.locator(ready ?? "body")).toBeVisible();
      if (surface === "decision") {
        const title = page.locator(".ub-title");
        await expectStep(title, 36, 42);
        await expect(title).toHaveCSS("font-family", /Fraunces/);
        await expect(title).toHaveCSS("font-weight", "500");
        await expect(title).toHaveCSS("letter-spacing", documentTitle.tracking);
        const metrics = await title.evaluate((node) => ({ left: node.getBoundingClientRect().left,
          gap: (node.nextElementSibling?.getBoundingClientRect().top ?? 0) - node.getBoundingClientRect().bottom }));
        expect(Math.abs(metrics.left - documentTitle.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(metrics.gap - documentTitle.gap)).toBeLessThanOrEqual(1);
      }
      if (surface === "All documents") {
        await expect(page.locator(".ub-docs-open").filter({ hasText: "A readable document outline" })).toBeVisible();
        await expectStep(page.getByRole("columnheader").first(), 14, 20);
        await expectStep(page.locator(".ub-docs-age").first(), 13, 18);
      }
      if (surface === "General settings") await expectStep(page.locator("#ub-workspace-name-help"), 13, 18);
      for (const heading of await page.locator("[data-settings-page] h2").all()) {
        await expectStep(heading, 22, 28);
        await expect(heading).toHaveCSS("font-weight", "600");
      }
      await expectScale(page, `${surface} ${viewport.width}px`);
    }
    if (viewport.width < 1280) await activateControl(page.getByRole("button", { name: "Show sidebar", exact: true }));
    await expectStep(page.locator(".ub-settings-nav .ub-nav-label").first(), 12, 16);
    await expectStep(page.getByRole("button", { name: "General", exact: true }), 14, 20);
    await expectScale(page, `settings navigation ${viewport.width}px`);
    const caption = page.locator(".ub-settings-nav .ub-nav-label:visible").first();
    await caption.evaluate((element) => element.setAttribute("data-typography-contrast", ""));
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const captionInk = await renderedText(page, "[data-typography-contrast]");
      expect(captionInk.length, colorScheme).toBeGreaterThan(0);
      expect(captionInk.every(({ ratio }) => ratio >= 4.5), `${colorScheme}: ${JSON.stringify(captionInk)}`).toBe(true);
    }
    await caption.evaluate((element) => element.removeAttribute("data-typography-contrast"));
    const settingsImage = info.outputPath(`settings-${viewport.width}.png`);
    await page.screenshot({ path: settingsImage });
    await info.attach(`settings-${viewport.width}`, { path: settingsImage, contentType: "image/png" });
    if (viewport.width < 1280) {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Sidebar", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Show sidebar", exact: true })).toBeFocused();
    }
  });
});

test.describe("authenticated Settings typography", () => {
  const { harness, openApp } = setupHarness({ accessRole: "admin", hubAdmin: true });
  test("one scale on access and hub Settings", { tag: "@webkit" }, async ({ browser }, info) => {
    const touch = info.project.use.hasTouch === true;
    const page = await openApp(browser, `/${harness().workspace}/settings/members`, {
      contextOptions: { ...(touch ? devices["iPad (gen 7)"] : { viewport: { width: 1280, height: 800 } }), reducedMotion: "reduce" },
      readySelector: "[data-settings-page]",
    });
    for (const [suffix, table] of [["members", "Members"], ["devices", "Devices"], ["hub-admins", "Hub admins"], ["hub-workspaces", "Hub workspaces"]] as const) {
      await page.goto(new URL(`/${harness().workspace}/settings/${suffix}`, harness().appUrl).href);
      await expect(page.getByRole("table", { name: table, exact: true })).toBeVisible();
      for (const heading of await page.locator("[data-settings-page] h2").all()) {
        await expectStep(heading, 22, 28);
        await expect(heading).toHaveCSS("font-weight", "600");
      }
      await expectStep(page.getByRole("columnheader").first(), 14, 20);
      await expectStep(page.getByRole("cell").first(), 16, 27);
      await expectScale(page, `${suffix} Settings`);
    }
  });
});
