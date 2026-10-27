import { writeFileSync, mkdirSync } from "node:fs";
import { chromium, expect } from "@playwright/test";
import { createHash } from "node:crypto";

const origin = "http://127.0.0.1:4178";
const data = await fetch(`${origin}/_spike/index.json`).then(response => response.json());
const run = data.runs[0];
const output = "scenario-evidence/inspection";
mkdirSync(output, { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/?scenario=history-restore`);
  const video = page.locator("#scenario-player video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  for (const [index, moment] of run.moments.entries()) {
    await page.getByRole("button", { name: moment.title, exact: true }).click();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(moment.seconds, 2);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
    await video.screenshot({ path: `${output}/moment-${index}.png` });
  }
  await page.getByRole("button", { name: "Copy paused moment into a request" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(run.id);
  expect(copied).toContain("Observed:");
  writeFileSync(`${output}/copied-request.txt`, copied);
  const link = copied.match(/Evidence \(same machine\): (.+)/)?.[1];
  if (!link) throw new Error("No evidence link in request");
  await page.goto(link);
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(run.moments.at(-1).seconds, 2);
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  const before = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await video.evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(before + 0.1);
  await video.evaluate((v: HTMLVideoElement) => v.pause());
  await page.getByLabel("Playback speed").selectOption("0.5");
  expect(await video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(0.5);
  await video.evaluate((v: HTMLVideoElement) => v.requestFullscreen());
  await expect.poll(() => video.evaluate(v => document.fullscreenElement === v)).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await page.screenshot({ path: `${output}/player.png`, fullPage: true });
  if (data.runs.length > 1) {
    const old = data.runs.at(-1);
    const oldLink = new URL("/", origin);
    oldLink.search = new URLSearchParams({ scenario: "history-restore", recording: old.id, actor: "member", t: "12.748" }).toString();
    await page.goto(oldLink.href);
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(12.748, 2);
    expect(await video.getAttribute("src")).toContain(old.id);
    await expect(page.getByText(/A newer recording exists/)).toBeVisible();
    const bytes = await fetch(`${origin}/_spike/${old.id}/member.webm`).then(response => response.arrayBuffer());
    expect(createHash("sha256").update(Buffer.from(bytes)).digest("hex")).toBe(old.mediaSha256);
    await page.screenshot({ path: `${output}/original-after-refresh.png`, fullPage: true });
  }
  const missing = new URL(link); missing.searchParams.set("recording", "not-present");
  await page.goto(missing.href);
  await expect(page.getByText("That recording is unavailable. No newer recording has been substituted.")).toBeVisible();
  await expect(video).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ run: run.id, moments: run.moments.length, copiedLink: link, errors, result: "passed" }, null, 2));
} finally { await browser.close(); }
