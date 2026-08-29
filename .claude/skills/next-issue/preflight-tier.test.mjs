/**
 * The `next-issue` preflight decision table.
 *
 * The deliverable of that skill is prose a coordinator reads, and prose cannot
 * be run — so the tables it routes on also exist as `preflight-tier.mjs` next
 * to this file, and these tests hold the two together. The tier table and the
 * lifecycle table are each parsed out of `preflight.md` and replayed through
 * the module, so a row edited in one home and not the other is a red test.
 * What is deliberately *not* here: assertions that restate the module against
 * its own definition.
 *
 * Runner: `node:test`, not vitest, and the suite sits beside the module rather
 * than inside `@uberblick/cli`. `pnpm-workspace.yaml` globs `packages/*` only,
 * so nothing under `.claude/` is reachable from `pnpm -r test`; the root
 * `test` script therefore invokes this file explicitly, and `mise run test`
 * and the Docker review both go through that one script.
 *
 * The source-only skip lives in that root script rather than in here, because
 * it has to: this suite is a sibling of the module, so a checkout without
 * `.claude/skills` has no suite to skip from the inside. The script checks for
 * the directory and says out loud that it skipped. Inside the suite the
 * opposite rule applies — a suite that exists while its module does not is a
 * fixture that came apart, and that fails by name rather than skipping.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AXES,
  BLOCKERS,
  classify,
  preflight,
  routeTransition,
} from "./preflight-tier.mjs";

// The prose half is read from disk, so its path comes from this file's own
// location rather than from the process's working directory: the suite is run
// by an explicit path from the repository root, not from inside this folder.
const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const PREFLIGHT = readFileSync(join(SKILL_DIR, "preflight.md"), "utf8");

/** Every combination the module's own axis vocabularies can take — 24 of them. */
function everyCombination() {
  let all = [{}];
  for (const [axis, values] of Object.entries(AXES)) {
    all = all.flatMap((partial) => values.map((value) => ({ ...partial, [axis]: value })));
  }
  return all;
}

/**
 * The cells of one markdown table in `preflight.md`, as rows of strings.
 *
 * The header is matched on its column names rather than on its position, so
 * reordering the prose cannot silently make this parse a different table — and
 * a table that has gone missing throws here rather than passing vacuously.
 */
function markdownTable(...columns) {
  const lines = PREFLIGHT.split("\n");
  const header = lines.findIndex((line) => columns.every((column) => line.includes(column)));
  if (header === -1)
    throw new Error(`preflight.md has no table with columns ${columns.join(", ")}`);

  const rows = [];
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
function labelsFrom(cell) {
  const labels = { add: [], remove: [] };
  for (const [, verb, label] of cell.matchAll(/\b(add|remove) `([a-z-]+)`/g)) {
    labels[verb].push(label);
  }
  return labels;
}

/** `toMatchObject`, in the one shape this suite needs: compare only these keys. */
function assertSubset(actual, expected, where) {
  const narrowed = {};
  for (const key of Object.keys(expected)) narrowed[key] = actual[key];
  assert.deepEqual(narrowed, expected, where);
}

describe("the skill's tables and the module's tables are the same tables", () => {
  it("routes every documented row of the tier table", () => {
    const rows = markdownTable("| Materiality |", "| Tier |", "| Challengers |");
    for (const [materiality, uncertainty, blastRadius, reversibility, tier, challengers] of rows) {
      const axes = { materiality, uncertainty, blastRadius, reversibility };
      assertSubset(
        preflight(axes),
        { tier, challengers: Number(challengers) },
        JSON.stringify(axes),
      );
    }
  });

  it("documents a row for each of the 0, 1 and 2 challenger routes", () => {
    const rows = markdownTable("| Materiality |", "| Tier |", "| Challengers |");
    assert.deepEqual(new Set(rows.map((row) => Number(row[5]))), new Set([0, 1, 2]));
  });

  it("routes every documented row of the lifecycle table, whatever the tier", () => {
    const rows = markdownTable("| Still eligible at the recheck |", "| Outcome |", "| Claim |");
    for (const [
      eligible = "",
      found = "",
      outcome,
      labels = "",
      claim,
      comment = "",
      findingsNarrative = "",
    ] of rows) {
      const token = found.match(/`([a-z-]+)`/)?.[1];
      if (token === undefined) throw new Error(`lifecycle row names no blocker: ${found}`);
      // `any` is the row that says the recheck outranks every finding, so it
      // is replayed against the module's whole blocker vocabulary.
      const cases = token === "any" ? BLOCKERS : [token];

      for (const blocker of cases) {
        for (const axes of everyCombination()) {
          const signals = { ...axes, blocker, stillEligible: eligible === "yes" };
          const where = JSON.stringify(signals);
          const plan = preflight(signals);
          assert.equal(plan.outcome, outcome, where);
          assert.equal(plan.claim, claim === "yes", where);
          assert.deepEqual(plan.labels, labelsFrom(labels), where);
          assert.equal(plan.comment, comment === "yes", where);
          // The findings narrative is the one conditional cell. The durable
          // handoff above remains required even when this part is absent.
          if (findingsNarrative === "yes" || findingsNarrative === "no") {
            assert.equal(plan.findingsNarrative, findingsNarrative === "yes", where);
          } else {
            assert.equal(
              preflight({ ...signals, findings: true }).findingsNarrative,
              true,
              where,
            );
            assert.equal(
              preflight({ ...signals, findings: false }).findingsNarrative,
              plan.challengers > 0,
              where,
            );
          }
        }
      }
    }
  });

  it("routes every documented durable transition without a stored lifecycle marker", () => {
    const rows = markdownTable(
      "| Transition |",
      "| Before later ready |",
      "| After later ready |",
      "| Claim removes ready |",
    );
    for (const [transitionCell, , beforeReady, afterReady, removeReady] of rows) {
      const transition = transitionCell.match(/`([a-z-]+)`/)?.[1];
      if (transition === undefined) throw new Error(`transition row has no key: ${transitionCell}`);
      for (const readyAfter of [false, true]) {
        const expectedRole = (readyAfter ? afterReady : beforeReady) === "none"
          ? null
          : readyAfter
            ? afterReady
            : beforeReady;
        assert.deepEqual(
          routeTransition({ transition, readyAfter }),
          {
            role: expectedRole,
            labels: {
              remove:
                readyAfter && expectedRole === "issue-preparer" && removeReady === "yes"
                  ? ["ready"]
                  : [],
            },
          },
          JSON.stringify({ transition, readyAfter }),
        );
      }
    }
  });

  it("records a clean trivial handoff before owner ready admits implementation", () => {
    const cleanTrivial = preflight({
      materiality: "mechanical",
      uncertainty: "low",
      blastRadius: "local",
      reversibility: "easy",
    });
    assert.equal(cleanTrivial.comment, true);
    assert.equal(cleanTrivial.findingsNarrative, false);
    assert.equal(routeTransition({ transition: "small-clearance" }).role, null);
    assert.equal(
      routeTransition({ transition: "small-clearance", readyAfter: true }).role,
      "implementer",
    );
  });

  it("routes a resolved decision through a fresh proportional challenge", () => {
    const parked = preflight({
      materiality: "behavioral",
      uncertainty: "low",
      blastRadius: "local",
      reversibility: "easy",
      blocker: "product-decision",
    });
    assert.equal(parked.outcome, "park-needs-decision");

    assert.deepEqual(
      routeTransition({ transition: "decision-recovery", readyAfter: true }),
      { role: "issue-preparer", labels: { remove: ["ready"] } },
    );
    const challenged = preflight({
      materiality: "behavioral",
      uncertainty: "low",
      blastRadius: "local",
      reversibility: "easy",
    });
    assert.equal(challenged.challengers, 1);
    assert.equal(challenged.comment, true);
    assert.equal(routeTransition({ transition: "small-clearance" }).role, null);
    assert.equal(
      routeTransition({ transition: "small-clearance", readyAfter: true }).role,
      "implementer",
    );
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
    assert.throws(
      () => classify({ ...mechanical, touches: ["schema"] }),
      /unknown signal "touches"/,
    );
    // And a change proven mechanical stays trivial however sensitive its
    // neighbourhood: the grounding read outranks the neighbourhood.
    assert.equal(classify(mechanical), "trivial");
  });

  it("never lowers a tier for uncertainty, and lifts a bounded change to two challengers", () => {
    const tiers = ["trivial", "bounded", "substantial"];
    for (const axes of everyCombination()) {
      if (axes.uncertainty !== "low") continue;
      const certain = tiers.indexOf(classify(axes));
      const uncertain = tiers.indexOf(classify({ ...axes, uncertainty: "high" }));
      assert.ok(uncertain >= certain, JSON.stringify(axes));
    }
    assert.equal(
      classify({
        materiality: "behavioral",
        uncertainty: "high",
        blastRadius: "local",
        reversibility: "easy",
      }),
      "substantial",
    );
  });

  it("records how a two-challenger route was made independent, diverse or not", () => {
    // The fallback is the point: where no second model family, harness or
    // approach is available, two separate fresh contexts still satisfy
    // independence — but which one was used has to reach the comment, so a
    // regression that stopped recording it would be invisible in the prose.
    for (const axes of everyCombination()) {
      for (const diverseChallengers of [true, false]) {
        const plan = preflight({ ...axes, diverseChallengers });
        const where = JSON.stringify({ ...axes, diverseChallengers });
        if (plan.challengers === 2) {
          assert.equal(plan.independence, diverseChallengers ? "diverse" : "fresh-context", where);
        } else {
          // One challenger is a fresh context; none is none. Diversity is a
          // property of a pair, so it never shows up on those routes.
          assert.equal(
            plan.independence,
            plan.challengers === 1 ? "fresh-context" : "none",
            where,
          );
        }
      }
    }
  });

  it("lets another agent's claim outrank a finding of its own", () => {
    // The race the ordering exists for: the preflight found a stale contract,
    // and by the recheck someone else owns the issue. Stripping `ready` or
    // commenting would be acting on live work from the outside.
    assertSubset(
      preflight({
        materiality: "behavioral",
        uncertainty: "low",
        blastRadius: "local",
        reversibility: "easy",
        blocker: "stale-spec",
        findings: true,
        stillEligible: false,
      }),
      {
        outcome: "requeue",
        claim: false,
        labels: { add: [], remove: [] },
        comment: false,
      },
      "a claim by another agent",
    );
  });
});
