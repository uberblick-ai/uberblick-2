/**
 * Drift guard for the one-pass preparation policy. The prose tables in
 * `preflight.md` and the executable specification beside this file must route
 * the same cases: trivial gets no adversary, everything else gets exactly one,
 * correctable findings stay in the preparer pass, and owner boundaries park.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AXES, FINDING_STATES, classify, preflight } from "./preflight-tier.mjs";

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const PREFLIGHT = readFileSync(join(SKILL_DIR, "preflight.md"), "utf8");

function everyCombination() {
  let all = [{}];
  for (const [axis, values] of Object.entries(AXES)) {
    all = all.flatMap((partial) => values.map((value) => ({ ...partial, [axis]: value })));
  }
  return all;
}

function markdownTable(...columns) {
  const lines = PREFLIGHT.split("\n");
  const header = lines.findIndex((line) => columns.every((column) => line.includes(column)));
  if (header === -1)
    throw new Error(`preflight.md has no table with columns ${columns.join(", ")}`);

  const rows = [];
  for (const line of lines.slice(header + 2)) {
    const text = line.trim();
    if (!text.startsWith("|")) break;
    rows.push(text.split("|").slice(1, -1).map((cell) => cell.trim()));
  }
  if (rows.length === 0) throw new Error(`table ${columns.join(", ")} has no rows`);
  return rows;
}

function labelsFrom(cell) {
  const labels = { add: [], remove: [] };
  for (const [, verb, label] of cell.matchAll(/\b(add|remove) `([a-z-]+)`/g)) {
    labels[verb].push(label);
  }
  return labels;
}

describe("one-pass issue preparation", () => {
  it("documents only the zero- and one-adversary routes", () => {
    const rows = markdownTable("| Route |", "| Grounded condition |", "| Adversaries |");
    assert.deepEqual(
      rows.map(([route, , adversaries]) => [route.match(/`([^`]+)`/)?.[1], Number(adversaries)]),
      [
        ["trivial", 0],
        ["challenged", 1],
      ],
    );
  });

  it("routes only the fully grounded mechanical case around the adversary", () => {
    for (const axes of everyCombination()) {
      const trivial =
        axes.materiality === "mechanical" &&
        axes.uncertainty === "low" &&
        axes.blastRadius === "local" &&
        axes.reversibility === "easy";
      const expectedRoute = trivial ? "trivial" : "challenged";
      const plan = preflight(axes);
      assert.equal(classify(axes), expectedRoute, JSON.stringify(axes));
      assert.equal(plan.route, expectedRoute, JSON.stringify(axes));
      assert.equal(plan.adversaries, trivial ? 0 : 1, JSON.stringify(axes));
    }
  });

  it("routes every documented final outcome at every risk shape", () => {
    const rows = markdownTable(
      "| Parent still owns the issue |",
      "| Final finding state |",
      "| Outcome |",
    );
    for (const [owns, found, outcome, labels, comment] of rows) {
      const token = found.match(/`([a-z-]+)`/)?.[1];
      if (token === undefined) throw new Error(`outcome row names no finding state: ${found}`);
      const states = token === "any" ? FINDING_STATES : [token];
      for (const findingState of states) {
        for (const axes of everyCombination()) {
          const signals = { ...axes, findingState, parentOwnsIssue: owns === "yes" };
          const plan = preflight(signals);
          assert.equal(plan.outcome, outcome, JSON.stringify(signals));
          assert.deepEqual(plan.labels, labelsFrom(labels), JSON.stringify(signals));
          assert.equal(plan.comment, comment === "yes", JSON.stringify(signals));
        }
      }
    }
  });

  it("keeps correctable findings in one challenged preparer pass", () => {
    const plan = preflight({
      materiality: "behavioral",
      uncertainty: "low",
      blastRadius: "local",
      reversibility: "easy",
      findingState: "correctable-applied",
    });
    assert.equal(plan.route, "challenged");
    assert.equal(plan.adversaries, 1);
    assert.equal(plan.outcome, "ready");
    assert.deepEqual(plan.labels, { add: ["ready"], remove: ["needs-preparation"] });
  });

  it("parks an owner boundary without buying another adversary", () => {
    const plan = preflight({
      materiality: "architectural",
      uncertainty: "high",
      blastRadius: "wide",
      reversibility: "hard",
      findingState: "owner-boundary",
    });
    assert.equal(plan.adversaries, 1);
    assert.equal(plan.outcome, "park-needs-decision");
    assert.deepEqual(plan.labels, {
      add: ["needs-decision"],
      remove: ["needs-preparation", "ready"],
    });
  });

  it("turns an oversized request into a coordination parent without dispatching it", () => {
    const plan = preflight({
      materiality: "behavioral",
      uncertainty: "low",
      blastRadius: "wide",
      reversibility: "easy",
      findingState: "split",
    });
    assert.equal(plan.adversaries, 1);
    assert.equal(plan.outcome, "split");
    assert.deepEqual(plan.labels, {
      add: [],
      remove: ["needs-preparation", "ready"],
    });
  });

  it("does not route on package names, labels or keywords", () => {
    const mechanical = {
      materiality: "mechanical",
      uncertainty: "low",
      blastRadius: "local",
      reversibility: "easy",
    };
    assert.throws(() => classify({ ...mechanical, touches: ["schema"] }), /unknown signal/);
    assert.equal(classify(mechanical), "trivial");
  });

  it("lets a lost parent claim outrank every finding", () => {
    const plan = preflight({
      materiality: "behavioral",
      uncertainty: "low",
      blastRadius: "local",
      reversibility: "easy",
      findingState: "owner-boundary",
      parentOwnsIssue: false,
    });
    assert.equal(plan.outcome, "requeue");
    assert.deepEqual(plan.labels, { add: [], remove: [] });
    assert.equal(plan.comment, false);
  });
});
