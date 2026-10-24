/** Real SVG paint, font metrics and editor captures for Ablauf's host integration. */
import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import { waitForDocumentDraw } from "./settle.js";
import { alphaOf, composite, contrast } from "../test/colour.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl, authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-ablauf-paint-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

const FLOW = `flow v0
columns main
section "One"
pill event "An event"
box agent tone=agent "Agent"
box system tone=system "System"
box neutral tone=neutral "Neutral"
section "Two"
box done tone=done "Done"
box rework tone=rework "Rework"
box stop tone=stop "Stop"
decision choice tone=agent "Ready?"
end complete "Complete"
event --> agent
agent --> system label=inline : next
system --> neutral
neutral --> done
done --> rework
rework --> stop
stop --> choice
choice --> complete label=inline : yes
legend
  pill "event"
  edge tone=stop "stop path"`;
const FANOUT = `fan-out v0
step "Check approval"
outcome "Approved" reason="The maintainer started it" destination="Start the run" tone="done"
outcome "Needs work" reason="The input changed" destination="Prepare again" tone="rework"
outcome "Outside input" reason="No approval" destination="Ask a maintainer" tone="stop"`;
const CROSSING = `flow v0
columns left center right
pill top col=center
pill left col=left
pill right col=right row=left
pill bottom col=center
top --> bottom
left --> right`;

interface Paint { fill: string; opacity: number }
interface Reading { text: string; ink: Paint; grounds: Paint[]; font: string; mono: boolean; fits: boolean }

/** Sample every character over SVG geometry in drawing order, including translucent shape fills. */
async function textPaint(svg: Locator): Promise<{ surface: string; readings: Reading[] }> {
  return svg.evaluate((element) => {
    if (!(element instanceof SVGSVGElement)) throw new Error("e2e: missing Ablauf SVG");
    const geometry = [...element.querySelectorAll<SVGGeometryElement>("rect, path, circle, ellipse, polygon")]
      .filter(shape => shape.closest("defs") === null);
    const opacity = (node: Element): number => {
      let result = 1;
      for (let current: Element | null = node; current !== null; current = current.parentElement) {
        result *= Number(getComputedStyle(current).opacity);
      }
      return result;
    };
    // No opacity groups currently occur in renderer output. Fail explicitly if
    // that changes: flattening a translucent group needs a different paint model.
    for (const group of element.querySelectorAll("g")) {
      if (Number(getComputedStyle(group).opacity) !== 1) throw new Error("e2e: SVG opacity group needs composited sampling");
    }
    const readings = [...element.querySelectorAll("text")].flatMap(text => {
      const style = getComputedStyle(text);
      const matrix = text.getCTM();
      if (matrix === null) throw new Error("e2e: text has no SVG transform");
      const bounds = text.getBBox();
      const samples = Array.from({ length: text.getNumberOfChars() }, (_, index) => {
        const box = text.getExtentOfChar(index);
        return new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(matrix);
      });
      return samples.map(point => {
        const beneath = geometry.filter(shape => {
          if (!(shape.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
          const transform = shape.getCTM();
          const paint = getComputedStyle(shape);
          return transform !== null && paint.fill !== "none" && paint.visibility === "visible"
            && shape.isPointInFill(point.matrixTransform(transform.inverse()));
        });
        const shape = [...beneath].reverse().find(node => node.matches("rect:not(.band, .gap)"));
        const box = shape?.getBBox();
        const fits = box === undefined || (bounds.x >= box.x - 0.5 && bounds.y >= box.y - 0.5
          && bounds.x + bounds.width <= box.x + box.width + 0.5
          && bounds.y + bounds.height <= box.y + box.height + 0.5);
        return {
          text: text.textContent ?? "", font: style.fontFamily,
          mono: text.matches(".m, .cap"), fits,
          ink: { fill: style.fill, opacity: opacity(text) * Number(style.fillOpacity) },
          grounds: beneath.map(shape => {
            const paint = getComputedStyle(shape);
            return { fill: paint.fill, opacity: opacity(shape) * Number(paint.fillOpacity) };
          }),
        };
      });
    });
    return { surface: getComputedStyle(element).backgroundColor, readings };
  });
}

async function token(svg: Locator, name: string): Promise<string> {
  return svg.evaluate((element, property) => {
    const probe = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    probe.style.fill = `var(${property})`;
    element.append(probe);
    const fill = getComputedStyle(probe).fill;
    probe.remove();
    return fill;
  }, name);
}

async function paintIs(svg: Locator, selector: string, property: "fill" | "stroke", name: string): Promise<void> {
  const elements = svg.locator(selector);
  expect(await elements.count(), selector).toBeGreaterThan(0);
  const expected = await token(svg, name);
  for (const actual of await elements.evaluateAll((items, key) => items.map(item => getComputedStyle(item)[key]), property)) {
    expect(actual, `${selector} ${property}`).toBe(expected);
  }
}

for (const appearance of ["light", "dark"] as const) {
  test(`Ablauf uses host paint and loaded mono fonts with the ${appearance} appearance pinned opposite the system`,
    { tag: "@webkit" }, async ({ browser }, info) => {
    if (agent === null) throw new Error("e2e: missing Ablauf appearance writer");
    const session = agent.open({ name: "ablauf-appearance-e2e" });
    const { uuid } = await session.call<{ uuid: string }>("create_doc", {
      title: "Ablauf host paint", description: "Flow and fan-out drawn independently with the host palette.",
      blocks: [FLOW, FANOUT, FLOW.replace("Ready?", "Independent?"), CROSSING]
        .map(text => ({ type: "code", language: "ablauf", text })),
    });
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      contextOptions: { colorScheme: appearance === "light" ? "dark" : "light", viewport: { width: 1100, height: 1000 } },
      beforeNavigate: async page => {
        await page.addInitScript(theme => { localStorage.setItem("uberblick.settings.v1", JSON.stringify({ appearance: theme })); }, appearance);
      },
    });
    await waitForDocumentDraw(page, session, uuid, { index: "all" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", appearance);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('13px "Geist Mono"'))).toBe(true);
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(appearance === "light");
    const diagrams = page.locator(".ub-ablauf-drawing svg");
    await expect(diagrams).toHaveCount(4);
    for (const block of await page.locator(".ub-ablauf").all()) {
      await expect(block).not.toHaveClass(/ub-block-frame/);
      const frame = await block.evaluate(element => {
        const style = getComputedStyle(element);
        return { border: style.borderLeftWidth, ground: style.backgroundColor };
      });
      expect(frame.border).toBe("0px");
      expect(alphaOf(frame.ground)).toBe(0);
      await expect(block.locator(":scope > .ub-block-caption, .ub-copy")).toHaveCount(0);
    }
    const flow = diagrams.nth(0);
    await paintIs(flow, "text:not(.muted, .cap, [class*='t-'])", "fill", "--ab-ink");
    await paintIs(flow, ".muted, .cap", "fill", "--ab-muted");
    await paintIs(flow, ".rule, .pill", "stroke", "--ab-line");
    await paintIs(flow, ".band", "fill", "--ab-band");
    await paintIs(flow, ".pill", "fill", "--ab-surface");
    await paintIs(flow, ".gap:not(.gap-band)", "fill", "--ab-bg");
    await paintIs(flow, ".gap-band", "fill", "--ab-band");
    await paintIs(diagrams.nth(3), ".knockout", "stroke", "--ab-bg");
    for (const tone of ["neutral", "agent", "system", "done", "rework", "stop"]) {
      await paintIs(flow, `.k-${tone}:not(.decision-box)`, "fill", `--ab-${tone}-bg`);
      await paintIs(flow, `.t-${tone}`, "fill", `--ab-${tone}`);
    }
    const markerIds: string[] = [];
    const contrasts: { text: string; ratio: number; ground: string; ink: string }[] = [];
    for (const svg of await diagrams.all()) {
      await expect(svg).toHaveClass(/ab-auto/);
      const snapshot = await textPaint(svg);
      expect(alphaOf(snapshot.surface)).toBe(1);
      expect(snapshot.surface).toBe(await token(svg, "--ab-bg"));
      expect(snapshot.readings.length).toBeGreaterThan(0);
      for (const reading of snapshot.readings) {
        let ground = snapshot.surface;
        for (const paint of reading.grounds) ground = composite(paint.fill, ground, paint.opacity);
        const ratio = contrast(composite(reading.ink.fill, ground, reading.ink.opacity), ground);
        contrasts.push({ text: reading.text, ratio, ground, ink: reading.ink.fill });
        expect(ratio, JSON.stringify({ ...reading, ratio, ground })).toBeGreaterThanOrEqual(4.5);
        if (reading.mono) expect(reading.font, reading.text).toMatch(/^"?Geist Mono"?(?:,|$)/);
        expect(reading.fits, reading.text).toBe(true);
      }
      markerIds.push(...await svg.locator("marker").evaluateAll(markers => markers.map(marker => marker.id)));
      const refs = await svg.locator("[marker-end]").evaluateAll(edges => edges.map(edge => {
        const id = /#([^)]*)/.exec(edge.getAttribute("marker-end") ?? "")?.[1];
        const root = edge.getRootNode();
        return id !== undefined && root instanceof ShadowRoot && root.querySelector(`marker[id='${id}']`) !== null;
      }));
      expect(refs.every(Boolean)).toBe(true);
    }
    expect(new Set(markerIds).size).toBe(markerIds.length);
    const aaPath = info.outputPath(`ablauf-AA-${appearance}.json`);
    writeFileSync(aaPath, JSON.stringify({ appearance,
      minimum: contrasts.reduce((lowest, next) => next.ratio < lowest.ratio ? next : lowest),
      textSamples: contrasts.length }, null, 2));
    await info.attach(`ablauf-AA-${appearance}`, { path: aaPath, contentType: "application/json" });
    const firstFonts = await diagrams.nth(0).locator("text.m").evaluateAll(texts => texts.map(text => getComputedStyle(text).fontFamily));
    expect(await diagrams.nth(2).locator("text.m").evaluateAll(texts => texts.map(text => getComputedStyle(text).fontFamily))).toEqual(firstFonts);
    await page.addStyleTag({ content: ".ub-ablauf { max-width: 360px !important; }" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const viewport of await page.locator(".ub-ablauf-viewport").all()) {
      const fitted = await viewport.evaluate(element => {
        const svg = element.querySelector(".ub-ablauf-drawing")?.shadowRoot?.querySelector("svg");
        if (svg === null || svg === undefined) throw new Error("e2e: fitted Ablauf SVG is missing");
        return { scroll: element.scrollWidth, width: element.clientWidth,
          drawn: svg.getBoundingClientRect().width, natural: Number(svg.getAttribute("width")) };
      });
      expect(fitted.scroll).toBeLessThanOrEqual(fitted.width + 1);
      expect(fitted.drawn).toBeLessThanOrEqual(fitted.width + 0.5);
      expect(fitted.drawn).toBeCloseTo(Math.min(fitted.width, fitted.natural), 0);
      await viewport.evaluate(element => { element.scrollLeft = element.scrollWidth; });
      expect(await viewport.evaluate(element => element.scrollLeft)).toBe(0);
    }
    const capture = info.outputPath(`ablauf-palette-${appearance}.png`);
    await page.locator(".ub-ablauf").first().screenshot({ path: capture });
    await info.attach(`ablauf-palette-${appearance}`, { path: capture, contentType: "image/png" });
  });
}
