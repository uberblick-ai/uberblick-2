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
 * **Which deadlines it may cap, and which it must not.** What it caps are five
 * probes of something remote: the two hub budgets below, `open.ts`'s 1 s
 * port-owner probe, `probes.ts`'s 2 s clock observation and `auth.ts`'s 2 s
 * claim-state read. Expiry is a permitted answer for each of them, but not a
 * free one — `whoHoldsPort` reads a timeout as a holder it could not identify
 * (never as a stranger, which would accuse a slow `ub open`), `probeHubClock`
 * reads one as no observation at all, `ub auth login` reads one as a hub that
 * is not unclaimed, and `ub doctor` reports a hub that missed its budget as
 * down. (Device recovery pacing is capped too; see {@link capped}.) What makes them safe
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
 * This process's own environment, which is what both call sites want: they run
 * inside a spawned `ub` and have no other map in hand. Neither deadline is an
 * `McpConfig` field, so {@link resolveMcpConfig} and {@link bridgeConfig} do
 * not reach them: `whoHoldsPort` is module-private, and `probeHubClock` takes
 * its `timeoutMs` explicitly, so an in-process caller wanting its own ceiling
 * passes one rather than inheriting this environment.
 */
export function budget(ms: number): number {
  const cap = ceiling(process.env);
  return cap === null ? ms : Math.min(ms, cap);
}

/**
 * The same configuration with its two hub deadlines capped, and with device
 * recovery paced by the same ceiling.
 *
 * The device-login recovery poll and the shared renewal cooldown are not
 * deadlines anyone holds: each is only how long this process waits before it
 * asks the hub again (thirty seconds apiece by default). Capping them makes a
 * suite ask sooner and changes no answer, while leaving them at thirty seconds
 * made the remote-sharing recovery proofs in `test/open-remote.test.ts` wait out
 * minutes of real time.
 */
function capped(config: McpConfig, env: NodeJS.ProcessEnv): McpConfig {
  const cap = ceiling(env);
  if (cap === null) return config;
  return {
    ...config,
    connectTimeoutMs: Math.min(config.connectTimeoutMs, cap),
    syncTimeoutMs: Math.min(config.syncTimeoutMs, cap),
    deviceRetryMaxDelayMs: Math.min(config.deviceRetryMaxDelayMs ?? 30_000, cap),
    deviceRenewalCooldownMs: Math.min(config.deviceRenewalCooldownMs ?? 30_000, cap),
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
