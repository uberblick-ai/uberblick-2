/**
 * Configuration comes from the environment, and one value there is
 * load-bearing twice: `WORKSPACE_ID` is both a room segment and the name of the
 * SQLite file. Anything that can escape a path segment can therefore put the
 * database outside the data directory.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_HUB_URL, resolveMcpConfig } from "../src/config.js";

/** A minimal environment: no HUB_AUTH_TOKEN, so the server is local-only. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { XDG_DATA_HOME: "/tmp/uberblick-config-test", ...overrides };
}

describe("resolveMcpConfig", () => {
  it("defaults to the documented workspace, hub and database path", () => {
    const config = resolveMcpConfig(env());
    expect(config.workspaceId).toBe("main");
    expect(config.hubUrl).toBe(DEFAULT_HUB_URL);
    expect(config.authSecret).toBeNull();
    expect(config.databasePath).toBe(
      join("/tmp/uberblick-config-test", "uberblick", "main.sqlite"),
    );
  });

  it("keeps the database inside the data directory", () => {
    const config = resolveMcpConfig(env({ WORKSPACE_ID: "team-b" }));
    expect(config.databasePath).toBe(
      join("/tmp/uberblick-config-test", "uberblick", "team-b.sqlite"),
    );
  });

  it("rejects a workspace that is not a single path segment", () => {
    // `path.join` follows every one of these out of the data directory — the
    // backslash cases on Windows, where it is also a separator.
    for (const workspaceId of [
      "a/b",
      "..",
      "../outside",
      "..\\outside",
      "a\\b",
      ".",
    ]) {
      expect(() => resolveMcpConfig(env({ WORKSPACE_ID: workspaceId }))).toThrow(
        /WORKSPACE_ID/,
      );
    }
  });

  it("treats a blank workspace as unset rather than as a segment", () => {
    expect(resolveMcpConfig(env({ WORKSPACE_ID: "   " })).workspaceId).toBe(
      "main",
    );
  });
});
