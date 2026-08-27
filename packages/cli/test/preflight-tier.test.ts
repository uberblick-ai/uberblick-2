/**
 * The `next-issue` preflight decision table.
 *
 * The deliverable of that skill is prose a coordinator reads, and prose cannot
 * be run — so the table it routes on also exists as
 * `.claude/skills/next-issue/preflight-tier.mjs`, and these tests hold the two
 * together. Two things are defended here and nothing else: that every row of
 * the table in `SKILL.md` is the row the module computes, and that the
 * lifecycle a preflight can end in never claims an issue it did not clear.
 *
 * This suite lives in `@uberblick/cli` for the same reason `mise-welcome.test.ts`
 * does: it is where repository-level checks already run under `mise run test`.
 * The module itself sits next to the skill, because a table that drifts from
 * the procedure it describes is the failure this whole fixture exists to catch.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.js";

const SKILL_DIR = join(REPO_ROOT, ".claude", "skills", "next-issue");

// A runtime path, so tsc leaves the untyped `.mjs` alone and the test loads it
// exactly where a coordinator reading the skill would find it.
const { classify, preflight, TIERS, CHALLENGERS, OUTCOMES } = await import(
  pathToFileURL(join(SKILL_DIR, "preflight-tier.mjs")).href
);

const SKILL = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");

const MATERIALITY = ["mechanical", "behavioral", "architectural"];
const UNCERTAINTY = ["low", "high"];
const BLAST_RADIUS = ["local", "wide"];
const REVERSIBILITY = ["easy", "hard"];

type Axes = {
  materiality: string;
  uncertainty: string;
  blastRadius: string;
  reversibility: string;
};

/** Every combination the four axes can take — 24 of them. */
const EVERY_COMBINATION: Axes[] = MATERIALITY.flatMap((materiality) =>
  UNCERTAINTY.flatMap((uncertainty) =>
    BLAST_RADIUS.flatMap((blastRadius) =>
      REVERSIBILITY.map((reversibility) => ({
        materiality,
        uncertainty,
        blastRadius,
        reversibility,
      })),
    ),
  ),
);

/**
 * The rows of the skill's markdown table, as data.
 *
 * The header is matched rather than the position, so reordering the prose
 * around the table cannot silently make this parse a different one — and a
 * table that has gone missing throws here rather than passing vacuously.
 */
function skillTableRows(): { axes: Axes; tier: string; challengers: number }[] {
  const lines = SKILL.split("\n");
  const header = lines.findIndex(
    (line) =>
      line.includes("| Materiality |") &&
      line.includes("| Tier |") &&
      line.includes("| Challengers |"),
  );
  if (header === -1) throw new Error("SKILL.md has no preflight tier table");

  const rows: { axes: Axes; tier: string; challengers: number }[] = [];
  // +2 skips the header and the `|---|` separator beneath it.
  for (const line of lines.slice(header + 2)) {
    const text = line.trim();
    if (!text.startsWith("|")) break;
    const cells = text
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().replaceAll("`", ""));
    if (cells.length !== 6) {
      throw new Error(`preflight tier table row has ${cells.length} cells, expected 6: ${text}`);
    }
    const [
      materiality = "",
      uncertainty = "",
      blastRadius = "",
      reversibility = "",
      tier = "",
      challengers = "",
    ] = cells;
    rows.push({
      axes: { materiality, uncertainty, blastRadius, reversibility },
      tier,
      challengers: Number(challengers),
    });
  }
  if (rows.length === 0) throw new Error("preflight tier table has no rows");
  return rows;
}

describe("the skill's table and the module's table are one table", () => {
  it("routes every documented row the way the skill says it does", () => {
    for (const row of skillTableRows()) {
      const plan = preflight(row.axes);
      expect(
        { tier: plan.tier, challengers: plan.challengers },
        JSON.stringify(row.axes),
      ).toEqual({ tier: row.tier, challengers: row.challengers });
    }
  });

  it("documents a row for each of the 0, 1 and 2 challenger routes", () => {
    const documented = new Set(skillTableRows().map((row) => row.challengers));
    expect(documented).toEqual(new Set([0, 1, 2]));
  });

  it("names every outcome and every label the module can produce", () => {
    for (const outcome of OUTCOMES) expect(SKILL).toContain(outcome);
    for (const label of ["in-progress", "ready", "needs-decision"]) {
      expect(SKILL).toContain(label);
    }
  });
});

describe("classification", () => {
  it("sends a mechanical, local, reversible, understood change to no challenger", () => {
    expect(
      preflight({
        materiality: "mechanical",
        uncertainty: "low",
        blastRadius: "local",
        reversibility: "easy",
      }),
    ).toMatchObject({ tier: "trivial", challengers: 0, independence: "none" });
  });

  it("sends established behavior with contained impact to one challenger", () => {
    expect(
      preflight({
        materiality: "behavioral",
        uncertainty: "low",
        blastRadius: "local",
        reversibility: "easy",
      }),
    ).toMatchObject({ tier: "bounded", challengers: 1 });
  });

  it("sends architectural, wide or irreversible changes to two challengers", () => {
    for (const axes of EVERY_COMBINATION) {
      if (
        axes.materiality !== "architectural" &&
        axes.blastRadius !== "wide" &&
        axes.reversibility !== "hard"
      ) {
        continue;
      }
      expect(classify(axes), JSON.stringify(axes)).toBe("substantial");
    }
  });

  it("sends a genuinely ambiguous change to two challengers, and never downward", () => {
    for (const axes of EVERY_COMBINATION) {
      if (axes.uncertainty !== "low") continue;
      const certain = TIERS.indexOf(classify(axes));
      const uncertain = TIERS.indexOf(classify({ ...axes, uncertainty: "high" }));
      expect(uncertain, JSON.stringify(axes)).toBeGreaterThanOrEqual(certain);
    }
    // The ambiguous case the acceptance criteria name: real behavior whose
    // outcome the grounding read could not state.
    expect(
      classify({
        materiality: "behavioral",
        uncertainty: "high",
        blastRadius: "local",
        reversibility: "easy",
      }),
    ).toBe("substantial");
  });

  it("cannot be escalated by a package name, a label or a keyword", () => {
    // `Touches` is not a weak signal here, it is not a signal at all: passing
    // one is an error rather than an input the table quietly weighs.
    expect(() =>
      classify({
        materiality: "mechanical",
        uncertainty: "low",
        blastRadius: "local",
        reversibility: "easy",
        touches: ["schema"],
      }),
    ).toThrow(/unknown signal "touches"/);

    // And a change proven mechanical stays trivial however sensitive its
    // neighbourhood: the grounding read outranks the neighbourhood.
    expect(
      classify({
        materiality: "mechanical",
        uncertainty: "low",
        blastRadius: "local",
        reversibility: "easy",
      }),
    ).toBe("trivial");
  });
});

describe("independence", () => {
  const substantial = {
    materiality: "architectural",
    uncertainty: "low",
    blastRadius: "local",
    reversibility: "easy",
  };

  it("prefers diverse challengers where they exist", () => {
    expect(preflight({ ...substantial, diverseChallengers: true }).independence).toBe("diverse");
  });

  it("falls back to separate fresh contexts where they do not", () => {
    expect(preflight({ ...substantial, diverseChallengers: false }).independence).toBe(
      "fresh-context",
    );
  });
});

describe("the preflight comment", () => {
  const trivial = {
    materiality: "mechanical",
    uncertainty: "low",
    blastRadius: "local",
    reversibility: "easy",
  };

  it("is not required when a trivial self-check found nothing", () => {
    expect(preflight(trivial).comment).toBe(false);
  });

  it("is required when a trivial self-check did find something", () => {
    expect(preflight({ ...trivial, findings: true }).comment).toBe(true);
  });

  it("is required, findings or not, wherever a challenger ran", () => {
    for (const axes of EVERY_COMBINATION) {
      if (CHALLENGERS[classify(axes)] === 0) continue;
      expect(preflight({ ...axes, findings: false }).comment, JSON.stringify(axes)).toBe(true);
    }
  });
});

describe("lifecycle", () => {
  const bounded = {
    materiality: "behavioral",
    uncertainty: "low",
    blastRadius: "local",
    reversibility: "easy",
  };

  it("claims and dispatches an issue that is still eligible at the recheck", () => {
    expect(preflight({ ...bounded, stillEligible: true })).toMatchObject({
      outcome: "dispatch",
      claim: true,
      labels: { add: ["in-progress"], remove: [] },
    });
  });

  it("returns an evidence-correctable stale contract to coordination", () => {
    expect(preflight({ ...bounded, blocker: "stale-spec" })).toMatchObject({
      outcome: "return-to-coordination",
      claim: false,
      labels: { add: [], remove: ["ready"] },
      comment: true,
    });
  });

  it("parks a genuine owner decision as needs-decision", () => {
    expect(preflight({ ...bounded, blocker: "product-decision" })).toMatchObject({
      outcome: "park-needs-decision",
      claim: false,
      labels: { add: ["needs-decision"], remove: ["ready"] },
      comment: true,
    });
  });

  it("requeues silently when the recheck finds the issue claimed or ineligible", () => {
    expect(preflight({ ...bounded, stillEligible: false })).toMatchObject({
      outcome: "requeue",
      claim: false,
      labels: { add: [], remove: [] },
      comment: false,
    });
  });

  it("never leaves an in-progress claim on a path that did not dispatch", () => {
    for (const axes of EVERY_COMBINATION) {
      for (const blocker of ["none", "stale-spec", "product-decision"]) {
        for (const stillEligible of [true, false]) {
          const plan = preflight({ ...axes, blocker, stillEligible });
          const where = JSON.stringify({ ...axes, blocker, stillEligible });
          expect(OUTCOMES, where).toContain(plan.outcome);
          expect(plan.claim, where).toBe(plan.outcome === "dispatch");
          expect(plan.labels.add.includes("in-progress"), where).toBe(plan.claim);
        }
      }
    }
  });
});
