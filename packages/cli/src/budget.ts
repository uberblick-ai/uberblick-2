/**
 * A ceiling on the deadlines `ub` waits out, so a test can choose its own.
 *
 * Several `ub` commands are honest about failure only by *reaching* a deadline:
 * a hub that accepts a socket and then never serves the room is indistinguishable
 * from a slow one until the budget runs out. The budgets are therefore sized for
 * a person on a tethered laptop — up to five seconds to connect a bridge, fifteen
 * to sync it — and a suite that exercises those refusals sits out every second of
 * them, several times per file.
 *
 * `UB_TEST_MAX_WAIT_MS` caps them. It is a **ceiling, never a floor**: an unset
 * or unusable value changes nothing, and a value longer than a product default
 * cannot lengthen it. So no default in this package moves, and a run without the
 * variable is byte-for-byte the run it always was. The variable is documented
 * surface, not an internal-only seam: README's "The `ub` command line" section
 * names it and this contract.
 *
 * **Which deadlines it may cap, and which it must not.** What it caps are four
 * probes of something remote: the two hub budgets below, `open.ts`'s 1 s
 * port-owner probe and `probes.ts`'s 2 s clock observation. Expiry is a
 * permitted answer for each of them, but not a free one — `whoHoldsPort` reads a
 * timeout as `foreign`, `probeHubClock` reads one as no observation at all, and
 * `ub doctor` reports a hub that missed its budget as down. What makes them safe
 * to cap is a **margin, not a category**: each waits on something that answers
 * in milliseconds when it answers at all, against the hundreds a suite sets
 * (`test/helpers.ts` uses 400). Take the ceiling far enough below that and a
 * green check goes red against a hub that is up.
 *
 * What it must not cap at any value is a deadline whose holder deliberately
 * holds it for longer than a suite's ceiling: shortening that turns a success
 * into a failure instead of reaching an answer sooner. `init-lock.ts`'s
 * `WAIT_TIMEOUT_MS` waits for a live sibling `ub init` to finish writing, and
 * the suite's own cases hold that lock for half a second (`test/open.test.ts`),
 * so it is deliberately left uncapped and `test/init-lock.test.ts` holds that
 * line. Capping it made `ub open` give up on a lock a test was still
 * legitimately holding, on a fast machine only (#524).
 *
 * **Why an environment variable rather than an option.** The suites that pay
 * this cost spawn `ub` as a real process — that is the contract they defend —
 * and a function argument does not cross a process boundary. `init-lock.ts`
 * already has an in-process `waitMs` option for exactly one caller, and that is
 * precisely why it could not help here.
 *
 * **Why the ceiling lives on this side of the `McpConfig` boundary.** The two
 * hub budgets are constants in `packages/mcp-server` — `resolveMcpConfig`'s
 * 1 500 / 3 000 ms and `bridgeConfig`'s 5 000 / 15 000 ms — and neither is
 * environment-driven there. The CLI already overrides `McpConfig` fields per
 * call, so capping them is a CLI concern, and the MCP server's own defaults stay
 * exactly where they are.
 *
 * **What this module does not see.** `remote-init.ts` budgets a hub's first
 * answer at `REACH_BUDGET_MS = 90_000` and gives each of its two HTTP probes
 * 10 s; none of the three passes through here. No suite waits any of them out,
 * so none needs to — but this module is an account of the deadlines that were
 * costing the suite time, not of every deadline the CLI owns.
 *
 * The two `McpConfig` builders are re-exported here rather than wrapped at each
 * of their call sites, so within `packages/cli` `./budget.js` is where
 * `resolveMcpConfig` and `bridgeConfig` come from. That is a convention the
 * import graph currently keeps, not a guard: nothing stops a new caller reaching
 * for the uncapped pair in `@uberblick/mcp-server` directly.
 */

import {
  type McpConfig,
  bridgeConfig as uncappedBridgeConfig,
  resolveMcpConfig as uncappedResolveMcpConfig,
} from "@uberblick/mcp-server";

/** The one name; deliberately unmistakable for a knob a user would reach for. */
const CEILING_VARIABLE = "UB_TEST_MAX_WAIT_MS";

function ceiling(env: NodeJS.ProcessEnv): number | null {
  const raw = env[CEILING_VARIABLE]?.trim();
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  // Anything that is not a positive finite number is ignored rather than
  // guessed at: a typo must not silently pin every deadline at zero.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * `ms`, or the ceiling if one is set and shorter.
 *
 * `env` defaults to this process's own, which is what both call sites want: they
 * run inside a spawned `ub` and have no other map in hand. It is a parameter all
 * the same, so an in-process caller caps against the environment it resolved
 * from rather than silently against this one — the asymmetry that let a
 * caller-supplied ceiling be ignored one call later in {@link bridgeConfig}.
 */
export function budget(ms: number, env: NodeJS.ProcessEnv = process.env): number {
  const cap = ceiling(env);
  return cap === null ? ms : Math.min(ms, cap);
}

/** The same configuration with its two hub deadlines capped. */
function capped(config: McpConfig, env: NodeJS.ProcessEnv): McpConfig {
  const cap = ceiling(env);
  if (cap === null) return config;
  return {
    ...config,
    connectTimeoutMs: Math.min(config.connectTimeoutMs, cap),
    syncTimeoutMs: Math.min(config.syncTimeoutMs, cap),
  };
}

/** {@link uncappedResolveMcpConfig}, with the ceiling applied. */
export function resolveMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  return capped(uncappedResolveMcpConfig(env), env);
}

/**
 * {@link uncappedBridgeConfig}, with the ceiling applied.
 *
 * The bridge builder replaces both deadlines with its own longer ones, so the
 * cap has to be applied again afterwards — and from the environment that
 * produced `config`, which is why `env` sits second and is not optional.
 * Defaulting it to `process.env` is what let a caller-supplied ceiling cap
 * `resolveMcpConfig` and then be silently ignored one call later.
 */
export function bridgeConfig(
  config: McpConfig,
  env: NodeJS.ProcessEnv,
  overrides: { hubUrl?: string; authSecret?: string | null } = {},
): McpConfig {
  return capped(uncappedBridgeConfig(config, overrides), env);
}
