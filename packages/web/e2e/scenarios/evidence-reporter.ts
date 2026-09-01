/**
 * #628's throwaway evidence reporter. Not a product mechanism.
 *
 * It reacts to one thing: a test declared with
 * `{ annotation: { type: "scenario", description: "<id>" } }`. Every other test
 * in the suite passes through it untouched, which is why registering it in
 * `playwright.config.ts` does not turn recording on for anything: the video
 * comes from the `scenario` project there, which holds exactly the `@scenario`
 * test, and this reporter only files what that project produced.
 *
 * For an annotated test it writes, under `packages/web/scenario-evidence/`:
 *
 *   <scenario id>/<started>-<status>/index.html      a person opens this
 *                                    provenance.json  the same facts, machine-side
 *                                    video.webm       if the run recorded one
 *
 * One directory per run, named by when it started, so a later run — passing or
 * failing — never overwrites an earlier one. Whether that makes the earlier one
 * *readable as history* is exactly the question #628 asks; see the PR's paper.
 *
 * Not under `test-results/`, which is where this first wrote: Playwright empties
 * its output directory at the start of every run, so the second run deleted the
 * first run's evidence before recording its own. History cannot live inside the
 * thing that clears itself.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");
const repoRoot = resolve(webRoot, "../..");

type Provenance = {
  scenario: { id: string; file: string; revision: string };
  test: { title: string; file: string };
  product: { commit: string; dirty: boolean };
  browser: { name: string; version: string; project: string; viewport: unknown };
  run: { status: string; expected: boolean; startedAt: string; durationMs: number };
};

function git(...args: string[]): string {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function scenarioIdOf(test: TestCase): string | null {
  const found = test.annotations.find((a) => a.type === "scenario");
  return found?.description ?? null;
}

/** The scenario's revision is the hash of the file, so a reworded claim is a new one. */
function revisionOf(file: string): string {
  if (!existsSync(file)) return "missing";
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
}

type Runtime = { name: string; version: string; viewport: unknown };

const unknownRuntime: Runtime = { name: "unknown", version: "unknown", viewport: null };

function runtimeOf(result: TestResult): Runtime {
  const attached = result.attachments.find((a) => a.name === "scenario-runtime.json");
  if (attached?.body === undefined && attached?.path === undefined) return unknownRuntime;
  try {
    const raw = attached.body ?? readFileSync(attached.path as string);
    const parsed = JSON.parse(raw.toString("utf8")) as Partial<{
      browserName: string;
      browserVersion: string;
      viewport: unknown;
    }>;
    return {
      name: parsed.browserName ?? "unknown",
      version: parsed.browserVersion ?? "unknown",
      viewport: parsed.viewport ?? null,
    };
  } catch {
    return unknownRuntime;
  }
}

function html(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function page(p: Provenance, video: string | null, scenarioText: string): string {
  const rows: [string, string][] = [
    ["Scenario", `${p.scenario.id} @ ${p.scenario.revision}`],
    ["Scenario file", p.scenario.file],
    ["Test", p.test.title],
    ["Test file", p.test.file],
    ["Product commit", `${p.product.commit}${p.product.dirty ? " (working tree dirty)" : ""}`],
    ["Browser", `${p.browser.name} ${p.browser.version} (project ${p.browser.project})`],
    ["Viewport", JSON.stringify(p.browser.viewport)],
    ["Result", `${p.run.status}${p.run.expected ? "" : " (unexpected)"}`],
    ["Started", p.run.startedAt],
    ["Run time", `${(p.run.durationMs / 1000).toFixed(1)}s`],
  ];
  return `<!doctype html>
<meta charset="utf-8">
<title>${html(p.scenario.id)} — ${html(p.run.status)} — ${html(p.run.startedAt)}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 52rem; }
  table { border-collapse: collapse; margin: 1rem 0; }
  th, td { border: 1px solid #ccc; padding: .35rem .6rem; text-align: left; vertical-align: top; }
  th { white-space: nowrap; }
  video { max-width: 100%; border: 1px solid #ccc; }
  pre { background: #f5f5f5; padding: 1rem; white-space: pre-wrap; }
  .warn { background: #fff6d5; border: 1px solid #e0c766; padding: .75rem 1rem; }
</style>
<h1>${html(p.scenario.id)} — ${html(p.run.status)}</h1>
<p class="warn">One local run, recorded at the time in the table. It says nothing
about any other commit, browser or scenario revision, and nothing updates it
afterwards.</p>
<table>${rows
    .map(([k, v]) => `\n  <tr><th>${html(k)}</th><td>${html(v)}</td></tr>`)
    .join("")}
</table>
${video === null ? "<p>No video was recorded for this run.</p>" : `<video controls src="${html(video)}"></video>`}
<h2>The scenario, as it read at ${html(p.scenario.revision)}</h2>
<pre>${html(scenarioText)}</pre>
`;
}

export default class ScenarioEvidenceReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult): void {
    const id = scenarioIdOf(test);
    if (id === null) return;

    const scenarioFile = join(here, `${id}.md`);
    const startedAt = result.startTime.toISOString();
    const dir = join(
      webRoot,
      "scenario-evidence",
      id,
      `${startedAt.replaceAll(/[:.]/g, "-")}-${result.status}`,
    );
    mkdirSync(dir, { recursive: true });

    const runtime = runtimeOf(result);
    const provenance: Provenance = {
      scenario: {
        id,
        file: relative(repoRoot, scenarioFile),
        revision: revisionOf(scenarioFile),
      },
      // Past the project and the file, both of which have their own place.
      test: {
        title: test.titlePath().slice(3).join(" › "),
        file: relative(repoRoot, test.location.file),
      },
      product: {
        commit: git("rev-parse", "HEAD") || "unknown",
        dirty: git("status", "--porcelain") !== "",
      },
      browser: {
        name: runtime.name,
        version: runtime.version,
        project: test.parent.project()?.name ?? "unknown",
        viewport: runtime.viewport,
      },
      run: {
        status: result.status,
        expected: result.status === test.expectedStatus,
        startedAt,
        durationMs: result.duration,
      },
    };

    // Only claim a video on the page when one was actually copied: an attachment
    // whose file is gone would otherwise leave a broken player behind.
    const source = result.attachments.find((a) => a.name === "video")?.path;
    const recorded = source !== undefined && existsSync(source);
    if (recorded) copyFileSync(source, join(dir, "video.webm"));

    const scenarioText = existsSync(scenarioFile)
      ? readFileSync(scenarioFile, "utf8")
      : `(no scenario file at ${provenance.scenario.file})`;

    writeFileSync(join(dir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
    writeFileSync(
      join(dir, "index.html"),
      page(provenance, recorded ? "video.webm" : null, scenarioText),
    );
    process.stdout.write(`  scenario evidence: ${relative(repoRoot, join(dir, "index.html"))}\n`);
  }
}
