/**
 * The one contract `src/budget.ts` exists for that no spawned suite can see.
 *
 * Every process test hands its ceiling to a child through the child's own
 * environment, so `process.env` and the environment the config was resolved
 * from are the same map there and a wrapper reading the wrong one still looks
 * right. In-process callers pass an environment explicitly, and that is where
 * the two come apart: `bridgeConfig` replaces both deadlines with its own
 * longer ones, so a cap applied only by `resolveMcpConfig` does not survive the
 * bridge (#524, F2).
 */

import { describe, expect, it } from "vitest";
import { bridgeConfig, resolveMcpConfig } from "../src/budget.js";

const CUSTOM_ENV: NodeJS.ProcessEnv = {
  WORKSPACE_ID: "3f2b1c74-0d5e-4a91-8b62-7c4e9d1a5f38",
  UB_TEST_MAX_WAIT_MS: "400",
};

describe("the deadline ceiling", () => {
  it("survives the bridge when it came from a caller's environment", () => {
    const resolved = resolveMcpConfig(CUSTOM_ENV);
    expect(resolved.connectTimeoutMs).toBe(400);
    expect(resolved.syncTimeoutMs).toBe(400);

    const bridged = bridgeConfig(resolved, CUSTOM_ENV);
    expect(bridged.connectTimeoutMs).toBe(400);
    expect(bridged.syncTimeoutMs).toBe(400);
  });
});
