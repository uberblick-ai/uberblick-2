import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as hold } from "node:timers/promises";
import type { Page, TestInfo } from "@playwright/test";
import { scenario } from "../scripts/scenario-spike/scenario.js";

export const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export function sourceFacts() {
  const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8" }).trim();
  return {
    commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain") !== "",
    diffSha256: digest(git("diff", "HEAD", "--", ":/packages")),
    recorderSha256: digest(readFileSync(resolve("e2e/scenario-recording.ts"))),
    testSha256: digest(readFileSync(resolve("e2e/revision-history.spec.ts"))),
    scenarioSha256: digest(JSON.stringify(scenario)),
  };
}

/** Optional evidence only: ordinary runs do not record or pause for a reader. */
export async function recordScenario(page: Page, info: TestInfo) {
  const output = process.env.UB_SCENARIO_RECORDING_DIR;
  const moments: { title: string; seconds: number }[] = [];
  let firstFrame: number | undefined;
  let stopped = false;
  let complete = false;
  const started = Date.now();
  const facts = output === undefined ? undefined : sourceFacts();
  if (output !== undefined) {
    mkdirSync(output, { recursive: true });
    await page.screencast.start({
      path: resolve(output, "member.webm"),
      size: page.viewportSize() ?? { width: 1280, height: 720 },
      onFrame: frame => { firstFrame ??= frame.timestamp; },
    });
    await page.screencast.showActions({ cursor: "pointer", duration: 700, position: "bottom-left", fontSize: 16 });
  }
  return {
    async moment(title: string) {
      if (output === undefined) return;
      // Reader dwell is recording-only, after the test has asserted the state.
      await hold(350);
      moments.push({ title, seconds: Math.max(0, (Date.now() - (firstFrame ?? started)) / 1000) });
      await hold(1_150);
    },
    async stop() {
      complete = true;
      if (output === undefined || stopped) return;
      await page.screencast.hideActions();
      await page.screencast.stop();
      stopped = true;
    },
    async finish() {
      if (output === undefined) return;
      let media = "complete";
      try {
        if (!stopped) {
          await page.screencast.hideActions();
          await page.screencast.stop();
        }
      } catch (error) {
        media = `incomplete: ${String(error)}`;
      }
      writeFileSync(resolve(output, "capture.json"), JSON.stringify({
        scenario, ...facts, recordedAt: new Date(started).toISOString(),
        browser: page.context().browser()?.version(), viewport: page.viewportSize(),
        variant: info.project.name, actor: "member", clip: "member.webm", moments,
        scenarioCompleted: complete, media,
      }, null, 2));
    },
  };
}
