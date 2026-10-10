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
// OUT and INTERACT_KIND allow a side run (e.g. the interaction check on a
// prototype, which headless Chromium can load) without replacing results/.
const out = join(here, process.env.OUT ?? "results");
const INTERACT_KIND = process.env.INTERACT_KIND ?? "frame";
const PORT = 4599;
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 20000);
const hosts = new Set(PROVIDERS.flatMap((p) => p.frameSrc.map((s) => new URL(s).hostname)));

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const server = await serve(PORT);
const results = { csp: CSP, browsers: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const name of (process.env.BROWSERS ?? "chromium,webkit,firefox").split(",")) {
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
  page.on("response", async (res) => {
    const u = new URL(res.url());
    if (!hosts.has(u.hostname) || res.request().resourceType() !== "document") return;
    const entry = { url: res.url(), status: res.status(), frame: res.frame()?.parentFrame() ? "child" : "top" };
    r.responses.push(entry);
    // Tag documents loaded straight into a case iframe with that case, so the
    // summary can show the status of the page the frame finally showed.
    if (res.frame()?.parentFrame() === page.mainFrame())
      entry.case = await res.frame().frameElement().then((h) => h.evaluate((el) => el.closest(".case")?.id ?? null)).catch(() => null);
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
  // Checked on the lazy iframe's own frame, because an eager copy of the same
  // src elsewhere on the page makes request counting meaningless.
  const lazySrc = await page.$eval("#lazy-slot .case", (el) => el.dataset.src).catch(() => null);
  if (lazySrc) {
    const lazyFrameUrl = async () => (await (await page.$("#lazy-slot iframe"))?.contentFrame())?.url() ?? null;
    const lazyLoads = () => page.evaluate(() => window.__events.filter((e) => e.type === "iframe-load" && document.getElementById(e.case)?.closest("#lazy-slot")).length);
    // Bring the scroll container itself into the window first: lazy loading is
    // measured against the viewport, so an off-screen container proves nothing.
    await page.locator("#scroller").scrollIntoViewIfNeeded();
    await sleep(5000);
    const before = { frameUrl: await lazyFrameUrl(), loadEvents: await lazyLoads() };
    await page.$eval("#scroller", (el) => { el.scrollTop = el.scrollHeight; });
    await sleep(8000);
    const after = { frameUrl: await lazyFrameUrl(), loadEvents: await lazyLoads() };
    r.lazy = { src: lazySrc, beforeScroll: before, afterScroll: after };
    await page.locator("#lazy-slot .case").screenshot({ path: join(out, name, "lazy.png") }).catch(() => {});
  }

  // Screenshot every case.
  const ids = await page.$$eval("#cases .case", (els) => els.map((e) => e.id));
  for (const id of ids) {
    const loc = page.locator(`#${id}`);
    await loc.scrollIntoViewIfNeeded();
    await sleep(300);
    const info = await loc.evaluate((el) => ({ id: el.id, name: el.dataset.name, variant: el.dataset.variant, provider: el.dataset.provider, kind: el.dataset.kind, src: el.dataset.src, refused: el.dataset.refused === "true" }));
    // What the frame actually shows: Playwright can read cross-origin frames.
    const child = await (await loc.locator("iframe").elementHandle({ timeout: 1000 }).catch(() => null))?.contentFrame();
    if (child) {
      info.frameUrl = child.url();
      // A frame blocked by CSP never answers in WebKit, hence the timeout.
      info.frameText = await Promise.race([
        child.evaluate(() => `${document.title} | ${document.body?.innerText ?? ""}`.replace(/\s+/g, " ").trim().slice(0, 140)),
        sleep(3000).then(() => "(no answer within 3s)"),
      ]).catch((e) => `(unreadable: ${String(e.message).split("\n")[0].slice(0, 80)})`);
    }
    await loc.screenshot({ path: join(out, name, `${id}.png`) });
    r.cases.push({ ...info, screenshot: `${name}/${id}.png` });
  }

  // Interaction on the proposed Figma design frame (else the first embed).
  const target = await page.$$eval("#cases .case", (els, kind) => {
    const ok = els.filter((e) => e.dataset.src && e.dataset.provider !== "none");
    const frame = ok.find((e) => e.dataset.provider === "figma" && e.dataset.kind === kind && e.dataset.variant === "proposed" && !e.dataset.name.includes("broken"));
    return (frame ?? ok.find((e) => e.dataset.provider === "figma") ?? ok[0])?.id ?? null;
  }, INTERACT_KIND);
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
    const focusAfterClick = await page.evaluate(() => document.activeElement?.tagName ?? null);
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
      parentFocusAfterClick: focusAfterClick,
      targetShows: r.cases.find((c) => c.id === target)?.frameText ?? null,
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
  lines.push("| Case | Variant | Provider | Loads | Frame documents (status) | Frame shows | Screenshot |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const c of r.cases) {
    const loads = r.events.filter((e) => e.case === c.id && e.type === "iframe-load").length;
    const docs = c.src ? r.responses.filter((x) => x.case === c.id).map((x) => `${new URL(x.url).hostname}${new URL(x.url).pathname.split("/").slice(0, 2).join("/")} ${x.status}`).join(" → ") || "none seen" : "refused";
    const shows = (c.frameText ?? "").replace(/\|/g, "/");
    lines.push(`| ${c.name} | ${c.variant} | ${c.provider} | ${loads} | ${docs} | ${shows} | ${c.screenshot} |`);
  }
  lines.push("", `Interaction: \`${JSON.stringify(r.interaction)}\``, `Lazy: \`${JSON.stringify(r.lazy)}\``);
  lines.push(`CSP violations: ${r.events.filter((e) => e.type === "csp-violation").map((e) => e.detail).join("; ") || "none"}`);
  lines.push(`Failed requests: ${r.failed.map((f) => `${f.url} (${f.error})`).join("; ") || "none"}`);
  lines.push(`Console errors: ${r.console.length}`, "");
}
await writeFile(join(out, "summary.md"), lines.join("\n"));
console.log(`Wrote ${join(out, "summary.md")}`);
