/**
 * Configuration resolution is the contract every `ub` subcommand inherits, and
 * precedence is the part that is easy to get subtly wrong.
 *
 * The workspace and the signing secret have two layers: the environment — which
 * is how a project MCP entry's `WORKSPACE_ID` pin and `fnox exec`'s secret
 * arrive — then the user's own config, then the built-in defaults, which live
 * in the MCP server and are not redefined here. **The endpoint has one**: this
 * machine's `config.json`. An ambient `HUB_URL` is not read and is not passed
 * on, because two sources for the endpoint is the island trap (#376, #385).
 */

import { join } from "node:path";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DEFAULT_HUB_URL, resolveMcpConfig } from "@uberblick/mcp-server";
import { afterAll, describe, expect, it } from "vitest";
import {
  claimSigningSecret,
  credentialsPath,
  resolveConfig,
  writeCredentials,
} from "../src/config.js";
import { REPO_ROOT, removeTempDirs, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

/** Workspace ids are uuids; one per layer, so precedence is unambiguous. */
const FROM_USER = "aaaaaaaa-1111-4111-8111-111111111111";
const FROM_ENV = "cccccccc-3333-4333-8333-333333333333";

/**
 * The MCP config for a resolved environment, with a workspace supplied when the
 * layers under test do not carry one — most cases here are about the signing
 * secret or the hub URL, and a sandbox has no workspace unless it was given one.
 * An environment that does carry a workspace still wins.
 */
function mcpConfig(env: NodeJS.ProcessEnv) {
  return resolveMcpConfig({ WORKSPACE_ID: FROM_USER, ...env });
}

describe("resolveConfig", () => {
  it("defaults when no configuration file exists anywhere", () => {
    const box = sandbox();
    const resolved = resolveConfig({ env: box.env });

    expect(resolved.warnings).toEqual([]);
    expect(resolved.origins).toEqual({
      workspace: "default",
      hubUrl: "default",
      credential: null,
    });

    // The workspace is the one value with no default: nothing may guess which
    // corpus this machine belongs to.
    expect(resolved.env.WORKSPACE_ID).toBeUndefined();
    // And the refusal is the whole answer for a machine that is not bound
    // yet: the exact file `ub` takes a workspace from, and both commands that
    // write it — `ub remote join` being the one a flag-day re-bind runs.
    expect(() => resolveMcpConfig(resolved.env)).toThrow(
      join(box.configHome, "uberblick", "config.json"),
    );
    expect(() => resolveMcpConfig(resolved.env)).toThrow(/ub init/);
    expect(() => resolveMcpConfig(resolved.env)).toThrow(/ub remote join/);

    // The rest of the defaults are the MCP server's, reached by handing it the
    // resolved environment — one definition of the hub and the database path.
    const config = resolveMcpConfig({
      ...resolved.env,
      WORKSPACE_ID: FROM_USER,
    });
    expect(config.hubUrl).toBe(DEFAULT_HUB_URL);
    expect(config.authSecret).toBeNull();
    expect(config.databasePath).toBe(
      join(box.dataHome, "uberblick", `${FROM_USER}.sqlite`),
    );
  });

  it("keeps a decorated workspace as typed, and resolves it to its uuid", () => {
    // Storage and display keep the spelling its owner chose; everything the
    // MCP server keys by — rooms, the token claim, the database — is the uuid.
    const decorated = `uberblick-${FROM_USER}`;
    const box = sandbox({ userConfig: { workspace: decorated } });
    const resolved = resolveConfig({ env: box.env });

    expect(resolved.env.WORKSPACE_ID).toBe(decorated);
    expect(mcpConfig(resolved.env).workspaceId).toBe(FROM_USER);
    expect(mcpConfig(resolved.env).databasePath).toBe(
      join(box.dataHome, "uberblick", `${FROM_USER}.sqlite`),
    );
  });

  it("takes the workspace from the environment first, then the user config", () => {
    const userConfig = { workspace: FROM_USER, hubUrl: "ws://user:1" };

    const user = sandbox({ userConfig });
    const fromUser = resolveConfig({ env: user.env });
    expect(mcpConfig(fromUser.env).workspaceId).toBe(FROM_USER);
    expect(fromUser.origins.workspace).toBe("user config");

    // The environment is what a project MCP entry's `WORKSPACE_ID` pin arrives
    // as, so this is also what makes such a pin outrank the user's default.
    const withEnv = sandbox({ userConfig });
    const fromEnv = resolveConfig({
      env: { ...withEnv.env, WORKSPACE_ID: FROM_ENV },
    });
    expect(mcpConfig(fromEnv.env).workspaceId).toBe(FROM_ENV);
    expect(fromEnv.origins.workspace).toBe("environment");
  });

  it("takes the endpoint from the user config alone, whatever the environment says", () => {
    // The layer that made an activated checkout outrank a machine bound to a
    // remote hub, so that writes reported `synced` against a hub nobody else
    // was reading (#376). It is gone, and gone means not passed on either: the
    // map handed to `ub mcp serve`'s child carries the configured endpoint, or
    // none at all, never the ambient one.
    const box = sandbox({ userConfig: { workspace: FROM_USER, hubUrl: "ws://user:1" } });
    const resolved = resolveConfig({
      env: { ...box.env, HUB_URL: "ws://ambient:3" },
    });
    expect(resolved.origins.hubUrl).toBe("user config");
    expect(resolved.env.HUB_URL).toBe("ws://user:1");
    expect(mcpConfig(resolved.env).hubUrl).toBe("ws://user:1");

    // With nothing configured the ambient value is removed rather than passed
    // through, so the child falls back to the in-code default.
    const bare = sandbox({ userConfig: { workspace: FROM_USER } });
    const unconfigured = resolveConfig({
      env: { ...bare.env, HUB_URL: "ws://ambient:3" },
    });
    expect(unconfigured.origins.hubUrl).toBe("default");
    expect(unconfigured.env.HUB_URL).toBeUndefined();
    expect(mcpConfig(unconfigured.env).hubUrl).toBe(DEFAULT_HUB_URL);
  });

  it("takes the signing secret from credentials.json, and the environment first", () => {
    const box = sandbox({ credentials: { signingSecret: "from-file" } });

    const fromFile = resolveConfig({ env: box.env });
    expect(fromFile.origins.credential).toBe("credentials file");
    expect(mcpConfig(fromFile.env).authSecret).toBe("from-file");

    const fromEnv = resolveConfig({
      env: { ...box.env, HUB_AUTH_TOKEN: "from-env" },
    });
    expect(fromEnv.origins.credential).toBe("environment");
    expect(mcpConfig(fromEnv.env).authSecret).toBe("from-env");
  });

  it("rejects a workspace that is not a workspace id, naming the source", () => {
    // Schema's rule, applied to file-sourced values too. `main` is in the list
    // because it used to be the default: a checkout that still names it is
    // told so rather than quietly opening a workspace nobody owns.
    for (const workspace of ["a/b", "..", ".", "..\\outside", "main", "team-b"]) {
      const box = sandbox({ userConfig: { workspace } });
      expect(() => resolveConfig({ env: box.env })).toThrow(/config\.json/);
    }

    const fromEnv = sandbox();
    expect(() =>
      resolveConfig({
        env: { ...fromEnv.env, WORKSPACE_ID: "a/b" },
      }),
    ).toThrow(/WORKSPACE_ID/);
  });

  it("warns about a file it cannot use, and falls through to the layer below", () => {
    const box = sandbox({ raw: { userConfig: "{ not json" } });
    const resolved = resolveConfig({
      env: { ...box.env, WORKSPACE_ID: FROM_ENV },
    });

    expect(resolved.warnings.join("\n")).toMatch(/config\.json: invalid JSON/);
    expect(mcpConfig(resolved.env).workspaceId).toBe(FROM_ENV);

    // A known key of the wrong type is the same story: warn, do not adopt.
    const typed = sandbox({ userConfig: { workspace: 42 } });
    const fromTyped = resolveConfig({ env: typed.env });
    expect(fromTyped.warnings.join("\n")).toMatch(/"workspace".*non-empty string/);
    // Nothing below it either, so there is no workspace at all — not a default.
    expect(fromTyped.env.WORKSPACE_ID).toBeUndefined();
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

    const refused = resolveConfig({ env: box.env });
    const warning = refused.warnings.join("\n");
    // Both facts and the fix: the mode, that the secret went unused, the chmod.
    expect(warning).toMatch(/refusing .*credentials\.json: mode 0644/);
    expect(warning).toMatch(/not used/);
    expect(warning).toMatch(/chmod 600 .*credentials\.json/);
    // The secret itself is in no warning, and in nothing handed to the server.
    expect(warning).not.toContain(secret);
    expect(refused.env.HUB_AUTH_TOKEN).toBeUndefined();
    expect(refused.origins.credential).toBeNull();
    expect(mcpConfig(refused.env).authSecret).toBeNull();

    // Refusal is the file layer only: the environment still wins and still works.
    const fromEnv = resolveConfig({
      env: { ...box.env, HUB_AUTH_TOKEN: "from-env" },
    });
    expect(fromEnv.origins.credential).toBe("environment");
    expect(mcpConfig(fromEnv.env).authSecret).toBe("from-env");
    expect(fromEnv.warnings.join("\n")).toMatch(/refusing/);
  });

  it("keeps a malformed file's contents out of the warning, whichever file it is", () => {
    // Node's JSON.parse errors quote the source around the syntax error, so the
    // parser message for a file someone pasted a bare secret into *is* the
    // secret — and not only for credentials.json: a secret in a committable file
    // is the mistake `warnAboutMisplacedSecret` exists to catch, and a file that
    // does not parse never reaches it. Every one of these says only its name.
    const secret = "bare-unquoted-signing-secret-8ac3";
    for (const file of ["credentials", "userConfig"] as const) {
      const box = sandbox({ raw: { [file]: `${secret}\n` } });
      const resolved = resolveConfig({ env: box.env });

      expect(resolved.warnings.join("\n")).toMatch(/: invalid JSON$/);
      expect(resolved.warnings.join("\n")).not.toContain(secret);
      expect(resolved.origins.credential).toBeNull();
    }
  });

  it("refuses a signing secret in a file that is not credentials.json", () => {
    const box = sandbox({ userConfig: { signingSecret: "nope" } });
    const resolved = resolveConfig({ env: box.env });

    expect(resolved.warnings.join("\n")).toMatch(/credentials\.json/);
    expect(mcpConfig(resolved.env).authSecret).toBeNull();
  });
});

describe("claimSigningSecret", () => {
  it("lets the first caller win, and every later one adopt", () => {
    // The concurrency contract, without the timing: two fresh `ub init`s each
    // generate a candidate, and only one of them may become the secret. A
    // second value replacing the first would strand every client — the hub, the
    // web bundle, the MCP servers — that already holds it.
    const box = sandbox();
    expect(claimSigningSecret("first-candidate", box.env)).toBe("first-candidate");
    expect(claimSigningSecret("second-candidate", box.env)).toBe("first-candidate");

    const resolved = resolveConfig({ env: box.env });
    expect(mcpConfig(resolved.env).authSecret).toBe("first-candidate");
    expect(statSync(credentialsPath(box.env)).mode & 0o777).toBe(0o600);
  });

  it("leaves no staging file behind holding a second copy of the secret", () => {
    // Deliberately NOT asserting that the published file is complete: with the
    // secret written before the name is published, no single-process test can
    // tell the `link` idiom from the exclusive `open` it replaced — the empty
    // window the idiom closes is between two syscalls of another process. That
    // property is structural. What IS observable is the staging file, which
    // holds the secret under a name nobody would think to look for.
    const box = sandbox();
    claimSigningSecret("published-whole", box.env);

    expect(JSON.parse(readFileSync(credentialsPath(box.env), "utf8"))).toEqual({
      signingSecret: "published-whole",
    });
    expect(readdirSync(join(box.configHome, "uberblick"))).toEqual([
      "credentials.json",
    ]);
  });

  it("fills in a credentials file that has other keys but no secret", () => {
    // Not the exclusive-create path: the file exists, so this is an ordinary
    // read-modify-write, and what it must not do is drop what it did not write.
    const box = sandbox({ credentials: { remoteToken: "keep-me" } });
    expect(claimSigningSecret("mine", box.env)).toBe("mine");

    const written = JSON.parse(readFileSync(credentialsPath(box.env), "utf8"));
    expect(written).toEqual({ remoteToken: "keep-me", signingSecret: "mine" });
  });
});

describe("writing the files ub owns", () => {
  // No test for `writeAll`'s loop. A write to a regular file does not come back
  // short, so no payload reaches a second iteration and any test of it would be
  // asserting that one `writeSync` writes what it was given. The loop stays
  // because the syscall's contract permits a short write; the test would not
  // have been defending it.

  it("refuses a symlink rather than writing the secret through it", () => {
    // Anything that can plant a symlink at `credentials.json` could otherwise
    // choose which file receives the signing secret — and where it ends up
    // readable. The refusal names the fix.
    const box = sandbox();
    const target = join(box.configHome, "elsewhere.json");
    mkdirSync(join(box.configHome, "uberblick"), { recursive: true });
    writeFileSync(target, "{}\n", "utf8");
    symlinkSync(target, credentialsPath(box.env));

    expect(() => writeCredentials({ signingSecret: "never" }, box.env)).toThrow(
      /it is a symbolic link/,
    );
    expect(readFileSync(target, "utf8")).toBe("{}\n");
    expect(lstatSync(credentialsPath(box.env)).isSymbolicLink()).toBe(true);
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
    const repaired = resolveConfig({ env: box.env });
    expect(repaired.warnings).toEqual([]);
    expect(mcpConfig(repaired.env).authSecret).toBe("new");

    const fresh = sandbox();
    const created = writeCredentials({ signingSecret: "new" }, fresh.env);
    expect(statSync(created).mode & 0o777).toBe(0o600);
    expect(
      mcpConfig(resolveConfig({ env: fresh.env }).env)
        .authSecret,
    ).toBe("new");
  });
});

describe("the committed mise config", () => {
  // Belt and braces beside the resolution above. `ub` ignores an ambient
  // `HUB_URL` outright now, but the checkout tasks hand their environment to
  // programs that do read it — vite bakes it into a dev bundle — so a committed
  // endpoint here would still bind a checkout to whatever the repository
  // guessed (#376, #385). The address belongs in the clients' code as a
  // fallback, and the real one in this machine's `config.json`, which `ub env`
  // is what puts in front of a task.
  it("exports no HUB_URL, so a checkout binds no endpoint", () => {
    const assignments = readFileSync(join(REPO_ROOT, "mise.toml"), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .filter((line) => /\bHUB_URL\s*=/.test(line));

    expect(assignments).toEqual([]);
  });
});
