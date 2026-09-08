/**
 * How many independent implementation reviews one candidate owes, in
 * executable form.
 *
 * `delivery-policy.md`'s "Reviews owed" table renders the same rule for the
 * roles that follow it; this file is the table a test can run.
 * `review-rounds.test.mjs` beside them holds the two in parity, so the count a
 * role dispatches and the rule this repository claims cannot drift apart —
 * which is the only reason an executable copy earns its place.
 *
 * Nothing imports this at runtime. It is not dispatch machinery; it is the
 * machinery's specification. Who claims a request, at which head and on which
 * runtime stays in `review-protocol.md` and the role contracts, which own it.
 *
 * The signal set is closed on purpose. Package names, paths and line counts are
 * not inputs — a signal object carrying one throws. Delivery policy already
 * says paths identify what to inspect and never fire a tier or a round by
 * themselves; a diff is exempt because it provably preserves production
 * behavior, never because of where it landed.
 */

/** What the diff is, established by reading it rather than its paths. */
const SHAPE = ["test-only", "docs-only", "mechanical", "behavioral"];
/** Does focused validation directly prove the contract the diff touches? */
const BOOLEANS = [true, false];
/**
 * The boundaries delivery-policy.md lists as requiring both perspectives.
 * `none` means the diff crosses none of them.
 */
const BOUNDARY = [
  "none",
  "schema-meaning",
  "persistence",
  "synchronization",
  "concurrency",
  "auth",
  "runtime-dependency",
  "decided-architecture",
];

/** The five signals the count is a function of, and nothing else. */
export const AXES = {
  shape: SHAPE,
  focusedValidationProvesContract: BOOLEANS,
  /** An agent-authored process change, whose challenge AGENTS.md requires. */
  processChange: BOOLEANS,
  boundary: BOUNDARY,
  /** A concrete unresolved risk the implementer or integrator named. */
  namedConcreteRisk: BOOLEANS,
};

export const CONDITIONS = ["boundary", "exempt", "otherwise"];

/** Each owed round, in the order it is requested. */
const ROUNDS = {
  boundary: [
    { requester: "implementer", runtime: "other" },
    { requester: "integrator", runtime: "author" },
  ],
  exempt: [],
  otherwise: [{ requester: "implementer", runtime: "other" }],
};

/** @param {unknown} signals */
function validate(signals) {
  if (typeof signals !== "object" || signals === null || Array.isArray(signals))
    throw new Error("reviews owed: signals must be an object");
  const known = Object.keys(AXES);
  for (const key of Object.keys(signals))
    if (!known.includes(key))
      throw new Error(
        `reviews owed: unknown signal "${key}". The table counts on ${known.join(", ")} and nothing else — a package name, path or line count never buys or waives a round.`,
      );
  for (const key of known) {
    if (!(key in signals)) throw new Error(`reviews owed: missing signal "${key}"`);
    if (!AXES[key].includes(signals[key]))
      throw new Error(
        `reviews owed: signal "${key}" must be one of ${AXES[key].map((value) => JSON.stringify(value)).join(", ")}, got ${JSON.stringify(signals[key])}`,
      );
  }
}

/**
 * A listed boundary or a named concrete risk buys both perspectives, and does
 * so before the exemption is considered, so no diff is waived out of a boundary
 * it crosses. Otherwise a diff that preserves production behavior and is
 * directly proven by focused validation owes nothing — except the
 * process-change challenge AGENTS.md requires, which survives that exemption.
 *
 * @param {{shape: string, focusedValidationProvesContract: boolean, processChange: boolean, boundary: string, namedConcreteRisk: boolean}} signals
 * @returns {"boundary" | "exempt" | "otherwise"}
 */
export function classify(signals) {
  validate(signals);
  if (signals.boundary !== "none" || signals.namedConcreteRisk) return "boundary";
  return signals.shape !== "behavioral" &&
    signals.focusedValidationProvesContract &&
    !signals.processChange
    ? "exempt"
    : "otherwise";
}

/**
 * The rounds one candidate owes: which condition fired, how many reviews, and
 * who requests each on which runtime relative to the diff's author.
 *
 * @param {Parameters<typeof classify>[0]} signals
 */
export function reviewsOwed(signals) {
  const condition = classify(signals);
  const rounds = ROUNDS[condition];
  return { condition, owed: rounds.length, rounds: rounds.map((round) => ({ ...round })) };
}
