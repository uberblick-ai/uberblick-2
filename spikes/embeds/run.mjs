// Drives the harness in Chromium, WebKit and Firefox with Playwright and writes
// screenshots, a JSON log and a summary to spikes/embeds/results/.
// `node spikes/embeds/run.mjs` from the repo root (after pnpm install).
import { createRequire } from "node:module";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { serve, CSP } from "./serve.mjs";
import { PROVIDERS } from "./providers.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(join(here, "../../packages/web/package.json"));
const pw = require("@playwright/test");
const out = join(here, "results");
const PORT = 4599;
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 20000);
const hosts = new Set(PROVIDERS.flatMap((p) => p.frameSrc.map((s) => new URL(s).hostname)));

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const server = await serve(PORT);
const results = { csp: CSP, browsers: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const name of ["chromium", "webkit", "firefox"]) {
  const r = (results.browsers[name] = { responses: [], failed: [], console: [], cases: [], interaction: {}, lazy: {} });
  let browser;
  try {
    browser = await pw[name].launch();
  } catch (e) {
    r.skipped = String(e.message).split("\n")[0];
    console.log(`${name}: skipped (${r.skipped})`);
    continue;
  }
  console.log(`${name}: running`);
  await mkdir(join(out, name), { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  const page = await context.newPage();
  page.on("response", (res) => {
    const u = new URL(res.url());
    if (hosts.has(u.hostname) && res.request().resourceType() === "document")
      r.responses.push({ url: res.url(), status: res.status(), frame: res.frame()?.parentFrame() ? "child" : "top" });
  });
  page.on("requestfailed", (req) => {
    const u = new URL(req.url());
    if (hosts.has(u.hostname) || u.hostname === "example.com") r.failed.push({ url: req.url(), error: req.failure()?.errorText });
  });
  page.on("console", (m) => { if (m.type() === "error") r.console.push(m.text().slice(0, 300)); });

  await page.goto(`http://127.0.0.1:${PORT}/harness.html`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await sleep(SETTLE_MS);

  // Lazy embed: was its document requested before the scroller moved?
  const lazySrc = await page.$eval("#lazy-slot .case", (el) => el.dataset.src).catch(() => null);
  if (lazySrc) {
    const before = r.responses.filter((x) => x.url.startsWith(lazySrc.split("?")[0])).length;
    const casesWithSameSrc = await page.$$eval("#cases .case", (els, s) => els.filter((e) => e.dataset.src === s).length, lazySrc);
    await page.$eval("#scroller", (el) => { el.scrollTop = el.scrollHeight; });
    await sleep(8000);
    const after = r.responses.filter((x) => x.url.startsWith(lazySrc.split("?")[0])).length;
    r.lazy = { src: lazySrc, eagerCopiesOnPage: casesWithSameSrc, requestsBeforeScroll: before, requestsAfterScroll: after };
    await page.locator("#lazy-slot .case").screenshot({ path: join(out, name, "lazy.png") }).catch(() => {});
  }

  // Screenshot every case.
  const ids = await page.$$eval("#cases .case", (els) => els.map((e) => e.id));
  for (const id of ids) {
    const loc = page.locator(`#${id}`);
    await loc.scrollIntoViewIfNeeded();
    await sleep(300);
    const info = await loc.evaluate((el) => ({ id: el.id, name: el.dataset.name, variant: el.dataset.variant, provider: el.dataset.provider, src: el.dataset.src, refused: el.dataset.refused === "true" }));
    await loc.screenshot({ path: join(out, name, `${id}.png`) });
    r.cases.push({ ...info, screenshot: `${name}/${id}.png` });
  }

  // Interaction on the first non-refused Figma case (else the first embed).
  const target = await page.$$eval("#cases .case", (els) => {
    const ok = els.filter((e) => e.dataset.src && e.dataset.provider !== "none");
    return (ok.find((e) => e.dataset.provider === "figma") ?? ok[0])?.id ?? null;
  });
  if (target) {
    const frame = page.locator(`#${target} .frame`);
    await frame.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -200));
    const box = await frame.boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const y0 = await page.evaluate(() => window.scrollY);
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, 400);
    await sleep(600);
    const y1 = await page.evaluate(() => window.scrollY);
    await page.evaluate((y) => window.scrollTo(0, y), y0);
    await sleep(300);
    const box2 = await frame.boundingBox();
    await page.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await sleep(800);
    const activeAfterClick = await frame.evaluate((el) => el.classList.contains("active"));
    const ya = await page.evaluate(() => window.scrollY);
    await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await page.mouse.wheel(0, 400);
    await sleep(800);
    const yb = await page.evaluate(() => window.scrollY);
    await frame.screenshot({ path: join(out, name, "interaction-active.png") });
    const keysBefore = await page.evaluate(() => window.__events.filter((e) => e.type === "parent-keydown").length);
    await page.keyboard.press("Escape");
    await sleep(300);
    const keysAfter = await page.evaluate(() => window.__events.filter((e) => e.type === "parent-keydown").length);
    await page.mouse.click(10, 10);
    await sleep(300);
    const activeAfterOutside = await frame.evaluate((el) => el.classList.contains("active"));
    r.interaction = {
      case: target,
      inertWheelScrolledPage: y1 !== y0,
      activatedByClick: activeAfterClick,
      activeWheelScrolledPage: yb !== ya,
      escapeReachedParent: keysAfter > keysBefore,
      releasedByOutsideClick: !activeAfterOutside,
    };
  }

  r.events = await page.evaluate(() => window.__events);
  await page.screenshot({ path: join(out, name, "full.png"), fullPage: true });

  // Dark colour scheme, first Figma case only, to see the canvas follow.
  await page.emulateMedia({ colorScheme: "dark" });
  await sleep(500);
  if (target) await page.locator(`#${target}`).screenshot({ path: join(out, name, "page-dark.png") });

  await browser.close();
}

server.close();
await writeFile(join(out, "results.json"), JSON.stringify(results, null, 2));

// A short human summary.
const lines = ["# Embeds spike results", "", `CSP: \`${CSP}\``, ""];
for (const [name, r] of Object.entries(results.browsers)) {
  lines.push(`## ${name}`, "");
  if (r.skipped) { lines.push(`Skipped: ${r.skipped}`, ""); continue; }
  lines.push("| Case | Variant | Provider | Loads | Document status | Screenshot |", "| --- | --- | --- | --- | --- | --- |");
  for (const c of r.cases) {
    const loads = r.events.filter((e) => e.case === c.id && e.type === "iframe-load").length;
    const status = c.src ? r.responses.filter((x) => x.url === c.src).map((x) => x.status).join(",") || "none seen" : "refused";
    lines.push(`| ${c.name} | ${c.variant} | ${c.provider} | ${loads} | ${status} | ${c.screenshot} |`);
  }
  lines.push("", `Interaction: \`${JSON.stringify(r.interaction)}\``, `Lazy: \`${JSON.stringify(r.lazy)}\``);
  lines.push(`CSP violations: ${r.events.filter((e) => e.type === "csp-violation").map((e) => e.detail).join("; ") || "none"}`);
  lines.push(`Failed requests: ${r.failed.map((f) => `${f.url} (${f.error})`).join("; ") || "none"}`);
  lines.push(`Console errors: ${r.console.length}`, "");
}
await writeFile(join(out, "summary.md"), lines.join("\n"));
console.log(`Wrote ${join(out, "summary.md")}`);
