/** The host supplies the complete palette and mono face inside each shadow root. */
import { expect, test } from "@playwright/test";
import { checkPalette, TOKENS } from "@uberblick/ablauf";
import type { Palette } from "@uberblick/ablauf";
import { alphaOf, srgb } from "../test/colour.js";
import { setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import { waitForDocumentDraw } from "./settle.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
test.beforeAll(() => { agent = new McpAgent({ ...harness(), statePrefix: "uberblick-e2e-ablauf-paint-" }); });
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

const sources = [
  'flow v0\ncolumns main\nbox start "Start"\nend done "Done"\nstart --> done',
  'fan-out v0\nstep "Check"\noutcome "Approved" reason="Ready" destination="Start" tone="done"',
  'sequence v0\nparticipant A "Agent" tone=agent\nparticipant H "Hub" tone=system\nsection "Claim"\nA --> H: Claim workspace\nH -.-> A: Challenge\nnote over A, H: Challenge expires soon\nalt Verified\nH -.-> A: Granted\nelse Expired\nH -.-> A: Retry\nend',
];
const colour = (value: string): string => `color(srgb ${srgb(value).join(" ")} / ${alphaOf(value)})`;
for (const appearance of ["light", "dark"] as const) {
  test(`Ablauf inherits its ${appearance} host palette and mono font opposite the system`, { tag: "@webkit" }, async ({ browser }) => {
    if (agent === null) throw new Error("e2e: missing Ablauf appearance writer");
    const session = agent.open({ name: "ablauf-appearance-e2e" });
    const { uuid } = await session.call<{ uuid: string }>("create_doc", {
      title: "Ablauf host paint", description: "Host palette and fonts for flow, fan-out and sequence drawings.",
      blocks: sources.map(text => ({ type: "code", language: "ablauf", text })),
    });
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      contextOptions: { colorScheme: appearance === "light" ? "dark" : "light" },
      beforeNavigate: async page => { await page.addInitScript(theme => localStorage.setItem("uberblick.settings.v1", JSON.stringify({ appearance: theme })), appearance); },
    });
    await waitForDocumentDraw(page, session, uuid, { index: "all" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", appearance);
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(appearance === "light");
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('13px "Geist Mono"'))).toBe(true);
    await expect(page.locator(".ub-ablauf-drawing svg")).toHaveCount(3);
    for (const svg of await page.locator(".ub-ablauf-drawing svg").all()) {
      const values = await svg.evaluate((element, properties) => properties.map(property => {
        const probe = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        probe.style.fill = `var(${property})`;
        element.append(probe);
        const value = getComputedStyle(probe).fill;
        probe.remove();
        return value;
      }), [...TOKENS.map(token => `--ab-${token}`), "--revision-removed-row", "--revision-added-row"]);
      const palette = Object.fromEntries(TOKENS.map((token, index) => [token, colour(values[index] ?? "")])) as Palette;
      for (const bg of [palette.bg, ...values.slice(TOKENS.length).map(colour)]) {
        expect(alphaOf(bg)).toBe(1);
        const result = checkPalette({ ...palette, bg });
        await test.info().attach("palette", { body: JSON.stringify({ appearance, bg, minimum: result.minimum }), contentType: "application/json" });
        expect(result.minimum, JSON.stringify(result.pairs.filter(pair => pair.ratio < 4.5))).toBeGreaterThanOrEqual(4.5);
      }
      const fonts = await svg.locator("text.m, text.cap").evaluateAll(texts => texts.map(text => getComputedStyle(text).fontFamily));
      expect(fonts.length).toBeGreaterThan(0);
      for (const font of fonts) expect(font).toMatch(/^"?Geist Mono"?(?:,|$)/);
    }
  });
}
