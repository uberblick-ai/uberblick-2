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
 * variable is byte-for-byte the run it always was.
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
 * Every deadline the CLI owns passes through this module. The two `McpConfig`
 * builders are re-exported here rather than wrapped at each of their call sites,
 * so a new caller cannot import the uncapped pair by accident: within
 * `packages/cli`, `./budget.js` is where `resolveMcpConfig` and `bridgeConfig`
 * come from.
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

/** `ms`, or the ceiling if one is set and shorter. */
export function budget(
  ms: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
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

/** {@link uncappedBridgeConfig}, with the ceiling applied. */
export function bridgeConfig(
  config: McpConfig,
  overrides: { hubUrl?: string; authSecret?: string | null } = {},
): McpConfig {
  return capped(uncappedBridgeConfig(config, overrides), process.env);
}
