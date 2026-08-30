/**
 * The `next-issue` preflight decision table, in executable form.
 *
 * `preflight.md` next to this file renders the same table for the issue
 * preparer that owns it; this file is the table a test can run. The two are
 * checked against each other in `preflight-tier.test.mjs` beside them, so the
 * procedure that role follows and the routing this repository claims cannot
 * drift apart — which is the only reason an executable copy earns its place.
 *
 * Nothing imports this at runtime. It is not loop machinery; it is the
 * machinery's specification. No dependencies, no scheduling: order,
 * eligibility and conflict analysis stay in `.github/ISSUE_SPEC.md`, which
 * owns them.
 *
 * The signal set is closed on purpose. `Touches`, labels, package names and
 * keywords are not inputs — a signal object carrying one throws. Escalation
 * comes from what the grounding read found, so a change proven mechanical is
 * trivial even in a sensitive package, and an innocuous-looking change whose
 * outcome nobody can state is not.
 */

/** What the change actually decides, per the grounding read. */
const MATERIALITY = ["mechanical", "behavioral", "architectural"];
/** `high` when the grounding read left the outcome or its invariants unstated. */
const UNCERTAINTY = ["low", "high"];
/** `wide` for cross-package or cross-repository contracts, or broad/ambiguous scope. */
const BLAST_RADIUS = ["local", "wide"];
/** `hard` when the choice is expensive to undo once merged. */
const REVERSIBILITY = ["easy", "hard"];
/** The final contract state after the preparer has dispositioned the pass. */
export const FINDING_STATES = ["none", "correctable-applied", "owner-boundary", "split"];

const BOOLEANS = [true, false];

/**
 * The four axes the route is a function of, and nothing else — exported so a
 * test can enumerate the space without re-declaring the vocabulary here.
 */
export const AXES = {
  materiality: MATERIALITY,
  uncertainty: UNCERTAINTY,
  blastRadius: BLAST_RADIUS,
  reversibility: REVERSIBILITY,
};

/** Lifecycle signals: final finding state and ownership at the recheck. */
const LIFECYCLE = {
  findingState: FINDING_STATES,
  /** Does the parent preparer still hold the issue? */
  parentOwnsIssue: BOOLEANS,
};

export const ROUTES = ["trivial", "challenged"];

/** How many adversary subagents each route runs. */
export const ADVERSARIES = { trivial: 0, challenged: 1 };

/** Every way the preparer's one pass can end. */
export const OUTCOMES = ["ready", "park-needs-decision", "split", "requeue"];

/**
 * @param {unknown} signals
 * @param {Record<string, readonly unknown[]>} schema
 * @param {readonly string[]} required
 */
function validate(signals, schema, required) {
  if (typeof signals !== "object" || signals === null || Array.isArray(signals)) {
    throw new Error("preflight: signals must be an object");
  }
  const known = Object.keys(schema);
  for (const key of Object.keys(signals)) {
    if (!known.includes(key)) {
      throw new Error(
        `preflight: unknown signal "${key}". The table routes on ${known.join(", ")} and nothing else — a package name, label or keyword never changes the route.`,
      );
    }
  }
  for (const key of required) {
    if (!(key in signals)) throw new Error(`preflight: missing signal "${key}"`);
  }
  for (const [key, value] of Object.entries(signals)) {
    if (!schema[key].includes(value)) {
      throw new Error(
        `preflight: signal "${key}" must be one of ${schema[key].map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(value)}`,
      );
    }
  }
}

/**
 * Trivial only when the grounded change is mechanical, understood, local and
 * easy to undo. Every other combination receives one adversary.
 *
 * @param {{materiality: string, uncertainty: string, blastRadius: string, reversibility: string}} axes
 * @returns {"trivial" | "challenged"}
 */
export function classify(axes) {
  validate(axes, AXES, Object.keys(AXES));
  return axes.materiality === "mechanical" &&
    axes.uncertainty === "low" &&
    axes.blastRadius === "local" &&
    axes.reversibility === "easy"
    ? "trivial"
    : "challenged";
}

/**
 * The preparer's final one-pass decision after it has applied correctable
 * findings and rechecked its ownership.
 *
 * @param {{
 *   materiality: string, uncertainty: string, blastRadius: string, reversibility: string,
 *   findingState?: string, parentOwnsIssue?: boolean,
 * }} signals
 */
export function preflight(signals) {
  validate(signals, { ...AXES, ...LIFECYCLE }, Object.keys(AXES));
  const { findingState = "none", parentOwnsIssue = true } = signals;
  const route = classify({
    materiality: signals.materiality,
    uncertainty: signals.uncertainty,
    blastRadius: signals.blastRadius,
    reversibility: signals.reversibility,
  });
  const adversaries = ADVERSARIES[route];

  /**
   * @param {string} outcome
   * @param {{add?: string[], remove?: string[], comment: boolean}} lifecycle
   */
  const plan = (outcome, { add = [], remove = [], comment }) => ({
    route,
    adversaries,
    independence: adversaries === 0 ? "self-check" : "fresh-cross-runtime-preferred",
    outcome,
    labels: { add, remove },
    comment,
  });

  if (!parentOwnsIssue) return plan("requeue", { comment: false });
  if (findingState === "owner-boundary") {
    return plan("park-needs-decision", {
      add: ["needs-decision"],
      remove: ["needs-preparation", "ready"],
      comment: true,
    });
  }
  if (findingState === "split") {
    return plan("split", {
      remove: ["needs-preparation", "ready"],
      comment: true,
    });
  }
  return plan("ready", {
    add: ["ready"],
    remove: ["needs-preparation"],
    comment: true,
  });
}
