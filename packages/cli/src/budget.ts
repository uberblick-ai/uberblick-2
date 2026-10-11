/**
 * UB_TEST_MAX_WAIT_MS is a ceiling, never a floor; unset or unusable values
 * preserve defaults. See CONTRIBUTING.md's Test deadlines for the test seam.
 * It caps hub connect/sync, port-owner, hub-clock and claim-state probes, plus
 * device-recovery pacing. Port expiry means unidentified holder, never stranger;
 * clock expiry means no reading, claim expiry not-unclaimed and hub expiry down.
 * Leave enough margin for healthy replies: a ceiling below normal latency can
 * turn success into failure. Do not cap lock waits or GitHub approval deadlines,
 * whose holders may legitimately wait longer than the suite's ceiling.
 * The environment reaches spawned ub processes; a function argument does not.
 * CLI callers use these builders so MCP defaults stay uncapped. Importing the
 * builders directly from mcp-server bypasses this convention.
 */

import {
  type McpConfig,
  bridgeConfig as uncappedBridgeConfig,
  resolveMcpConfig as uncappedResolveMcpConfig,
} from "@uberblick/mcp-server";

const CEILING_VARIABLE = "UB_TEST_MAX_WAIT_MS";

function ceiling(env: NodeJS.ProcessEnv): number | null {
  const raw = env[CEILING_VARIABLE]?.trim();
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  // Ignore invalid ceilings rather than turning a typo into zero wait.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Non-McpConfig probes use this process's ceiling. In-process callers wanting
 * another ceiling pass an explicit timeout to the probe instead.
 */
export function budget(ms: number): number {
  const cap = ceiling(process.env);
  return cap === null ? ms : Math.min(ms, cap);
}

/**
 * Cap hub deadlines and recovery pacing. Recovery's retry delay and renewal
 * cooldown only postpone asking again, so shortening them changes no answer.
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

export function resolveMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  return capped(uncappedResolveMcpConfig(env), env);
}

/**
 * bridgeConfig replaces both deadlines, so reapply the ceiling afterwards
 * using the same explicit environment that produced config.
 */
export function bridgeConfig(
  config: McpConfig,
  env: NodeJS.ProcessEnv,
  overrides: { hubUrl?: string; authSecret?: string | null } = {},
): McpConfig {
  return capped(uncappedBridgeConfig(config, overrides), env);
}
