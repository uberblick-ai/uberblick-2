/**
 * Drift guard for how many independent reviews a candidate owes. The
 * "Reviews owed" table in `delivery-policy.md` and the executable
 * specification beside this file must count the same cases: two for a listed
 * boundary or a named concrete risk, none for a proven-harmless diff, and one
 * for everything else — including the agent-authored process change that
 * survives the exemption.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AXES, CONDITIONS, classify, reviewsOwed } from "./review-rounds.mjs";

const PROTOCOL_DIR = dirname(fileURLToPath(import.meta.url));
const POLICY = readFileSync(join(PROTOCOL_DIR, "delivery-policy.md"), "utf8");

function everyCombination() {
  let all = [{}];
  for (const [axis, values] of Object.entries(AXES)) {
    all = all.flatMap((partial) => values.map((value) => ({ ...partial, [axis]: value })));
  }
  return all;
}

function markdownTable(...columns) {
  const lines = POLICY.split("\n");
  const header = lines.findIndex((line) => columns.every((column) => line.includes(column)));
  if (header === -1)
    throw new Error(`delivery-policy.md has no table with columns ${columns.join(", ")}`);

  const rows = [];
  for (const line of lines.slice(header + 2)) {
    const text = line.trim();
    if (!text.startsWith("|")) break;
    rows.push(text.split("|").slice(1, -1).map((cell) => cell.trim()));
  }
  if (rows.length === 0) throw new Error(`table ${columns.join(", ")} has no rows`);
  return rows;
}

/** `implementer` on the other runtime, then `integrator` on the author's runtime. */
function roundsFrom(cell) {
  return [...cell.matchAll(/`(implementer|integrator)` on the (other|author's) runtime/g)].map(
    ([, requester, runtime]) => ({ requester, runtime: runtime === "other" ? "other" : "author" }),
  );
}

/** The one shape the exemption covers, restated rather than imported. */
function expectedCondition(signals) {
  if (signals.boundary !== "none" || signals.namedConcreteRisk) return "boundary";
  if (signals.shape === "behavioral") return "otherwise";
  if (!signals.focusedValidationProvesContract) return "otherwise";
  return signals.processChange ? "otherwise" : "exempt";
}

const TABLE = markdownTable("| Condition |", "| Reviews owed |", "| Who requests each |");

describe("reviews owed", () => {
  it("documents exactly the conditions the specification knows", () => {
    assert.deepEqual(
      TABLE.map(([condition]) => condition.match(/`([a-z]+)`/)?.[1]),
      CONDITIONS,
    );
  });

  it("counts every risk shape the way the table does", () => {
    const table = new Map(
      TABLE.map(([condition, owed, who]) => [
        condition.match(/`([a-z]+)`/)?.[1],
        { owed: Number(owed), rounds: roundsFrom(who) },
      ]),
    );
    for (const signals of everyCombination()) {
      const condition = expectedCondition(signals);
      const documented = table.get(condition);
      const plan = reviewsOwed(signals);
      assert.equal(classify(signals), condition, JSON.stringify(signals));
      assert.equal(plan.condition, condition, JSON.stringify(signals));
      assert.equal(plan.owed, documented.owed, JSON.stringify(signals));
      assert.deepEqual(plan.rounds, documented.rounds, JSON.stringify(signals));
      assert.equal(plan.owed, plan.rounds.length, JSON.stringify(signals));
    }
  });

  it("keeps the process-change challenge the exemption cannot waive", () => {
    const docsOnly = {
      shape: "docs-only",
      focusedValidationProvesContract: true,
      processChange: false,
      boundary: "none",
      namedConcreteRisk: false,
    };
    assert.equal(reviewsOwed(docsOnly).owed, 0);
    const processChange = reviewsOwed({ ...docsOnly, processChange: true });
    assert.equal(processChange.owed, 1);
    assert.deepEqual(processChange.rounds, [{ requester: "implementer", runtime: "other" }]);
  });

  it("never waives a diff out of a boundary it crosses", () => {
    for (const boundary of AXES.boundary.filter((value) => value !== "none")) {
      const plan = reviewsOwed({
        shape: "mechanical",
        focusedValidationProvesContract: true,
        processChange: false,
        boundary,
        namedConcreteRisk: false,
      });
      assert.equal(plan.condition, "boundary", boundary);
      assert.deepEqual(plan.rounds, [
        { requester: "implementer", runtime: "other" },
        { requester: "integrator", runtime: "author" },
      ]);
    }
    assert.equal(
      reviewsOwed({
        shape: "test-only",
        focusedValidationProvesContract: true,
        processChange: false,
        boundary: "none",
        namedConcreteRisk: true,
      }).owed,
      2,
    );
  });

  it("does not count on paths, packages or line counts", () => {
    const behavioral = {
      shape: "behavioral",
      focusedValidationProvesContract: false,
      processChange: false,
      boundary: "none",
      namedConcreteRisk: false,
    };
    assert.throws(() => classify({ ...behavioral, touches: ["schema"] }), /unknown signal/);
    assert.throws(() => classify({ ...behavioral, shape: "large" }), /must be one of/);
    const { shape, ...missing } = behavioral;
    assert.throws(() => classify(missing), /missing signal "shape"/);
    assert.equal(classify(behavioral), "otherwise");
  });
});
