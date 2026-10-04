/**
 * `ub env -- <command…>` — the one way anything that is not `ub` gets
 * uberblick's configuration.
 *
 * Two properties, and they are the whole command. The environment handed over
 * is the one `ub mcp serve` gives the MCP server, because the checkout's mise
 * tasks and an agent's server must not be configured differently. And there is
 * no spelling that *prints* it: the map carries the hub's signing secret, so it
 * is only ever handed to a child.
 */

import { describe, expect, it } from "vitest";
import { afterAll } from "vitest";
import { DEAD_HUB_URL, removeTempDirs, runUb, sandbox } from "./helpers.js";
import { resolveConfig } from "../src/config.js";

afterAll(removeTempDirs);

const WORKSPACE = "5c1f9a72-4d38-4e02-9b6a-7e3f10c85b94";
const SECRET = "ub-env-test-signing-secret-3f91ac";

/** The three variables the MCP server's interface is made of. */
const KEYS = ["WORKSPACE_ID", "HUB_URL", "HUB_AUTH_TOKEN"] as const;

/** A child that reports the values it was started with, as JSON on stdout. */
const REPORT =
  "process.stdout.write(JSON.stringify({" +
  KEYS.map((key) => `${key}: process.env.${key} ?? null`).join(", ") +
  "}))";

function injected(box: ReturnType<typeof sandbox>, extraEnv = {}) {
  const run = runUb(["env", "--", process.execPath, "-e", REPORT], box, extraEnv);
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Record<string, string | null>;
}

/** The same three values, as `resolveConfig` — and so `ub mcp serve` — has them. */
function resolved(box: ReturnType<typeof sandbox>): Record<string, string | null> {
  const map = resolveConfig({ env: box.env }).env;
  return Object.fromEntries(KEYS.map((key) => [key, map[key] ?? null]));
}

describe("ub env", () => {
  it("hands over exactly what `ub mcp serve` constructs for the MCP server", () => {
    const box = sandbox({
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: SECRET },
    });

    // `serve.ts` spawns the server with `resolveConfig().env` and nothing else,
    // and this command spawns its child with the same map through the same
    // helper — so equality here is equality with the server's environment.
    expect(injected(box)).toEqual(resolved(box));
    expect(injected(box)).toEqual({
      WORKSPACE_ID: WORKSPACE,
      HUB_URL: DEAD_HUB_URL,
      HUB_AUTH_TOKEN: SECRET,
    });
  });

  it("withholds a legacy signing secret from remote children and preserves it on disk", () => {
    const box = sandbox({
      userConfig: { workspace: WORKSPACE, hubUrl: "wss://hub.invalid/ws" },
      credentials: { signingSecret: SECRET },
    });
    expect(injected(box, { HUB_AUTH_TOKEN: SECRET })).toEqual({
      WORKSPACE_ID: WORKSPACE, HUB_URL: "wss://hub.invalid/ws", HUB_AUTH_TOKEN: null,
    });
  });

  it("puts the configured endpoint in front of an ambient one", () => {
    // The island trap (#376): a checkout that exported an endpoint took every
    // process born in it — including a task's — off the hub this machine is
    // bound to. The configured value wins, and with none configured the
    // ambient one is removed rather than passed on.
    const bound = sandbox({
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: SECRET },
    });
    expect(injected(bound, { HUB_URL: "ws://ambient.invalid:1" }).HUB_URL).toBe(
      DEAD_HUB_URL,
    );

    const unbound = sandbox({ userConfig: { workspace: WORKSPACE } });
    expect(injected(unbound, { HUB_URL: "ws://ambient.invalid:1" }).HUB_URL).toBe(
      null,
    );
  });

  it("has no form that prints the environment", () => {
    // Every spelling somebody would reach for to see the values. Each is a
    // usage error, and none of them puts the signing secret on a stream — a
    // secret on stdout is a secret in a shell history and a CI log.
    const box = sandbox({
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: SECRET },
    });

    for (const argv of [
      ["env"],
      ["env", "--print"],
      ["env", "--json"],
      ["env", "-p"],
      ["env", "print"],
      ["env", "export"],
      ["env", "--", "--print"],
    ]) {
      const run = runUb(argv, box);
      // The last one runs a command called `--print`, which does not exist:
      // 127, the way a shell reports it. Every other spelling is refused
      // outright.
      expect([2, 127], argv.join(" ")).toContain(run.status);
      expect(run.stdout, argv.join(" ")).toBe("");
      expect(run.output, argv.join(" ")).not.toContain(SECRET);
      expect(run.output, argv.join(" ")).toContain("ub env");
    }

    // Including the help, which describes the form and shows no values.
    const help = runUb(["env", "--help"], box);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^usage: ub env -- <command>/);
    expect(help.output).not.toContain(SECRET);
    expect(help.output).not.toContain(DEAD_HUB_URL);
  });

  it("becomes the command: its exit status, and 127 for one that is not there", () => {
    const box = sandbox({ userConfig: { workspace: WORKSPACE } });

    const failed = runUb(["env", "--", process.execPath, "-e", "process.exit(3)"], box);
    expect(failed.status).toBe(3);

    const missing = runUb(["env", "--", "definitely-not-a-command-9f2a"], box);
    expect(missing.status).toBe(127);
    expect(missing.stderr).toContain("command not found");
  });
});
