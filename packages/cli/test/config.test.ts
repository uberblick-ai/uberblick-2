/**
 * Configuration resolution is the contract every `ub` subcommand inherits, and
 * precedence is the part that is easy to get subtly wrong. Environment first,
 * because `HUB_URL=… ub mcp serve` has to keep working; then the committable
 * per-directory file; then the user's own config; then the built-in defaults,
 * which live in the MCP server and are not redefined here.
 */

import { join } from "node:path";
import { statSync } from "node:fs";
import { DEFAULT_HUB_URL, resolveMcpConfig } from "@uberblick/mcp-server";
import { afterAll, describe, expect, it } from "vitest";
import { resolveConfig, writeCredentials } from "../src/config.js";
import { removeTempDirs, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

describe("resolveConfig", () => {
  it("defaults when no configuration file exists anywhere", () => {
    const box = sandbox();
    const resolved = resolveConfig({ env: box.env, cwd: box.cwd });

    expect(resolved.warnings).toEqual([]);
    expect(resolved.origins).toEqual({
      workspace: "default",
      hubUrl: "default",
      credential: null,
    });

    // The defaults themselves are the MCP server's, reached by handing it the
    // resolved environment — one definition of the workspace, the hub and the
    // database path.
    const config = resolveMcpConfig(resolved.env);
    expect(config.workspaceId).toBe("main");
    expect(config.hubUrl).toBe(DEFAULT_HUB_URL);
    expect(config.authSecret).toBeNull();
    expect(config.databasePath).toBe(
      join(box.dataHome, "uberblick", "main.sqlite"),
    );
  });

  it("resolves workspace and hub URL in precedence order", () => {
    const files = {
      userConfig: { workspace: "from-user", hubUrl: "ws://user:1" },
      directoryFile: { workspace: "from-directory", hubUrl: "ws://directory:2" },
    };

    const user = sandbox({ userConfig: files.userConfig });
    const fromUser = resolveConfig({ env: user.env, cwd: user.cwd });
    expect(resolveMcpConfig(fromUser.env).workspaceId).toBe("from-user");
    expect(resolveMcpConfig(fromUser.env).hubUrl).toBe("ws://user:1");
    expect(fromUser.origins.workspace).toBe("user config");
    expect(fromUser.origins.hubUrl).toBe("user config");

    const both = sandbox(files);
    const fromDirectory = resolveConfig({ env: both.env, cwd: both.cwd });
    expect(resolveMcpConfig(fromDirectory.env).workspaceId).toBe("from-directory");
    expect(resolveMcpConfig(fromDirectory.env).hubUrl).toBe("ws://directory:2");
    expect(fromDirectory.origins.workspace).toBe("directory file");
    expect(fromDirectory.origins.hubUrl).toBe("directory file");

    const withEnv = sandbox(files);
    const fromEnv = resolveConfig({
      env: {
        ...withEnv.env,
        WORKSPACE_ID: "from-env",
        HUB_URL: "ws://env:3",
      },
      cwd: withEnv.cwd,
    });
    expect(resolveMcpConfig(fromEnv.env).workspaceId).toBe("from-env");
    expect(resolveMcpConfig(fromEnv.env).hubUrl).toBe("ws://env:3");
    expect(fromEnv.origins.workspace).toBe("environment");
    expect(fromEnv.origins.hubUrl).toBe("environment");
  });

  it("takes the signing secret from credentials.json, and the environment first", () => {
    const box = sandbox({ credentials: { signingSecret: "from-file" } });

    const fromFile = resolveConfig({ env: box.env, cwd: box.cwd });
    expect(fromFile.origins.credential).toBe("credentials file");
    expect(resolveMcpConfig(fromFile.env).authSecret).toBe("from-file");

    const fromEnv = resolveConfig({
      env: { ...box.env, HUB_AUTH_TOKEN: "from-env" },
      cwd: box.cwd,
    });
    expect(fromEnv.origins.credential).toBe("environment");
    expect(resolveMcpConfig(fromEnv.env).authSecret).toBe("from-env");
  });

  it("rejects a workspace that is not a single path segment, naming the source", () => {
    // The MCP server's rule, applied to file-sourced values: the workspace names
    // the SQLite file, and `path.join` follows every one of these out of the
    // data directory.
    for (const workspace of ["a/b", "..", ".", "..\\outside"]) {
      const box = sandbox({ directoryFile: { workspace } });
      expect(() => resolveConfig({ env: box.env, cwd: box.cwd })).toThrow(
        /uberblick\.json/,
      );
    }

    const fromEnv = sandbox();
    expect(() =>
      resolveConfig({
        env: { ...fromEnv.env, WORKSPACE_ID: "a/b" },
        cwd: fromEnv.cwd,
      }),
    ).toThrow(/WORKSPACE_ID/);
  });

  it("warns about a file it cannot use, and falls through to the layer below", () => {
    const box = sandbox({
      userConfig: { workspace: "from-user" },
      raw: { directoryFile: "{ not json" },
    });
    const resolved = resolveConfig({ env: box.env, cwd: box.cwd });

    expect(resolved.warnings.join("\n")).toMatch(/uberblick\.json.*invalid JSON/);
    expect(resolveMcpConfig(resolved.env).workspaceId).toBe("from-user");

    // A known key of the wrong type is the same story: warn, do not adopt.
    const typed = sandbox({ directoryFile: { workspace: 42 } });
    const fromTyped = resolveConfig({ env: typed.env, cwd: typed.cwd });
    expect(fromTyped.warnings.join("\n")).toMatch(/"workspace".*non-empty string/);
    expect(resolveMcpConfig(fromTyped.env).workspaceId).toBe("main");
  });

  it("refuses a credentials file anyone else can read, rather than using it", () => {
    // ssh's contract for a private key: a secret another user on the machine can
    // read is not adopted. Warning and using it anyway would leave the exposure
    // in place and call it handled.
    const secret = "exposed-signing-secret";
    const box = sandbox({
      credentials: { signingSecret: secret },
      credentialsMode: 0o644,
    });

    const refused = resolveConfig({ env: box.env, cwd: box.cwd });
    const warning = refused.warnings.join("\n");
    // Both facts and the fix: the mode, that the secret went unused, the chmod.
    expect(warning).toMatch(/refusing .*credentials\.json: mode 0644/);
    expect(warning).toMatch(/not used/);
    expect(warning).toMatch(/chmod 600 .*credentials\.json/);
    // The secret itself is in no warning, and in nothing handed to the server.
    expect(warning).not.toContain(secret);
    expect(refused.env.HUB_AUTH_TOKEN).toBeUndefined();
    expect(refused.origins.credential).toBeNull();
    expect(resolveMcpConfig(refused.env).authSecret).toBeNull();

    // Refusal is the file layer only: the environment still wins and still works.
    const fromEnv = resolveConfig({
      env: { ...box.env, HUB_AUTH_TOKEN: "from-env" },
      cwd: box.cwd,
    });
    expect(fromEnv.origins.credential).toBe("environment");
    expect(resolveMcpConfig(fromEnv.env).authSecret).toBe("from-env");
    expect(fromEnv.warnings.join("\n")).toMatch(/refusing/);
  });

  it("withholds the stored secret from a hub ./uberblick.json chose", () => {
    // The hostile checkout: a clone carries a committed `uberblick.json` naming
    // the attacker's endpoint. Entering the directory must not be enough to send
    // this user's signed read-write token there.
    const secret = "scoping-signing-secret-4b17c9";
    const box = sandbox({
      directoryFile: { hubUrl: "ws://attacker.example:9999" },
      credentials: { signingSecret: secret },
    });

    const withheld = resolveConfig({ env: box.env, cwd: box.cwd });
    expect(resolveMcpConfig(withheld.env).hubUrl).toBe(
      "ws://attacker.example:9999",
    );
    expect(withheld.env.HUB_AUTH_TOKEN).toBeUndefined();
    expect(resolveMcpConfig(withheld.env).authSecret).toBeNull();
    // `origins.credential` reports reality, so `ub status` says local-only.
    expect(withheld.origins.credential).toBeNull();
    // The warning names the situation and both explicit opt-ins, not the secret.
    const warning = withheld.warnings.join("\n");
    expect(warning).toMatch(/uberblick\.json points this checkout at ws:\/\/attacker/);
    expect(warning).toMatch(/HUB_AUTH_TOKEN/);
    expect(warning).toMatch(/HUB_URL/);
    expect(warning).not.toContain(secret);

    // Opt-in one: the environment secret is a deliberate act, so it applies to
    // whatever hub is in force — including the repository's.
    const withEnvSecret = resolveConfig({
      env: { ...box.env, HUB_AUTH_TOKEN: "from-env" },
      cwd: box.cwd,
    });
    expect(withEnvSecret.origins.credential).toBe("environment");
    expect(resolveMcpConfig(withEnvSecret.env).authSecret).toBe("from-env");
    expect(withEnvSecret.warnings).toEqual([]);

    // Opt-in two: choose the hub yourself and the stored secret comes along.
    const withEnvUrl = resolveConfig({
      env: { ...box.env, HUB_URL: "ws://mine:1234" },
      cwd: box.cwd,
    });
    expect(withEnvUrl.origins.credential).toBe("credentials file");
    expect(resolveMcpConfig(withEnvUrl.env).authSecret).toBe(secret);
    expect(withEnvUrl.warnings).toEqual([]);

    // And a hub the *user* configured is not repository-chosen either.
    const userChosen = sandbox({
      userConfig: { hubUrl: "ws://mine:1234" },
      credentials: { signingSecret: secret },
    });
    const fromUser = resolveConfig({ env: userChosen.env, cwd: userChosen.cwd });
    expect(fromUser.origins.credential).toBe("credentials file");
    expect(fromUser.warnings).toEqual([]);
  });

  it("keeps a malformed credentials file's contents out of the warning", () => {
    // Node's JSON.parse errors quote the source around the syntax error, so the
    // parser message for a file someone pasted a bare secret into *is* the
    // secret. For that one file the warning names the path and nothing else.
    const secret = "bare-unquoted-signing-secret-8ac3";
    const box = sandbox({ raw: { credentials: `${secret}\n` } });

    const resolved = resolveConfig({ env: box.env, cwd: box.cwd });
    expect(resolved.warnings.join("\n")).toMatch(
      /ignoring .*credentials\.json: invalid JSON$/,
    );
    expect(resolved.warnings.join("\n")).not.toContain(secret);
    expect(resolved.origins.credential).toBeNull();

    // Other files keep the detailed message: nothing in them is a secret.
    const other = sandbox({ raw: { directoryFile: "{ not json" } });
    expect(
      resolveConfig({ env: other.env, cwd: other.cwd }).warnings.join("\n"),
    ).toMatch(/uberblick\.json: invalid JSON \(/);
  });

  it("refuses a signing secret in a committable file", () => {
    const box = sandbox({ directoryFile: { signingSecret: "nope" } });
    const resolved = resolveConfig({ env: box.env, cwd: box.cwd });

    expect(resolved.warnings.join("\n")).toMatch(/credentials\.json/);
    expect(resolveMcpConfig(resolved.env).authSecret).toBeNull();
  });
});

describe("writeCredentials", () => {
  it("creates the file 0600, and repairs the mode of one that already exists", () => {
    const box = sandbox({
      credentials: { signingSecret: "old" },
      credentialsMode: 0o644,
    });

    const path = writeCredentials({ signingSecret: "new" }, box.env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The repair is what makes the file usable at all: at 0644 the reader would
    // refuse it. (That the tighten happens *before* the truncate is the other
    // half of the guarantee — see writeCredentials — and is racy to assert.)
    const repaired = resolveConfig({ env: box.env, cwd: box.cwd });
    expect(repaired.warnings).toEqual([]);
    expect(resolveMcpConfig(repaired.env).authSecret).toBe("new");

    const fresh = sandbox();
    const created = writeCredentials({ signingSecret: "new" }, fresh.env);
    expect(statSync(created).mode & 0o777).toBe(0o600);
    expect(
      resolveMcpConfig(resolveConfig({ env: fresh.env, cwd: fresh.cwd }).env)
        .authSecret,
    ).toBe("new");
  });
});
