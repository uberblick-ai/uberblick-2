/** Executable preparation policy, not runtime scheduling or issue grammar.
 * Grounded signals exclude paths, labels and keywords. See the adjacent protocol.
 */
/** The final contract state after the preparer has dispositioned the pass. */
export const FINDING_STATES = ["none", "correctable-applied", "owner-boundary", "split"];

const BOOLEANS = [true, false];

/** Evidence judgments, not an extra intake questionnaire. */
export const AXES = {
  intentSettled: BOOLEANS,
  approachKnown: BOOLEANS,
  materialRisk: BOOLEANS,
};

/** Lifecycle signals: final finding state and ownership at the recheck. */
const LIFECYCLE = {
  findingState: FINDING_STATES,
  /** Does the parent preparer still hold the issue? */
  parentOwnsIssue: BOOLEANS,
};

export const ROUTES = ["self-check", "challenged"];

/** How many adversary subagents each route runs. */
export const ADVERSARIES = { "self-check": 0, challenged: 1 };

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
 * @param {{intentSettled: boolean, approachKnown: boolean, materialRisk: boolean}} axes
 * @returns {"self-check" | "challenged"}
 */
export function classify(axes) {
  validate(axes, AXES, Object.keys(AXES));
  return axes.intentSettled && axes.approachKnown && !axes.materialRisk
    ? "self-check"
    : "challenged";
}

/**
 * The preparer's final one-pass decision after it has applied correctable
 * findings and rechecked its ownership.
 *
 * @param {{
 *   intentSettled: boolean, approachKnown: boolean, materialRisk: boolean,
 *   findingState?: string, parentOwnsIssue?: boolean,
 * }} signals
 */
export function preflight(signals) {
  validate(signals, { ...AXES, ...LIFECYCLE }, Object.keys(AXES));
  const { findingState = "none", parentOwnsIssue = true } = signals;
  const route = classify({
    intentSettled: signals.intentSettled,
    approachKnown: signals.approachKnown,
    materialRisk: signals.materialRisk,
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
      add: ["umbrella"],
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
