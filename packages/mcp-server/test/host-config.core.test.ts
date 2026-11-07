import { expect, it } from "vitest";
import { DEFAULT_HOST_LIMITS } from "../src/host-capacity.js";
import { resolveMcpHostConfig } from "../src/host-config.js";

it("defaults every host limit and reads every deployment override", () => {
  expect(resolveMcpHostConfig({ XDG_DATA_HOME: "/unused" }).limits).toEqual(DEFAULT_HOST_LIMITS);
  expect(resolveMcpHostConfig({
    XDG_DATA_HOME: "/unused", MCP_MAX_RUNTIMES: "2", MCP_MAX_SESSIONS: "3", MCP_MAX_CALLS: "4", MCP_MIN_FREE_BYTES: "0",
  }).limits).toEqual({ maxRuntimes: 2, maxSessions: 3, maxCalls: 4, minFreeBytes: 0 });
});

it("rejects invalid limits before starting the host", () => {
  for (const name of ["MCP_MAX_RUNTIMES", "MCP_MAX_SESSIONS", "MCP_MAX_CALLS", "MCP_MIN_FREE_BYTES"]) {
    for (const value of ["", " ", "-1", "1.5", "Infinity", "9007199254740992"]) {
      expect(() => resolveMcpHostConfig({ XDG_DATA_HOME: "/unused", [name]: value })).toThrow(name);
    }
  }
  for (const name of ["MCP_MAX_RUNTIMES", "MCP_MAX_SESSIONS", "MCP_MAX_CALLS"]) {
    expect(() => resolveMcpHostConfig({ XDG_DATA_HOME: "/unused", [name]: "0" })).toThrow(name);
  }
});
