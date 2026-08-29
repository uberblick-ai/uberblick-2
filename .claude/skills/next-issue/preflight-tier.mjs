/**
 * The `next-issue` preflight decision table, in executable form.
 *
 * `preflight.md` next to this file renders the same table for the issue
 * adversary that owns it; this file is the table a test can run. The two are
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
/**
 * What the preflight found that stops a dispatch, if anything — exported for
 * the same reason `AXES` is: a test should enumerate the vocabulary, not
 * retype it.
 */
export const BLOCKERS = ["none", "stale-spec", "product-decision"];

const BOOLEANS = [true, false];

/**
 * The four axes the tier is a function of, and nothing else — exported so a
 * test can enumerate the space without re-declaring the vocabulary here.
 */
export const AXES = {
  materiality: MATERIALITY,
  uncertainty: UNCERTAINTY,
  blastRadius: BLAST_RADIUS,
  reversibility: REVERSIBILITY,
};

/** Lifecycle signals: what the preflight found, and what the recheck saw. */
const LIFECYCLE = {
  blocker: BLOCKERS,
  /** Did the self-check or a challenger surface anything material? */
  findings: BOOLEANS,
  /** The recheck immediately before the outcome: still `ready`, still unclaimed. */
  stillEligible: BOOLEANS,
  /** Are challengers of differing model family, harness or approach available? */
  diverseChallengers: BOOLEANS,
};

/** Ordered weakest to strongest; `uncertainty: "high"` moves one step along it. */
export const TIERS = ["trivial", "bounded", "substantial"];

/** How many independent challengers each tier runs before implementation. */
export const CHALLENGERS = { trivial: 0, bounded: 1, substantial: 2 };

/** Every way a preflight can end. Only `dispatch` leads to a claim. */
export const OUTCOMES = [
  "dispatch",
  "return-to-coordination",
  "park-needs-decision",
  "requeue",
];

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
        `preflight: unknown signal "${key}". The table routes on ${known.join(", ")} and nothing else — a package name, a label or a keyword never moves a tier.`,
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
 * The risk tier, from the four axes alone.
 *
 * Substantial when the change decides architecture or a public contract, when
 * it reaches beyond its own module, or when it is hard to undo. Bounded when
 * it is real behavior with established patterns and contained, reversible
 * impact. Trivial only when it is mechanical, local, easy to undo *and*
 * understood. Uncertainty then biases one step upward, which is what routes a
 * genuinely ambiguous change to two challengers rather than one.
 *
 * @param {{materiality: string, uncertainty: string, blastRadius: string, reversibility: string}} axes
 * @returns {"trivial" | "bounded" | "substantial"}
 */
export function classify(axes) {
  validate(axes, AXES, Object.keys(AXES));
  const base =
    axes.materiality === "architectural" ||
    axes.blastRadius === "wide" ||
    axes.reversibility === "hard"
      ? "substantial"
      : axes.materiality === "behavioral"
        ? "bounded"
        : "trivial";
  if (axes.uncertainty !== "high") return base;
  return TIERS[Math.min(TIERS.indexOf(base) + 1, TIERS.length - 1)];
}

/**
 * The whole preflight decision: how hard to challenge, and what happens next.
 *
 * The claim is never this role's: the preflight leaves the issue unclaimed
 * whatever it decides, which is why it can stop at any point without stranding
 * an `in-progress` label on an issue nobody is working. After a *dispatch*
 * verdict the implementer claims at its own pickup.
 *
 * @param {{
 *   materiality: string, uncertainty: string, blastRadius: string, reversibility: string,
 *   blocker?: string, findings?: boolean, stillEligible?: boolean, diverseChallengers?: boolean,
 * }} signals
 */
export function preflight(signals) {
  validate(signals, { ...AXES, ...LIFECYCLE }, Object.keys(AXES));
  const {
    blocker = "none",
    findings = false,
    stillEligible = true,
    diverseChallengers = false,
  } = signals;

  const tier = classify({
    materiality: signals.materiality,
    uncertainty: signals.uncertainty,
    blastRadius: signals.blastRadius,
    reversibility: signals.reversibility,
  });
  const challengers = CHALLENGERS[tier];
  const independence =
    challengers === 0
      ? "none"
      : challengers === 2 && diverseChallengers
        ? "diverse"
        : // Two fresh contexts satisfy independence when diversity is not on
          // offer; the fallback is stated so it is a choice, not a silent gap.
          "fresh-context";

  /**
   * @param {string} outcome
   * @param {{add?: string[], remove?: string[], comment: boolean}} lifecycle
   */
  const plan = (outcome, { add = [], remove = [], comment }) => ({
    tier,
    challengers,
    independence,
    outcome,
    claim: outcome === "dispatch",
    labels: { add, remove },
    comment,
  });

  // The recheck outranks every finding. Someone else claimed the issue, or it
  // stopped being eligible, while this preflight ran: it is their work now, and
  // stripping `ready` or commenting on it would be acting on live work from the
  // outside. Take the findings to the claim holder or to a fresh pickup instead.
  if (!stillEligible) return plan("requeue", { comment: false });

  if (blocker === "product-decision") {
    return plan("park-needs-decision", {
      add: ["needs-decision"],
      remove: ["ready"],
      comment: true,
    });
  }
  if (blocker === "stale-spec") {
    return plan("return-to-coordination", { remove: ["ready"], comment: true });
  }

  // `in-progress` is written by the implementer's own claim at its pickup, not
  // here. It is named as this outcome's label because dispatch is the only
  // outcome an implementer claim can follow — the invariant worth checking.
  return plan("dispatch", {
    add: ["in-progress"],
    comment: challengers > 0 || findings,
  });
}
