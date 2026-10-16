import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { build } from "vite";
import type { PageTimerControls } from "./fixtures/page-timers.js";

let timerScript: Promise<string> | undefined;

async function buildTimerScript(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "error",
    plugins: [{
      name: "browser-timer-node-util",
      enforce: "pre",
      // fake-timers only reads util when the target has Node's process object.
      resolveId(id) { if (id === "util") return "\0browser-timer-node-util"; },
      load(id) { if (id === "\0browser-timer-node-util") return "export default {};"; },
    }],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("./fixtures/page-timers.ts", import.meta.url)),
        formats: ["iife"],
        name: "ubPageTimers",
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap((output) => "output" in output ? output.output : [])
    .filter((output) => output.type === "chunk");
  if (chunks.length !== 1 || chunks[0] === undefined) throw new Error("e2e: expected one page timer script");
  return chunks[0].code;
}

/** Install before navigation; every reload gets a fresh, naturally running clock. */
export async function installPageTimers(page: Page): Promise<void> {
  timerScript ??= buildTimerScript();
  await page.addInitScript({ content: await timerScript });
}

export async function setPageTime(page: Page, time: number): Promise<void> {
  await page.evaluate((time) => {
    (window as unknown as { ubPageTimers: PageTimerControls }).ubPageTimers.setTime(time);
  }, time);
}

export async function advancePageTimers(page: Page, milliseconds: number): Promise<void> {
  await page.evaluate(async (milliseconds) => {
    await (window as unknown as { ubPageTimers: PageTimerControls }).ubPageTimers.advance(milliseconds);
  }, milliseconds);
}

export async function fastForwardPageTimers(page: Page, milliseconds: number): Promise<void> {
  await page.evaluate((milliseconds) => {
    (window as unknown as { ubPageTimers: PageTimerControls }).ubPageTimers.fastForward(milliseconds);
  }, milliseconds);
}

export async function pausePageTimers(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { ubPageTimers: PageTimerControls }).ubPageTimers.pause());
}

export async function resumePageTimers(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { ubPageTimers: PageTimerControls }).ubPageTimers.resume());
}

/** Keep the assertion's normal retries while driving timers between browser turns. */
export async function withPageTimers(page: Page, assertion: () => Promise<void>): Promise<void> {
  let finished = false;
  const asserted = Promise.resolve().then(assertion).finally(() => { finished = true; });
  const driven = (async () => {
    try {
      while (!finished) {
        // Give real network responses and animation frames a turn before each tick.
        await delay(20);
        if (!finished) await advancePageTimers(page, 100);
      }
    } finally { finished = true; }
  })();
  const [assertionResult, timerResult] = await Promise.allSettled([asserted, driven]);
  if (timerResult.status === "rejected") throw timerResult.reason;
  if (assertionResult.status === "rejected") throw assertionResult.reason;
}
