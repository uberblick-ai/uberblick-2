import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FullConfig, FullResult, Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";
import { budgetFailure, DEFAULT_TEST_BUDGET_MS, testBudget } from "../../../scripts/test-duration-budget.mjs";

interface Interval { start: number; end: number }
interface Measurement {
  scope: "file" | "run" | "test";
  purpose: string;
  durationMs: number;
  test?: string;
  file?: string;
  worker?: number;
}

/** Worker fixtures without a source location are Playwright's own shared services. */
function sharedStep(step: TestStep): "file" | "run" | undefined {
  if (step.category === "hook" && (step.title === "beforeAll hook" || step.title === "afterAll hook")) return "file";
  if (step.category === "fixture" && step.location === undefined && /^Fixture "(?:browser|playwright)"$/.test(step.title)) return "run";
  return undefined;
}

function unionDuration(intervals: Interval[]): number {
  let end = 0;
  let duration = 0;
  for (const interval of [...intervals].sort((left, right) => left.start - right.start)) {
    duration += Math.max(0, interval.end - Math.max(end, interval.start));
    end = Math.max(end, interval.end);
  }
  return duration;
}

export default class TimingReporter implements Reporter {
  private started = 0;
  private output: string;
  private attempts: object[] = [];
  private shared: Measurement[] = [];
  private components: Measurement[] = [];
  private violations: string[] = [];
  private intervals = new WeakMap<TestResult, Interval[]>();
  private active = new WeakMap<TestResult, Set<TestStep>>();
  private stdoutTail = new Map<TestResult | undefined, string>();

  constructor(options: { outputFile?: string } = {}) {
    this.output = options.outputFile ?? join(process.cwd(), "test-results/test-durations.json");
  }

  onBegin(config: FullConfig): void {
    this.output = join(config.projects[0]?.outputDir ?? "test-results", "test-durations.json");
    this.started = performance.now();
  }

  onStepBegin(_test: TestCase, result: TestResult, step: TestStep): void {
    let steps = this.active.get(result);
    if (steps === undefined) {
      steps = new Set();
      this.active.set(result, steps);
    }
    steps.add(step);
  }

  onStepEnd(test: TestCase, result: TestResult, step: TestStep): void {
    this.active.get(result)?.delete(step);
    const scope = sharedStep(step);
    if (scope === undefined) return;
    const intervals = this.intervals.get(result) ?? [];
    intervals.push({ start: step.startTime.getTime(), end: step.startTime.getTime() + step.duration });
    this.intervals.set(result, intervals);
    this.shared.push({ scope, purpose: step.title, durationMs: step.duration, file: test.location.file, worker: result.workerIndex });
  }

  onStdOut(chunk: string | Buffer, test?: TestCase, result?: TestResult): void {
    const lines = `${this.stdoutTail.get(result) ?? ""}${String(chunk)}`.split("\n");
    this.stdoutTail.set(result, lines.pop() ?? "");
    for (const line of lines) {
      const match = line.match(/e2e timing: (harness startup|controls fixture startup) (\d+) ms/);
      if (match === null) continue;
      const scope = result === undefined ? "run" : [...this.active.get(result) ?? []].map(sharedStep).find(value => value !== undefined) ?? "test";
      this.components.push({
        scope, purpose: match[1] ?? "setup", durationMs: Number(match[2]),
        ...(test === undefined ? {} : { test: test.titlePath().join(" > "), file: test.location.file }),
        ...(result === undefined ? {} : { worker: result.workerIndex }),
      });
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const sharedIntervals = this.intervals.get(result) ?? [];
    // Worker timestamps keep reporter transport delays out of test cost. The
    // wall span also counts fixtures with independent timeout slots; file hooks
    // and shared browser services are reported and subtracted separately.
    const finished = Math.max(result.startTime.getTime(), ...result.steps.map(step => step.startTime.getTime() + step.duration));
    const durationMs = Math.max(result.duration, finished - result.startTime.getTime() - unionDuration(sharedIntervals));
    let budgetMs = DEFAULT_TEST_BUDGET_MS;
    let exception: unknown;
    const declarations = result.annotations.filter(annotation => annotation.type === "test-budget");
    try {
      if (declarations.length > 1) throw new Error("more than one test-budget declaration");
      if (declarations.length === 1) {
        exception = JSON.parse(declarations[0]?.description ?? "");
        budgetMs = testBudget(exception);
      }
      if (test.timeout === 0 || test.timeout > budgetMs) throw new Error(`runner timeout ${test.timeout} ms exceeds declared budget ${budgetMs} ms`);
    } catch (error) {
      this.violations.push(`${test.titlePath().join(" > ")}: invalid duration allowance: ${String(error)}. Declare a test-budget annotation with purpose, allowanceMs and maintainer approval or open decision; see .agents/development.md.`);
    }
    if (durationMs > budgetMs) {
      this.violations.push(budgetFailure(test.titlePath().join(" > "), durationMs, budgetMs).message);
    }
    this.attempts.push({
      test: test.titlePath().join(" > "), file: test.location.file, line: test.location.line,
      project: test.parent.project()?.name, worker: result.workerIndex, retry: result.retry,
      status: result.status, durationMs, runnerDurationMs: result.duration, budgetMs,
      ...(exception === undefined ? {} : { exception }),
    });
  }

  async onEnd(result: FullResult): Promise<{ status: "failed" } | undefined> {
    const suiteWallMs = this.started === 0 ? 0 : Math.round(performance.now() - this.started);
    console.log(`e2e timing: suite wall ${suiteWallMs} ms`);
    for (const violation of this.violations) console.error(`Test duration budget: ${violation}`);
    try {
      const sharedFile = join(dirname(this.output), "shared-timings.jsonl");
      if (existsSync(sharedFile)) {
        this.components.push(...readFileSync(sharedFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Measurement));
      }
    } catch (error) {
      console.warn(`Could not read shared Playwright timings: ${String(error)}`);
    }
    try {
      mkdirSync(dirname(this.output), { recursive: true });
      writeFileSync(this.output, `${JSON.stringify({
        version: 1, status: result.status === "passed" && this.violations.length > 0 ? "failed" : result.status, suiteWallMs,
        tests: this.attempts, shared: this.shared, components: this.components,
        note: "Shared measurements can be nested. Components are included in their enclosing test or shared hook; do not sum overlapping measurements.",
        violations: this.violations,
      }, null, 2)}\n`);
    } catch (error) {
      console.warn(`Could not write Playwright duration report: ${String(error)}`);
    }
    return this.violations.length === 0 || result.status !== "passed" ? undefined : { status: "failed" };
  }
}
