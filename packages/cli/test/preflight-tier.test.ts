/**
 * The `next-issue` preflight decision table.
 *
 * The deliverable of that skill is prose a coordinator reads, and prose cannot
 * be run — so the tables it routes on also exist as
 * `.claude/skills/next-issue/preflight-tier.mjs`, and these tests hold the two
 * together. The tier table and the lifecycle table are each parsed out of
 * `SKILL.md` and replayed through the module, so a row edited in one home and
 * not the other is a red test. What is deliberately *not* here: assertions
 * that restate the module against its own definition.
 *
 * This suite lives in `@uberblick/cli` for the same reason `mise-welcome.test.ts`
 * does: it is where repository-level checks already run under `mise run test`.
 * The module sits next to the skill, because a table drifting from the
 * procedure it describes is the failure this fixture exists to catch.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.js";

const SKILL_DIR = join(REPO_ROOT, ".claude", "skills", "next-issue");
const MODULE_PATH = join(SKILL_DIR, "preflight-tier.mjs");

/**
 * Two checkouts, two behaviors — and the difference matters, because a skip is
 * a drift guard switched off.
 *
 * The immutable review image is source-only: the runner archives the tree, and
 * `main`'s `.dockerignore` drops `.git` along with `.claude`. There the skill
 * genuinely is not there and cannot be, so the suite skips loudly rather than
 * reddening a gate it has no way to pass. (This branch un-ignores
 * `.claude/skills/**`, but a `.dockerignore` only takes effect from `main`, so
 * the skip is still needed for one review cycle.)
 *
 * Anywhere with a `.git` at the root — CI, a worktree, a contributor's clone —
 * a missing skill directory means the fixture has come apart, and skipping
 * would silently drop the guard exactly when something moved. So: fail, by
 * name, before a single test is collected.
 */
const PRESENT = existsSync(MODULE_PATH);
const SOURCE_ONLY = !existsSync(join(REPO_ROOT, ".git"));

if (!PRESENT && !SOURCE_ONLY) {
  throw new Error(
    `${MODULE_PATH} is missing from a checkout that has a .git, so the preflight drift guard cannot run. Only the source-only Docker review image may skip this suite — if the skill moved, move this test with it.`,
  );
}

// A runtime path, so tsc leaves the untyped `.mjs` alone and the test loads it
// exactly where a coordinator reading the skill would find it.
const { classify, preflight, AXES, BLOCKERS } = PRESENT
  ? await import(pathToFileURL(MODULE_PATH).href)
  : { classify: undefined, preflight: undefined, AXES: undefined, BLOCKERS: undefined };

const SKILL = PRESENT ? readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8") : "";

type Axes = Record<string, string>;

/** Every combination the module's own axis vocabularies can take — 24 of them. */
function everyCombination(): Axes[] {
  let all: Axes[] = [{}];
  for (const [axis, values] of Object.entries(AXES) as [string, string[]][]) {
    all = all.flatMap((partial) => values.map((value) => ({ ...partial, [axis]: value })));
  }
  return all;
}

/**
 * The cells of one markdown table in `SKILL.md`, as rows of strings.
 *
 * The header is matched on its column names rather than on its position, so
 * reordering the prose cannot silently make this parse a different table — and
 * a table that has gone missing throws here rather than passing vacuously.
 */
function markdownTable(...columns: string[]): string[][] {
  const lines = SKILL.split("\n");
  const header = lines.findIndex((line) => columns.every((column) => line.includes(column)));
  if (header === -1) throw new Error(`SKILL.md has no table with columns ${columns.join(", ")}`);

  const rows: string[][] = [];
  // +2 skips the header and the `|---|` separator beneath it.
  for (const line of lines.slice(header + 2)) {
    const text = line.trim();
    if (!text.startsWith("|")) break;
    rows.push(text.split("|").slice(1, -1).map((cell) => cell.trim()));
  }
  if (rows.length === 0) throw new Error(`table ${columns.join(", ")} has no rows`);
  return rows;
}

/** `add \`x\`, remove \`y\`` — the vocabulary the Labels column is written in. */
function labelsFrom(cell: string): { add: string[]; remove: string[] } {
  const labels: { add: string[]; remove: string[] } = { add: [], remove: [] };
  for (const [, verb, label] of cell.matchAll(/\b(add|remove) `([a-z-]+)`/g)) {
    labels[verb as "add" | "remove"].push(label as string);
  }
  return labels;
}

const describeTable = describe.skipIf(!PRESENT);

describeTable(
  PRESENT
    ? "the skill's tables and the module's tables are the same tables"
    : "the preflight table (SKIPPED: source-only checkout — the Docker review image carries no .claude/skills)",
  () => {
    it("routes every documented row of the tier table", () => {
      const rows = markdownTable("| Materiality |", "| Tier |", "| Challengers |");
      for (const [materiality, uncertainty, blastRadius, reversibility, tier, challengers] of rows) {
        const axes = { materiality, uncertainty, blastRadius, reversibility };
        expect(preflight(axes), JSON.stringify(axes)).toMatchObject({
          tier,
          challengers: Number(challengers),
        });
      }
    });

    it("documents a row for each of the 0, 1 and 2 challenger routes", () => {
      const rows = markdownTable("| Materiality |", "| Tier |", "| Challengers |");
      expect(new Set(rows.map((row) => Number(row[5])))).toEqual(new Set([0, 1, 2]));
    });

    it("routes every documented row of the lifecycle table, whatever the tier", () => {
      const rows = markdownTable("| Still eligible at the recheck |", "| Outcome |", "| Claim |");
      for (const [eligible = "", found = "", outcome, labels = "", claim, comment = ""] of rows) {
        const token = found.match(/`([a-z-]+)`/)?.[1];
        if (token === undefined) throw new Error(`lifecycle row names no blocker: ${found}`);
        // `any` is the row that says the recheck outranks every finding, so it
        // is replayed against the module's whole blocker vocabulary.
        const cases: string[] = token === "any" ? BLOCKERS : [token];

        for (const blocker of cases) {
          for (const axes of everyCombination()) {
            const signals = { ...axes, blocker, stillEligible: eligible === "yes" };
            const where = JSON.stringify(signals);
            const plan = preflight(signals);
            expect(plan.outcome, where).toBe(outcome);
            expect(plan.claim, where).toBe(claim === "yes");
            expect(plan.labels, where).toEqual(labelsFrom(labels));
            // "only when a challenger ran or the self-check found something" is
            // the one conditional cell, and it is asserted both ways.
            if (comment === "yes" || comment === "no") {
              expect(plan.comment, where).toBe(comment === "yes");
            } else {
              expect(preflight({ ...signals, findings: true }).comment, where).toBe(true);
              expect(preflight({ ...signals, findings: false }).comment, where).toBe(
                plan.challengers > 0,
              );
            }
          }
        }
      }
    });

    it("cannot be escalated by a package name, a label or a keyword", () => {
      const mechanical = {
        materiality: "mechanical",
        uncertainty: "low",
        blastRadius: "local",
        reversibility: "easy",
      };
      // `Touches` is not a weak signal here, it is not a signal at all: passing
      // one is an error rather than an input the table quietly weighs.
      expect(() => classify({ ...mechanical, touches: ["schema"] })).toThrow(
        /unknown signal "touches"/,
      );
      // And a change proven mechanical stays trivial however sensitive its
      // neighbourhood: the grounding read outranks the neighbourhood.
      expect(classify(mechanical)).toBe("trivial");
    });

    it("never lowers a tier for uncertainty, and lifts a bounded change to two challengers", () => {
      const tiers = ["trivial", "bounded", "substantial"];
      for (const axes of everyCombination()) {
        if (axes.uncertainty !== "low") continue;
        const certain = tiers.indexOf(classify(axes));
        const uncertain = tiers.indexOf(classify({ ...axes, uncertainty: "high" }));
        expect(uncertain, JSON.stringify(axes)).toBeGreaterThanOrEqual(certain);
      }
      expect(
        classify({
          materiality: "behavioral",
          uncertainty: "high",
          blastRadius: "local",
          reversibility: "easy",
        }),
      ).toBe("substantial");
    });

    it("lets another agent's claim outrank a finding of its own", () => {
      // The race the ordering exists for: the preflight found a stale contract,
      // and by the recheck someone else owns the issue. Stripping `ready` or
      // commenting would be acting on live work from the outside.
      expect(
        preflight({
          materiality: "behavioral",
          uncertainty: "low",
          blastRadius: "local",
          reversibility: "easy",
          blocker: "stale-spec",
          findings: true,
          stillEligible: false,
        }),
      ).toMatchObject({
        outcome: "requeue",
        claim: false,
        labels: { add: [], remove: [] },
        comment: false,
      });
    });
  },
);
