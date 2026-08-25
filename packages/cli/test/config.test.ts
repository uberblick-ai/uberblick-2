/**
 * Configuration resolution is the contract every `ub` subcommand inherits, and
 * precedence is the part that is easy to get subtly wrong. Environment first,
 * because `HUB_URL=… ub mcp serve` has to keep working; then the committable
 * per-directory file; then the user's own config; then the built-in defaults,
 * which live in the MCP server and are not redefined here.
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
import { removeTempDirs, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

/** Workspace ids are uuids; one per layer, so precedence is unambiguous. */
const FROM_USER = "aaaaaaaa-1111-4111-8111-111111111111";
const FROM_DIRECTORY = "bbbbbbbb-2222-4222-8222-222222222222";
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
    const resolved = resolveConfig({ env: box.env, cwd: box.cwd });

    expect(resolved.warnings).toEqual([]);
    expect(resolved.origins).toEqual({
      workspace: "default",
      hubUrl: "default",
      credential: null,
    });

    // The workspace is the one value with no default: nothing may guess which
    // corpus this machine belongs to.
    expect(resolved.env.WORKSPACE_ID).toBeUndefined();
    expect(() => resolveMcpConfig(resolved.env)).toThrow(/ub init/);

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
    const resolved = resolveConfig({ env: box.env, cwd: box.cwd });

    expect(resolved.env.WORKSPACE_ID).toBe(decorated);
    expect(mcpConfig(resolved.env).workspaceId).toBe(FROM_USER);
    expect(mcpConfig(resolved.env).databasePath).toBe(
      join(box.dataHome, "uberblick", `${FROM_USER}.sqlite`),
    );
  });

  it("resolves workspace and hub URL in precedence order", () => {
    const files = {
      userConfig: { workspace: FROM_USER, hubUrl: "ws://user:1" },
      directoryFile: { workspace: FROM_DIRECTORY, hubUrl: "ws://directory:2" },
    };

    const user = sandbox({ userConfig: files.userConfig });
    const fromUser = resolveConfig({ env: user.env, cwd: user.cwd });
    expect(mcpConfig(fromUser.env).workspaceId).toBe(FROM_USER);
    expect(mcpConfig(fromUser.env).hubUrl).toBe("ws://user:1");
    expect(fromUser.origins.workspace).toBe("user config");
    expect(fromUser.origins.hubUrl).toBe("user config");

    const both = sandbox(files);
    const fromDirectory = resolveConfig({ env: both.env, cwd: both.cwd });
    expect(mcpConfig(fromDirectory.env).workspaceId).toBe(FROM_DIRECTORY);
    expect(mcpConfig(fromDirectory.env).hubUrl).toBe("ws://directory:2");
    expect(fromDirectory.origins.workspace).toBe("directory file");
    expect(fromDirectory.origins.hubUrl).toBe("directory file");

    const withEnv = sandbox(files);
    const fromEnv = resolveConfig({
      env: {
        ...withEnv.env,
        WORKSPACE_ID: FROM_ENV,
        HUB_URL: "ws://env:3",
      },
      cwd: withEnv.cwd,
    });
    expect(mcpConfig(fromEnv.env).workspaceId).toBe(FROM_ENV);
    expect(mcpConfig(fromEnv.env).hubUrl).toBe("ws://env:3");
    expect(fromEnv.origins.workspace).toBe("environment");
    expect(fromEnv.origins.hubUrl).toBe("environment");
  });

  it("takes the signing secret from credentials.json, and the environment first", () => {
    const box = sandbox({ credentials: { signingSecret: "from-file" } });

    const fromFile = resolveConfig({ env: box.env, cwd: box.cwd });
    expect(fromFile.origins.credential).toBe("credentials file");
    expect(mcpConfig(fromFile.env).authSecret).toBe("from-file");

    const fromEnv = resolveConfig({
      env: { ...box.env, HUB_AUTH_TOKEN: "from-env" },
      cwd: box.cwd,
    });
    expect(fromEnv.origins.credential).toBe("environment");
    expect(mcpConfig(fromEnv.env).authSecret).toBe("from-env");
  });

  it("rejects a workspace that is not a workspace id, naming the source", () => {
    // Schema's rule, applied to file-sourced values too. `main` is in the list
    // because it used to be the default: a checkout that still names it is
    // told so rather than quietly opening a workspace nobody owns.
    for (const workspace of ["a/b", "..", ".", "..\\outside", "main", "team-b"]) {
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
      userConfig: { workspace: FROM_USER },
      raw: { directoryFile: "{ not json" },
    });
    const resolved = resolveConfig({ env: box.env, cwd: box.cwd });

    expect(resolved.warnings.join("\n")).toMatch(/uberblick\.json: invalid JSON/);
    expect(mcpConfig(resolved.env).workspaceId).toBe(FROM_USER);

    // A known key of the wrong type is the same story: warn, do not adopt.
    const typed = sandbox({ directoryFile: { workspace: 42 } });
    const fromTyped = resolveConfig({ env: typed.env, cwd: typed.cwd });
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
    expect(mcpConfig(refused.env).authSecret).toBeNull();

    // Refusal is the file layer only: the environment still wins and still works.
    const fromEnv = resolveConfig({
      env: { ...box.env, HUB_AUTH_TOKEN: "from-env" },
      cwd: box.cwd,
    });
    expect(fromEnv.origins.credential).toBe("environment");
    expect(mcpConfig(fromEnv.env).authSecret).toBe("from-env");
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
    expect(mcpConfig(withheld.env).hubUrl).toBe(
      "ws://attacker.example:9999",
    );
    expect(withheld.env.HUB_AUTH_TOKEN).toBeUndefined();
    expect(mcpConfig(withheld.env).authSecret).toBeNull();
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
    expect(mcpConfig(withEnvSecret.env).authSecret).toBe("from-env");
    expect(withEnvSecret.warnings).toEqual([]);

    // Opt-in two: choose the hub yourself and the stored secret comes along.
    const withEnvUrl = resolveConfig({
      env: { ...box.env, HUB_URL: "ws://mine:1234" },
      cwd: box.cwd,
    });
    expect(withEnvUrl.origins.credential).toBe("credentials file");
    expect(mcpConfig(withEnvUrl.env).authSecret).toBe(secret);
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

  it("keeps a malformed file's contents out of the warning, whichever file it is", () => {
    // Node's JSON.parse errors quote the source around the syntax error, so the
    // parser message for a file someone pasted a bare secret into *is* the
    // secret — and not only for credentials.json: a secret in a committable file
    // is the mistake `warnAboutMisplacedSecret` exists to catch, and a file that
    // does not parse never reaches it. Every one of these says only its name.
    const secret = "bare-unquoted-signing-secret-8ac3";
    for (const file of ["credentials", "directoryFile", "userConfig"] as const) {
      const box = sandbox({ raw: { [file]: `${secret}\n` } });
      const resolved = resolveConfig({ env: box.env, cwd: box.cwd });

      expect(resolved.warnings.join("\n")).toMatch(/: invalid JSON$/);
      expect(resolved.warnings.join("\n")).not.toContain(secret);
      expect(resolved.origins.credential).toBeNull();
    }
  });

  it("refuses a signing secret in a committable file", () => {
    const box = sandbox({ directoryFile: { signingSecret: "nope" } });
    const resolved = resolveConfig({ env: box.env, cwd: box.cwd });

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

    const resolved = resolveConfig({ env: box.env, cwd: box.cwd });
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
    const repaired = resolveConfig({ env: box.env, cwd: box.cwd });
    expect(repaired.warnings).toEqual([]);
    expect(mcpConfig(repaired.env).authSecret).toBe("new");

    const fresh = sandbox();
    const created = writeCredentials({ signingSecret: "new" }, fresh.env);
    expect(statSync(created).mode & 0o777).toBe(0o600);
    expect(
      mcpConfig(resolveConfig({ env: fresh.env, cwd: fresh.cwd }).env)
        .authSecret,
    ).toBe("new");
  });
});
