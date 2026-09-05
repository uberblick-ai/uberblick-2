// Preparation route boundaries and ownership/finding lifecycle parity.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AXES, FINDING_STATES, classify, preflight } from "./issue-preparation.mjs";

const PROTOCOL_DIR = dirname(fileURLToPath(import.meta.url));
const PREPARATION = readFileSync(join(PROTOCOL_DIR, "issue-preparation.md"), "utf8");

function everyCombination() {
  let all = [{}];
  for (const [axis, values] of Object.entries(AXES)) {
    all = all.flatMap((partial) => values.map((value) => ({ ...partial, [axis]: value })));
  }
  return all;
}

function markdownTable(...columns) {
  const lines = PREPARATION.split("\n");
  const header = lines.findIndex((line) => columns.every((column) => line.includes(column)));
  if (header === -1)
    throw new Error(`issue-preparation.md has no table with columns ${columns.join(", ")}`);

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
        ["self-check", 0],
        ["challenged", 1],
      ],
    );
  });

  it("self-checks settled intent with a known approach and no material risk", () => {
    assert.equal(classify({ intentSettled: true, approachKnown: true, materialRisk: false }), "self-check");
  });

  it("challenges unsettled intent, an uncertain approach, or consequential risk", () => {
    for (const axes of everyCombination()) {
      const expected = axes.intentSettled && axes.approachKnown && !axes.materialRisk
        ? "self-check" : "challenged";
      assert.equal(classify(axes), expected);
      assert.equal(preflight(axes).adversaries, expected === "self-check" ? 0 : 1);
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
      intentSettled: true,
      approachKnown: true,
      materialRisk: true,
      findingState: "correctable-applied",
    });
    assert.equal(plan.route, "challenged");
    assert.equal(plan.adversaries, 1);
    assert.equal(plan.outcome, "ready");
    assert.deepEqual(plan.labels, { add: ["ready"], remove: ["needs-preparation"] });
  });

  it("parks an owner boundary without buying another adversary", () => {
    const plan = preflight({
      intentSettled: true,
      approachKnown: true,
      materialRisk: true,
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
      intentSettled: true,
      approachKnown: true,
      materialRisk: true,
      findingState: "split",
    });
    assert.equal(plan.adversaries, 1);
    assert.equal(plan.outcome, "split");
    assert.deepEqual(plan.labels, {
      add: ["umbrella"],
      remove: ["needs-preparation", "ready"],
    });
  });

  it("does not route on package names, labels or keywords", () => {
    const grounded = {
      intentSettled: true,
      approachKnown: true,
      materialRisk: false,
    };
    assert.throws(() => classify({ ...grounded, touches: ["schema"] }), /unknown signal/);
    assert.throws(() => classify({ ...grounded, label: "spike" }), /unknown signal/);
    assert.throws(() => classify({ ...grounded, intentSettled: "yes" }), /must be one of/);
    assert.throws(() => classify({ intentSettled: true }), /missing signal/);
    assert.equal(classify(grounded), "self-check");
  });

  it("lets a lost parent claim outrank every finding", () => {
    const plan = preflight({
      intentSettled: true,
      approachKnown: true,
      materialRisk: true,
      findingState: "owner-boundary",
      parentOwnsIssue: false,
    });
    assert.equal(plan.outcome, "requeue");
    assert.deepEqual(plan.labels, { add: [], remove: [] });
    assert.equal(plan.comment, false);
  });
});
