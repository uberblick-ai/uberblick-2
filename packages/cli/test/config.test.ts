/** Private credentials and shared atomic selection regressions. */

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
import {
  REPO_ROOT,
  SECRET_IN_ENV,
  SECRET_ON_FILE,
  removeTempDirs,
  sandbox,
  unboundSandbox,
  tracesOf,
} from "./helpers.js";

afterAll(removeTempDirs);

/** Workspace ids are uuids; one per layer, so precedence is unambiguous. */
const FROM_USER = "aaaaaaaa-1111-4111-8111-111111111111";
const FROM_ENV = "cccccccc-3333-4333-8333-333333333333";

/**
 * The MCP config for a resolved environment, with a workspace supplied when the
 * layers under test do not carry one — the explicitly unbound cases keep
 * their absent selection while testing legacy admission or machine defaults.
 * An environment that does carry a workspace still wins.
 */
function mcpConfig(env: NodeJS.ProcessEnv) {
  return resolveMcpConfig({ WORKSPACE_ID: FROM_USER, ...env });
}

describe("resolveConfig", () => {
  it("resolves joined device admission by the explicit endpoint, including complete environment pins", () => {
    const first = "ws://localhost:8080/custom-path";
    const second = "ws://localhost:8081/other-path";
    const box = sandbox({
      projectBinding: { workspaceId: FROM_USER, hubUrl: first },
      userConfig: { hubAdmissions: { [first]: "device", [second]: "device" } },
      credentials: { signingSecret: SECRET_ON_FILE },
    });
    for (const extra of [{}, { UB_WORKSPACE_ID: FROM_ENV, UB_HUB_URL: second }]) {
      const resolved = resolveConfig({ env: { ...box.env, ...extra, HUB_AUTH_TOKEN: SECRET_IN_ENV }, cwd: box.cwd });
      expect(resolved.binding?.hubUrl).toBe(extra.UB_HUB_URL ?? first);
      expect(resolved.env.HUB_ADMISSION).toBe("device");
      expect(resolved.env.HUB_AUTH_TOKEN).toBeUndefined();
      expect(resolved.origins.credential).toBeNull();
      expect(resolved.warnings).toEqual([]);
      expect(mcpConfig(resolved.env).deviceLogin).toBeDefined();
    }
  });

  it("does not carry device admission to an unrelated endpoint or the embedded local binding", () => {
    const first = "ws://localhost:8080/ws";
    const box = sandbox({
      projectBinding: { workspaceId: FROM_USER, hubUrl: first },
      userConfig: { hubAdmissions: { [first]: "device" } },
      credentials: { signingSecret: SECRET_ON_FILE },
    });
    for (const hub of ["ws://localhost:1234", "ws://localhost:8080/other", "local"]) {
      const resolved = resolveConfig({ env: { ...box.env, UB_WORKSPACE_ID: FROM_ENV, UB_HUB_URL: hub, HUB_ADMISSION: "device" }, cwd: box.cwd });
      expect(resolved.env.HUB_ADMISSION).toBeUndefined();
      expect(resolved.env.HUB_AUTH_TOKEN).toBe(SECRET_ON_FILE);
      expect(mcpConfig(resolved.env).deviceLogin).toBeUndefined();
    }
  });

  it("uses legacy admission only for its validated matching endpoint and never for selection", () => {
    const legacyHub = "http://localhost:8080/custom-path";
    const endpoint = "ws://localhost:8080/custom-path";
    const box = unboundSandbox({
      userConfig: { workspace: FROM_USER, hubUrl: legacyHub, hubAdmission: "device" },
      credentials: { signingSecret: SECRET_ON_FILE },
    });
    const unbound = resolveConfig({ env: box.env, cwd: box.cwd });
    expect(unbound.binding).toBeNull();
    expect(unbound.env.HUB_ADMISSION).toBeUndefined();
    for (const hub of [endpoint, "ws://localhost:1234"]) {
      const resolved = resolveConfig({ env: { ...box.env, UB_WORKSPACE_ID: FROM_ENV, UB_HUB_URL: hub }, cwd: box.cwd });
      expect(resolved.env.HUB_ADMISSION).toBe(hub === endpoint ? "device" : undefined);
      expect(resolved.env.HUB_AUTH_TOKEN).toBe(hub === endpoint ? undefined : SECRET_ON_FILE);
    }
  });

  it("does not echo or use unsafe legacy admission endpoints", () => {
    const box = sandbox({
      projectBinding: { workspaceId: FROM_USER, hubUrl: "ws://localhost:1234" },
      userConfig: { hubUrl: "http://user:PRIVATE_SENTINEL@localhost:1234/ws", hubAdmission: "device" },
      credentials: { signingSecret: SECRET_ON_FILE },
    });
    const resolved = resolveConfig({ env: box.env, cwd: box.cwd });
    expect(resolved.env.HUB_ADMISSION).toBeUndefined();
    expect(resolved.env.HUB_AUTH_TOKEN).toBe(SECRET_ON_FILE);
    expect(resolved.warnings.join(" ")).not.toContain("PRIVATE_SENTINEL");
  });

  it("does not use a legacy workspace or hub, and does not pass either to children", () => {
    const box = unboundSandbox({ userConfig: { workspace: FROM_USER, hubUrl: "wss://old.example.test/ws" } });
    const resolved = resolveConfig({ env: box.env, cwd: box.cwd });
    expect(resolved.binding).toBeNull();
    expect(resolved.env.WORKSPACE_ID).toBeUndefined();
    expect(resolved.env.HUB_URL).toBeUndefined();
    expect(resolved.warnings.join("\n")).toMatch(/Legacy machine/);
  });

  it("resolves the complete project pair and preserves the decorated ID", () => {
    const workspaceId = `team-${FROM_USER}`;
    const box = sandbox({ projectBinding: { workspaceId, hubUrl: "https://hub.example.test" } });
    const resolved = resolveConfig({ env: box.env, cwd: box.cwd });
    expect(resolved.binding).toEqual({ workspaceId, hubUrl: "wss://hub.example.test/ws" });
    expect(mcpConfig(resolved.env).workspaceId).toBe(FROM_USER);
    expect(resolved.env.UB_HUB_URL).toBe("wss://hub.example.test/ws");
    expect(resolved.origins.workspace).toBe("project config");
    expect(resolved.origins.hubUrl).toBe("project config");
  });

  it("uses an entire environment pair without mixing with the project", () => {
    const box = sandbox({ projectBinding: { workspaceId: FROM_USER, hubUrl: "https://project.example.test" } });
    const resolved = resolveConfig({ env: { ...box.env, UB_WORKSPACE_ID: FROM_ENV, UB_HUB_URL: "local" }, cwd: box.cwd });
    expect(resolved.binding).toEqual({ workspaceId: FROM_ENV, hubUrl: null });
    expect(resolved.env.HUB_URL).toBeUndefined();
    expect(mcpConfig(resolved.env).hubUrl).toBe(DEFAULT_HUB_URL);
    expect(resolved.origins.workspace).toBe("environment");
    expect(resolved.origins.hubUrl).toBe("environment");
  });

  it("never forwards the local signing secret to a remote hub", () => {
    const box = sandbox({ projectBinding: { workspaceId: FROM_USER, hubUrl: "https://hub.example.test" }, credentials: { signingSecret: SECRET_ON_FILE } });
    const resolved = resolveConfig({ cwd: box.cwd,
      env: { ...box.env, HUB_AUTH_TOKEN: SECRET_IN_ENV } });
    expect(resolved.env.HUB_AUTH_TOKEN).toBeUndefined();
    expect(resolved.origins.credential).toBeNull();
    expect(mcpConfig(resolved.env).authSecret).toBeNull();
    expect(mcpConfig(resolved.env).deviceLogin).toBeDefined();
    expect(tracesOf(SECRET_ON_FILE, JSON.stringify(resolved.warnings))).toEqual([]);
  });

  it("takes the signing secret from credentials.json, and the environment first", () => {
    const box = sandbox({ credentials: { signingSecret: "from-file" } });

    const fromFile = resolveConfig({ env: box.env, cwd: box.cwd });
    expect(fromFile.origins.credential).toBe("credentials file");
    expect(mcpConfig(fromFile.env).authSecret).toBe("from-file");

    const fromEnv = resolveConfig({
      cwd: box.cwd,
      env: { ...box.env, HUB_AUTH_TOKEN: "from-env" },
    });
    expect(fromEnv.origins.credential).toBe("environment");
    expect(mcpConfig(fromEnv.env).authSecret).toBe("from-env");
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
      cwd: box.cwd,
      env: { ...box.env, HUB_AUTH_TOKEN: "from-env" },
    });
    expect(fromEnv.origins.credential).toBe("environment");
    expect(mcpConfig(fromEnv.env).authSecret).toBe("from-env");
    expect(fromEnv.warnings.join("\n")).toMatch(/refusing/);
    // And one warning, not two: a refused file is not also a layer disagreeing
    // with the environment. The mode is the one actionable thing about it.
    expect(fromEnv.warnings).toHaveLength(1);
    expect(fromEnv.shadowed).toEqual([]);
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
      const resolved = resolveConfig({ env: box.env, cwd: box.cwd });

      expect(resolved.warnings.join("\n")).toMatch(/: invalid JSON$/);
      expect(resolved.warnings.join("\n")).not.toContain(secret);
      expect(resolved.origins.credential).toBeNull();
    }
  });

  it("refuses a signing secret in a file that is not credentials.json", () => {
    const box = sandbox({ userConfig: { signingSecret: "nope" } });
    const resolved = resolveConfig({ env: box.env, cwd: box.cwd });

    expect(resolved.warnings.join("\n")).toMatch(/credentials\.json/);
    expect(mcpConfig(resolved.env).authSecret).toBeNull();
  });

  it("warns that two signing secrets differ, in one fixed sentence", () => {
    const box = sandbox({ credentials: { signingSecret: SECRET_ON_FILE } });
    const resolved = resolveConfig({
      cwd: box.cwd,
      env: { ...box.env, HUB_AUTH_TOKEN: SECRET_IN_ENV },
    });

    // The whole warning, asserted whole. Nothing in it is derived from either
    // secret, and equality is what keeps it that way: a length, a prefix or a
    // digest added later fails here rather than shipping. The path is the one
    // interpolation, and it comes from the resolver so the two cannot drift.
    // `ub init`'s own refusal ends the same way, so they tell one story.
    expect(resolved.warnings).toEqual([
      "HUB_AUTH_TOKEN in the environment is in force; " +
        `${credentialsPath(box.env)} holds a different signing secret — ` +
        "make them equal, or unset one",
    ]);
    // And nothing of either value survives anywhere in it — not a fragment,
    // not a size. (`ub status`'s own output is checked in storage.test.ts.)
    expect(tracesOf(SECRET_IN_ENV, resolved.warnings.join("\n"))).toEqual([]);
    expect(tracesOf(SECRET_ON_FILE, resolved.warnings.join("\n"))).toEqual([]);

    expect(mcpConfig(resolved.env).authSecret).toBe(SECRET_IN_ENV);
    expect(resolved.shadowed).toEqual([
      { setting: "credential", layer: "credentials file" },
    ]);

    // Equal layers are not a conflict — the common case of `fnox exec` handing
    // over the very secret `ub init` wrote.
    const agreeing = resolveConfig({
      cwd: box.cwd,
      env: { ...box.env, HUB_AUTH_TOKEN: SECRET_ON_FILE },
    });
    expect(agreeing.warnings).toEqual([]);
    expect(agreeing.shadowed).toEqual([]);
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

describe("the committed mise config", () => {
  // Belt and braces beside the resolution above. `ub` ignores an ambient
  // `HUB_URL` outright now, but the checkout tasks hand their environment to
  // programs that do read it — vite bakes it into a dev bundle — so a committed
  // endpoint here would still bind a checkout to whatever the repository
  // guessed (#376, #385). The address belongs in the clients' code as a
  // fallback, and the real one in this machine's `config.json`, which the resolver
  // is what puts in front of a task.
  it("exports no HUB_URL, so a checkout binds no endpoint", () => {
    const assignments = readFileSync(join(REPO_ROOT, "mise.toml"), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .filter((line) => /\bHUB_URL\s*=/.test(line));

    expect(assignments).toEqual([]);
  });
});
