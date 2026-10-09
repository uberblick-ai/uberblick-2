/** Remote sign-in contracts across the real CLI, HTTP hub and owner-only store. */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveMcpConfig } from "@uberblick/mcp-server";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { authenticationOrigin } from "../src/auth.js";
import { resolveConfig } from "../src/config.js";
import { parseJoinTarget } from "../src/remote.js";
import {
  DEAD_HUB_URL, removeTempDirs, runUbAsync, sandbox, sleep, UB_BIN, unboundSandbox, waitUntil,
  type Run,
} from "./helpers.js";
import {
  OTHER_HUB, OTHER_WORKSPACE, SIGNING_SECRET, GITHUB_TOKEN, USERNAME, WORKSPACE,
  assertPublicOnly, cleanUp, configPath, credentialPath, fixture, privateDeviceRows,
  readStore, rig, savedLogin,
} from "./auth-fixtures.js";

afterEach(cleanUp);
afterAll(removeTempDirs);

describe("ub auth local selection and command surface", () => {
  it("provides progressive help and refuses unsupported usage without writing", async () => {
    const box = sandbox();
    const root = await runUbAsync(["--help"], box);
    expect(root.stdout.match(/^ {2}auth\s/gm)).toHaveLength(1);
    for (const args of [["auth"], ["auth", "login"], ["auth", "status"], ["auth", "logout"]]) {
      const help = await runUbAsync([...args, "--help"], box);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain(`ub ${args.join(" ")}`);
      expect(help.stderr).toBe("");
      if (args[1] === "login") {
        expect(help.stdout).toContain("Login never changes the project binding.");
        expect(help.stdout).toContain("Signing in grants no workspace membership");
        expect(help.stdout).toMatch(/revok.*replac|replac.*revok/i);
        expect(help.stdout.replace(/\s+/g, " ")).toMatch(/approve only a code you just started/i);
        expect(help.stdout.replace(/\s+/g, " ")).toMatch(/first.*account.*approv.*claim.*default workspace.*admin/i);
      }
      if (args[1] === "logout") expect(help.stdout).toContain("--all-devices");
    }
    for (const args of [["auth", "unknown"], ["auth", "login", "--json"], ["auth", "logout", "a", "b"],
      ["auth", "login", "--all-devices"], ["auth", "status", "--all-devices"], ["auth", "logout", "--unknown"]]) {
      const run = await runUbAsync(args, box);
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).not.toBe("");
    }
    expect(existsSync(credentialPath(box))).toBe(false);
  });

  it("refuses legacy ambient hub selection and keeps local work quiet without it", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null }, userConfig: { workspace: WORKSPACE } });
    for (const subcommand of ["login", "status", "logout"]) {
      const run = await runUbAsync(["auth", subcommand], box, { HUB_URL: "ws://ambient.invalid" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("Legacy WORKSPACE_ID / HUB_URL selection is no longer supported");
      expect(run.output).not.toContain("ambient.invalid");
      const local = await runUbAsync(["auth", subcommand], box);
      expect(local.status).toBe(1);
      expect(local.stderr).toMatch(/local.only.*no login|local.only.*no sign.in/i);
    }
    const status = await runUbAsync(["status"], box);
    expect(status.output).not.toMatch(/auth login|sign.in/i);
    expect(existsSync(credentialPath(box))).toBe(false);
  });

  it("never uses a legacy machine hub and resolves a complete environment pair for implicit auth", async () => {
    const origin = "https://selected.example.test";
    const box = unboundSandbox({
      userConfig: { workspace: WORKSPACE, hubUrl: "https://legacy.example.test" },
      credentials: { hubLogins: { [origin]: fixture() } },
    });
    const unbound = await runUbAsync(["auth", "status"], box);
    expect(unbound.status).toBe(1);
    expect(unbound.stderr).toContain("no hub given and none bound");
    expect(existsSync(join(box.cwd, ".uberblick.json"))).toBe(false);
    const selected = await runUbAsync(["auth", "status"], box, {
      UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: origin,
    });
    expect(selected.status, selected.output).toBe(0);
    expect(selected.stdout).toContain(origin);
    expect(selected.stdout).not.toContain("legacy.example.test");
    expect(existsSync(join(box.cwd, ".uberblick.json"))).toBe(false);
  });

  it("refuses malformed project selection for an implicit hub but permits an explicit login target", async () => {
    const origin = "https://hub.example.test";
    const box = sandbox({ raw: { projectBinding: '{"workspaceId":' },
      credentials: { hubLogins: { [origin]: fixture() } },
    });
    const implicit = await runUbAsync(["auth", "status"], box);
    expect(implicit.status).toBe(1);
    expect(implicit.stderr).toContain(".uberblick.json");
    const explicit = await runUbAsync(["auth", "status", origin], box);
    expect(explicit.status, explicit.output).toBe(0);
    expect(explicit.stdout).toContain(origin);
    expect(explicit.stdout).toContain("previous-user");
  });

  it("finds one offline login across host case, default-port and endpoint spellings without rebinding", async () => {
    const origin = "https://hub.example.ts.net";
    const endpoint = "wss://Hub.Example.TS.net:443/ws";
    const old = fixture();
    const other = fixture([]);
    const box = sandbox({ projectBinding: { workspaceId: `project-${WORKSPACE}`, hubUrl: endpoint },
      userConfig: { workspace: WORKSPACE, hubUrl: endpoint },
      credentials: { signingSecret: SIGNING_SECRET, hubLogins: { [origin]: old, [OTHER_HUB]: other } },
    });
    const binding = readFileSync(configPath(box));
    for (const spelling of [undefined, "Hub.Example.TS.net:443", "https://Hub.Example.TS.net:443", endpoint]) {
      const run = await runUbAsync(["auth", "status", ...(spelling ? [spelling] : [])], box);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toBe(`hub        ${origin}\nsigned in  previous-user\navailable workspaces:\n  ${WORKSPACE}\n`);
      expect(run.stderr).toBe("");
      expect(run.output.includes(old.credential.key)).toBe(false);
    }
    const logout = await runUbAsync(["auth", "logout", "Hub.Example.TS.net:443"], box);
    expect(logout.status).toBe(1);
    expect(logout.stderr).toContain(`ub auth logout --all-devices ${origin}`);
    expect(logout.stdout).toBe(`removed    login for ${origin} on this computer\n`);
    expect(readStore(box)).toEqual({ signingSecret: SIGNING_SECRET, hubLogins: { [OTHER_HUB]: other } });
    expect(readFileSync(configPath(box))).toEqual(binding);
    const missing = await runUbAsync(["auth", "status"], box);
    expect(missing.status).toBe(1);
    expect(missing.output).toMatch(/no.*login|not.*signed/i);
    expect(missing.output).toContain("ub auth login");
    expect(missing.output).not.toContain(OTHER_HUB);
  });

  it.each([
    { workspaceId: OTHER_WORKSPACE, workspaces: [] },
    { workspaceId: `project-${OTHER_WORKSPACE}`, workspaces: [WORKSPACE] },
  ])("explains missing project workspace access for $workspaceId with snapshot $workspaces", async ({ workspaceId, workspaces }) => {
    const box = sandbox({ projectBinding: { workspaceId, hubUrl: DEAD_HUB_URL },
      userConfig: { workspace: OTHER_WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { hubLogins: { "http://127.0.0.1:1": fixture(workspaces) } },
    });
    const before = readFileSync(credentialPath(box), "utf8");
    const status = await runUbAsync(["auth", "status"], box);
    expect(status.status).toBe(0);
    expect(status.stdout).toBe(`hub        http://127.0.0.1:1\nsigned in  previous-user\n${workspaces.length === 0
      ? "available workspaces: none\n" : `available workspaces:\n  ${WORKSPACE}\n`}\n` +
      `You might have expected access to ${OTHER_WORKSPACE} as per your .uberblick.json.\n` +
      "But previous-user has no access to this workspace, or it simply doesn't exist on this hub.\n" +
      "Ask a workspace admin to grant you access: `ub workspace member add previous-user`\n");
    expect(status.stderr).toBe("");
    expect(readFileSync(credentialPath(box), "utf8")).toBe(before);
  });

  it("names the environment override as the source of the missing workspace", async () => {
    const origin = "http://127.0.0.1:1";
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: OTHER_HUB },
      credentials: { hubLogins: { [origin]: fixture() } },
    });
    const status = await runUbAsync(["auth", "status"], box, {
      UB_WORKSPACE_ID: `override-${OTHER_WORKSPACE}`, UB_HUB_URL: DEAD_HUB_URL,
    });
    expect(status.status).toBe(0);
    expect(status.stdout).toBe(`hub        ${origin}\nsigned in  previous-user\navailable workspaces:\n  ${WORKSPACE}\n\n` +
      `You might have expected access to ${OTHER_WORKSPACE} as per your UB_WORKSPACE_ID.\n` +
      "But previous-user has no access to this workspace, or it simply doesn't exist on this hub.\n" +
      "Ask a workspace admin to grant you access: `ub workspace member add previous-user`\n");
    expect(status.stderr).toBe("");
  });

  it("omits the missing-workspace note when showing another hub", async () => {
    const box = sandbox({ projectBinding: { workspaceId: OTHER_WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { hubLogins: { [OTHER_HUB]: fixture([]) } },
    });
    const status = await runUbAsync(["auth", "status", OTHER_HUB], box);
    expect(status.status).toBe(0);
    expect(status.stdout).toBe(`hub        ${OTHER_HUB}\nsigned in  previous-user\navailable workspaces: none\n`);
    expect(status.stderr).toBe("");
  });

  it("lists each stored workspace on its own row without contacting the hub", async () => {
    const box = sandbox({ credentials: { hubLogins: { [OTHER_HUB]: fixture([WORKSPACE, OTHER_WORKSPACE]) } } });
    const status = await runUbAsync(["auth", "status", OTHER_HUB], box);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toBe(`hub        ${OTHER_HUB}\nsigned in  previous-user\navailable workspaces:\n  ${WORKSPACE}\n  ${OTHER_WORKSPACE}\n`);
    expect(status.stderr).toBe("");
  });

  it("shows safe stored names in credential order and leaves stored bytes unchanged", async () => {
    const old = fixture([WORKSPACE, OTHER_WORKSPACE]);
    const login = { ...old, credential: { ...old.credential, workspaceNames: {
      [WORKSPACE]: 'Synthetic 🧭 "workspace" \\',
      [OTHER_WORKSPACE]: "unsafe\u009bname",
      "aaaaaaaa-1111-4111-8111-111111111111": "Not in credential",
    } } };
    const box = sandbox({ credentials: { hubLogins: { [OTHER_HUB]: login } } });
    const before = readFileSync(credentialPath(box), "utf8");
    const status = await runUbAsync(["auth", "status", OTHER_HUB], box);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toBe(`hub        ${OTHER_HUB}\nsigned in  previous-user\navailable workspaces:\n  ${WORKSPACE} | Synthetic 🧭 "workspace" \\\n  ${OTHER_WORKSPACE}\n`);
    expect(status.stderr).toBe("");
    expect(readFileSync(credentialPath(box), "utf8")).toBe(before);
  });

  it("keeps malformed names and names without issued workspaces out of status rows", async () => {
    for (const [workspaces, workspaceNames] of [
      [[WORKSPACE], "not a map"], [[], { [WORKSPACE]: "Not issued" }],
    ] as const) {
      const old = fixture([...workspaces]);
      const login = { ...old, credential: { ...old.credential, workspaceNames } };
      const box = sandbox({ credentials: { hubLogins: { [OTHER_HUB]: login } } });
      const status = await runUbAsync(["auth", "status", OTHER_HUB], box);
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toBe(`hub        ${OTHER_HUB}\nsigned in  previous-user\n${workspaces.length === 0
        ? "available workspaces: none\n" : `available workspaces:\n  ${WORKSPACE}\n`}`);
      expect(status.stderr).toBe("");
    }
  });

  it.each([false, true])("quotes and escapes stored usernames in status with missing workspace %s", async (bound) => {
    const old = fixture([]);
    old.identity.githubUsername = `synthetic"\\user\n\u001b\u007f${String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 0x80))}`;
    const escaped = `"synthetic\\"\\\\user\\n\\u001b\\u007f${Array.from({ length: 32 }, (_, index) => `\\u${(index + 0x80).toString(16).padStart(4, "0")}`).join("")}"`;
    const box = (bound ? sandbox : unboundSandbox)({ credentials: { hubLogins: { [OTHER_HUB]: old } },
      ...(bound ? { projectBinding: { workspaceId: WORKSPACE, hubUrl: OTHER_HUB } } : {}),
    });
    expect(existsSync(join(box.cwd, ".uberblick.json"))).toBe(bound);
    const status = await runUbAsync(["auth", "status", OTHER_HUB], box);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toBe(`hub        ${OTHER_HUB}\nsigned in  ${escaped}\navailable workspaces: none\n` + (bound
      ? `\nYou might have expected access to ${WORKSPACE} as per your .uberblick.json.\n` +
        `But ${escaped} has no access to this workspace, or it simply doesn't exist on this hub.\n` +
        `Ask a workspace admin to grant you access: \`ub workspace member add ${escaped}\`\n`
      : ""));
    expect(status.stderr).toBe("");
  });

  it("refuses exposed local credentials without presenting identity as signed in", async () => {
    const origin = "http://127.0.0.1:1";
    const old = fixture();
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { hubLogins: { [origin]: old } },
    });
    chmodSync(credentialPath(box), 0o644);
    const run = await runUbAsync(["auth", "status"], box);
    expect(run.status).toBe(1);
    expect(run.output).not.toContain(old.identity.githubUsername);
    expect(run.output).toContain("ub auth login");
    expect(run.output).toMatch(/chmod.*600/);
  });

  it.each(["missing", "unreadable", "revoked", "invalid bound workspace"])("keeps %s status failures on stderr with exit 1", async (kind) => {
    const old = fixture();
    const login = kind === "revoked"
      ? { ...old, credential: { ...old.credential, record: { ...old.credential.record, revokedAt: Date.now() } } }
      : old;
    const box = sandbox({
      ...(kind === "missing" ? {} : { credentials: { hubLogins: { [OTHER_HUB]: login } } }),
      ...(kind === "unreadable" ? { raw: { credentials: "{broken" } } : {}),
      ...(kind === "revoked" ? { projectBinding: { workspaceId: OTHER_WORKSPACE, hubUrl: OTHER_HUB } } : {}),
      ...(kind === "invalid bound workspace" ? { projectBinding: { workspaceId: "not-a-workspace", hubUrl: OTHER_HUB } } : {}),
    });
    const status = await runUbAsync(["auth", "status", ...(kind === "invalid bound workspace" ? [] : [OTHER_HUB])], box);
    expect(status.status).toBe(1);
    const expected = kind === "missing" ? "no login stored"
      : kind === "unreadable" ? "stored login unreadable"
      : kind === "revoked" ? "recorded as revoked" : "workspaceId";
    expect(status.stderr).toContain(expected);
    expect(status.stdout).not.toContain(expected);
    if (kind === "revoked") {
      expect(status.stdout).toBe(`hub        ${OTHER_HUB}\nsigned in  previous-user\navailable workspaces:\n  ${WORKSPACE}\n`);
      expect(status.stderr).toBe(`ub auth: this stored credential is recorded as revoked. Run \`ub auth login ${OTHER_HUB}\`.\n`);
    }
  });
});

describe("hub-driven CLI GitHub sign-in", () => {
  it("claims a fresh deployed hub before storing its workspace credential and leaves the binding unchanged", async () => {
    const remote = await rig([], true, true);
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL }, userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const binding = readFileSync(configPath(box));
    const login = await runUbAsync(["auth", "login", remote.origin], box);
    expect(login.status, login.stderr).toBe(0);
    const stored = savedLogin(box, remote.origin);
    const workspace = stored.credential.record.workspaces[0];
    expect(stored.credential.record.workspaces).toHaveLength(1);
    expect(workspace).toMatch(/^[0-9a-f-]{36}$/);
    expect(workspace).not.toBe(WORKSPACE);
    expect(login.stdout).toBe(`hub        ${remote.origin}\napprove only a code you just started yourself\nthis hub is unclaimed: the first account to approve becomes its admin\nopen       https://github.com/login/device\ncode       ABCD-EFGH\nwaiting for approval…\nsigned in  ${USERNAME} on ${remote.origin}\nclaimed    default workspace (${workspace}), you are admin\navailable workspaces:\n  ${workspace} | Default workspace\nUse it here: ub workspace use ${remote.origin.replace("http:", "ws:")}/ws/${workspace}\n`);
    expect(login.stderr).toBe("");
    expect(readFileSync(configPath(box))).toEqual(binding);
    expect(remote.requests[0]).toMatchObject({ path: "/auth/claim-state", method: "GET", body: {} });
    const again = await runUbAsync(["auth", "login", remote.origin], box);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).not.toContain("this hub is unclaimed");
    expect(again.stdout).not.toContain("claimed    ");
    expect(again.stdout).not.toContain("Use it here:");
    expect(login.stdout).not.toContain("ub open");
    expect(savedLogin(box, remote.origin).credential.record.workspaces).toEqual([workspace]);
    expect(readFileSync(configPath(box))).toEqual(binding);
    assertPublicOnly(login, remote, stored.credential.key);
  });

  it.each([
    { name: "unbound project", source: "unbound", workspace: WORKSPACE, sameHub: true, next: true },
    { name: "matching project", source: "project", workspace: WORKSPACE, sameHub: true, next: false },
    { name: "matching slug-decorated project", source: "project", workspace: `test-${WORKSPACE}`, sameHub: true, next: false },
    { name: "different project workspace", source: "project", workspace: OTHER_WORKSPACE, sameHub: true, next: true },
    { name: "different project hub", source: "project", workspace: WORKSPACE, sameHub: false, next: true },
    { name: "matching environment", source: "environment", workspace: WORKSPACE, sameHub: true, next: false },
    { name: "overriding environment workspace", source: "environment", workspace: OTHER_WORKSPACE, sameHub: true, next: true },
    { name: "overriding environment hub", source: "environment", workspace: WORKSPACE, sameHub: false, next: true },
  ])("prints the claim command only when needed for a $name", async ({ source, workspace, sameHub, next }) => {
    const remote = await rig([WORKSPACE]);
    remote.controls.transform = (path, status, result) => path === "/auth/github/collect" && result.status === "complete"
      ? { status, result: { ...result, claimedWorkspaceId: WORKSPACE } } : { status, result };
    const endpoint = `${remote.origin.replace("http:", "ws:")}/custom//ws`;
    const binding = { workspaceId: workspace, hubUrl: sameHub ? remote.origin : OTHER_HUB };
    const box = source === "unbound" ? unboundSandbox() : sandbox({ projectBinding: source === "project" ? binding
      : { workspaceId: OTHER_WORKSPACE, hubUrl: OTHER_HUB } });
    const path = join(box.cwd, ".uberblick.json");
    const before = existsSync(path) ? readFileSync(path) : null;
    const login = await runUbAsync(["auth", "login", endpoint], box, source === "environment"
      ? { UB_WORKSPACE_ID: workspace, UB_HUB_URL: binding.hubUrl } : {});
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout).toContain(`claimed    default workspace (${WORKSPACE}), you are admin\n`);
    const action = login.stdout.match(/^Use it here: ub workspace use (.+)$/m);
    expect(action !== null).toBe(next);
    if (action !== null) expect(parseJoinTarget(action[1]!)).toEqual({ endpoint, workspace: WORKSPACE });
    expect(login.stdout).not.toContain("ub open");
    expect(existsSync(path) ? readFileSync(path) : null).toEqual(before);
  });

  it("prints a claimed-workspace command that writes the login's custom endpoint when run", async () => {
    const remote = await rig([], true, true, true);
    const endpoint = `ws://127.0.0.1:${remote.hub.port}/custom//ws`;
    const box = unboundSandbox();
    const login = await runUbAsync(["auth", "login", endpoint], box);
    expect(login.status, login.stderr).toBe(0);
    const link = login.stdout.match(/^Use it here: ub workspace use (.+)$/m)?.[1];
    expect(link).toBeDefined();
    const workspace = savedLogin(box, authenticationOrigin(endpoint)).credential.record.workspaces[0];
    expect(parseJoinTarget(link!)).toEqual({ endpoint, workspace });
    expect(existsSync(join(box.cwd, ".uberblick.json"))).toBe(false);
    const joined = await runUbAsync(["workspace", "use", link!], box);
    expect(joined.status, joined.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8"))).toEqual({ workspaceId: workspace, hubUrl: endpoint });
  });

  it("uses the bound endpoint for an implicit login's claim command", async () => {
    const remote = await rig([WORKSPACE]);
    remote.controls.transform = (path, status, result) => path === "/auth/github/collect" && result.status === "complete"
      ? { status, result: { ...result, claimedWorkspaceId: WORKSPACE } } : { status, result };
    const endpoint = `${remote.origin.replace("http:", "ws:")}/proxy/ws`;
    const box = sandbox({ projectBinding: { workspaceId: OTHER_WORKSPACE, hubUrl: endpoint } });
    const login = await runUbAsync(["auth", "login"], box);
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout).toContain(`Use it here: ub workspace use ${endpoint}/${WORKSPACE}\n`);
  });

  it("keeps shell-sensitive endpoint paths in one literal operand when the claim command is pasted", async () => {
    const remote = await rig([WORKSPACE]);
    remote.controls.transform = (path, status, result) => path === "/auth/github/collect" && result.status === "complete"
      ? { status, result: { ...result, claimedWorkspaceId: WORKSPACE } } : { status, result };
    const endpoint = `${remote.origin.replace("http:", "ws:")}/custom path/O'Reilly;literal&dollar$test`;
    const login = await runUbAsync(["auth", "login", endpoint], unboundSandbox());
    expect(login.status, login.stderr).toBe(0);
    const command = login.stdout.match(/^Use it here: (.+)$/m)?.[1];
    expect(command).toBeDefined();
    const pasted = spawnSync("/bin/sh", ["-c", `ub() { printf '%s\\n' "$@"; }\n${command}`], { encoding: "utf8", timeout: 5_000 });
    expect(pasted.status, pasted.stderr).toBe(0);
    expect(pasted.stdout).toBe(`workspace\nuse\n${endpoint}/${WORKSPACE}\n`);
    expect(parseJoinTarget(pasted.stdout.trim().split("\n")[2]!)).toEqual({ endpoint, workspace: WORKSPACE });
  });

  it("reports ordinary completion when another account claimed after the unclaimed notice", async () => {
    const remote = await rig();
    remote.controls.transform = (path, status, result) => path === "/auth/claim-state"
      ? { status: 200, result: { unclaimed: true, canClaim: true } } : { status, result };
    const box = sandbox();
    const login = await runUbAsync(["auth", "login", remote.origin], box);
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout).toContain("this hub is unclaimed");
    expect(login.stdout).not.toContain("claimed    ");
    expect(login.stdout).toContain("available workspaces: none\n");
    expect(savedLogin(box, remote.origin).credential.record.workspaces).toEqual([]);
  });

  it("reports a committed claim independently of an earlier failed claim-state read", async () => {
    const remote = await rig([WORKSPACE]);
    remote.controls.transform = (path, status, result) => {
      if (path === "/auth/claim-state") return { status: 503, result: { unclaimed: true, canClaim: true } };
      if (path === "/auth/github/collect" && result.status === "complete") {
        return { status, result: { ...result, claimedWorkspaceId: WORKSPACE } };
      }
      return { status, result };
    };
    const login = await runUbAsync(["auth", "login", remote.origin], sandbox());
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout).not.toContain("this hub is unclaimed");
    expect(login.stdout).toContain(`signed in  ${USERNAME} on ${remote.origin}\nclaimed    default workspace (${WORKSPACE}), you are admin\n`);
  });

  it.each(["hung-body", "unexpected-field"])("continues ordinary login after a %s claim-state read without an unclaimed notice", async (kind) => {
    const remote = await rig();
    if (kind === "hung-body") remote.controls.claimStateFailure = kind;
    remote.controls.transform = (path, status, result) => {
      if (path !== "/auth/claim-state") return { status, result };
      return { status: 200, result: { unclaimed: true, canClaim: true, workspaceName: GITHUB_TOKEN } };
    };
    const box = sandbox();
    const startedAt = Date.now();
    const login = await runUbAsync(["auth", "login", remote.origin], box);
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout).not.toContain("this hub is unclaimed");
    expect(login.stdout).not.toContain("claimed    ");
    expect(login.output).not.toContain(GITHUB_TOKEN);
    expect(savedLogin(box, remote.origin).credential.record.workspaces).toEqual([]);
    if (kind === "hung-body") expect(Date.now() - startedAt).toBeLessThan(6_000);
  });

  it.each(["not-a-uuid", "not-covered"])("refuses a %s committed claim field without printing it or replacing stored credentials", async (kind) => {
    const remote = await rig();
    remote.controls.transform = (path, status, result) => {
      if (path !== "/auth/github/collect" || result.status !== "complete") return { status, result };
      const claimedWorkspaceId = kind === "not-a-uuid" ? GITHUB_TOKEN : WORKSPACE;
      return { status, result: { ...result, claimedWorkspaceId } };
    };
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    const login = await runUbAsync(["auth", "login", remote.origin], box);
    expect(login.status).toBe(1);
    expect(login.stderr).toContain("invalid sign-in claim result");
    expect(login.stdout).not.toContain("claimed    ");
    expect(login.output).not.toContain(GITHUB_TOKEN);
    expect(readFileSync(credentialPath(box))).toEqual(before);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(1);
    assertPublicOnly(login, remote);
  });

  it("selects the stored login for loopback sync without a local secret and exports no key", async () => {
    const login = fixture();
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { hubLogins: { [authenticationOrigin(DEAD_HUB_URL)]: login } },
    });
    const resolved = resolveConfig({ env: box.env, cwd: box.cwd });
    const config = resolveMcpConfig(resolved.env);
    expect(config.authSecret).toBeNull();
    expect(config.deviceLogin !== undefined, "the selected origin uses device admission").toBe(true);
    expect(Object.values(resolved.env).every((value) => !value?.includes(login.credential.key)),
      "the child environment contains no stored device key").toBe(true);
    expect(JSON.stringify(config).includes(login.credential.key),
      "MCP configuration contains no stored device key").toBe(false);

    const status = await runUbAsync(["status", "--json"], box);
    expect(status.status, status.stderr).toBe(0);
    const report = JSON.parse(status.stdout);
    expect(report.credentialPresent).toBe(true);
    expect(report.hub.status).toBe("hub-down");
    const snippet = await runUbAsync(["mcp", "install", "zed", "--print"], box);
    expect(snippet.status, snippet.stderr).toBe(0);
    for (const output of [status.output, snippet.output, readFileSync(configPath(box), "utf8")]) {
      expect(output.includes(login.credential.key), "the device key stays in its owner-only store").toBe(false);
    }
  });

  it("stores identity and every issued workspace privately, preserving binding and other hubs", async () => {
    const remote = await rig([WORKSPACE, OTHER_WORKSPACE]);
    const other = fixture([]);
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: `${remote.origin.replace("http:", "ws:")}/ws` },
      userConfig: { workspace: WORKSPACE, hubUrl: `${remote.origin.replace("http:", "ws:")}/ws` },
      credentials: { signingSecret: SIGNING_SECRET, hubLogins: { [OTHER_HUB]: other } },
    });
    const before = readFileSync(configPath(box));
    const login = await runUbAsync(["auth", "login"], box);
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout).toBe(`hub        ${remote.origin}\napprove only a code you just started yourself\nopen       https://github.com/login/device\ncode       ABCD-EFGH\nwaiting for approval…\nsigned in  ${USERNAME} on ${remote.origin}\navailable workspaces:\n  ${OTHER_WORKSPACE}\n  ${WORKSPACE}\n`);
    expect(login.stderr).toBe("");
    const stored = savedLogin(box, remote.origin);
    expect(stored.identity).toMatchObject({ githubAccountId: "1234", githubUsername: USERNAME });
    expect(stored.credential.record.workspaces).toEqual([OTHER_WORKSPACE, WORKSPACE].sort());
    expect(stored.credential.record.principalId).toBe(stored.identity.id);
    expect(stored.credential.key.length).toBe(43);
    expect(readStore(box).hubLogins?.[OTHER_HUB]).toEqual(other);
    expect(readStore(box).signingSecret).toBe(SIGNING_SECRET);
    expect(statSync(credentialPath(box)).mode & 0o077).toBe(0);
    expect(readFileSync(configPath(box))).toEqual(before);
    assertPublicOnly(login, remote, stored.credential.key);
    for (const request of remote.requests) {
      expect(request.method).toBe(request.path === "/auth/claim-state" ? "GET" : "POST");
      expect(request.authorization).toBeUndefined();
      expect(Object.keys(request.body).sort()).toEqual(request.path.endsWith("start") || request.path === "/auth/claim-state" ? [] : ["collectionSecret", "requestId"]);
    }
    const bridge = resolveConfig({ env: box.env, cwd: box.cwd }).env;
    const values = Object.values(bridge);
    expect(Object.values(readStore(box).hubLogins ?? {}).every(login =>
      values.every(value => !value?.includes(login.credential.key)))).toBe(true);
    expect(bridge.HUB_AUTH_TOKEN).toBeUndefined();
    expect(bridge.WORKSPACE_ID).toBe(WORKSPACE);
    expect(bridge.HUB_URL).toBe(`${remote.origin.replace("http:", "ws:")}/ws`);
    const snippet = await runUbAsync(["mcp", "install", "zed", "--print"], box);
    for (const text of [snippet.output, readFileSync(configPath(box), "utf8")]) {
      expect(text.includes(stored.credential.key), "credential key is only persisted in its private store").toBe(false);
      for (const request of remote.requests) {
        const secret = request.body.collectionSecret;
        if (typeof secret === "string") expect(text.includes(secret)).toBe(false);
      }
    }
    await remote.hub.stop();
    const requestCount = remote.requests.length;
    expect((await runUbAsync(["auth", "status"], box)).status).toBe(0);
    const logout = await runUbAsync(["auth", "logout"], box);
    expect(logout.status).toBe(1);
    expect(logout.stderr).toContain(`ub auth logout --all-devices ${remote.origin}`);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(1);
    expect(privateDeviceRows(remote.databasePath)[0]?.revoked_at).toBeNull();
    expect(readStore(box).hubLogins?.[OTHER_HUB]).toEqual(other);
    expect(readFileSync(configPath(box))).toEqual(before);
    expect(remote.requests).toHaveLength(requestCount + 1);
    expect(remote.requests.at(-1)).toMatchObject({ path: "/auth/manage", body: { operation: "revoke-device" } });
  });

  it("stores and prints only safe collected names, excluding flow and credential secrets", async () => {
    const workspaces = Array.from({ length: 6 }, (_, index) =>
      `aaaaaaaa-1111-4111-8111-${String(index + 1).padStart(12, "0")}`);
    const remote = await rig(workspaces);
    const name = 'Synthetic 🧭 "workspace" \\';
    remote.controls.transform = (path, status, result, body) => {
      if (path !== "/auth/github/collect" || result.status !== "complete") return { status, result };
      const credential = result.credential as { key: string };
      const values = [name, "unsafe\u009bname", "unsafe\u202ename", " padded ",
        `key ${credential.key}`, `secret ${String(body.collectionSecret)}`];
      return { status, result: { ...result, credential: { ...credential,
        workspaceNames: { ...Object.fromEntries(workspaces.map((workspace, index) => [workspace, values[index]])),
          [OTHER_WORKSPACE]: "Not issued" },
      } } };
    };
    const box = sandbox();
    const login = await runUbAsync(["auth", "login", remote.origin], box);
    expect(login.status, login.stderr).toBe(0);
    const stored = savedLogin(box, remote.origin);
    expect((stored.credential as typeof stored.credential & { workspaceNames?: unknown }).workspaceNames)
      .toEqual({ [workspaces[0]!]: name });
    expect(stored.credential.record.workspaces).toEqual(workspaces);
    expect(login.stdout).toContain(`available workspaces:\n  ${workspaces[0]} | ${name}\n${workspaces.slice(1).map(workspace => `  ${workspace}\n`).join("")}`);
    assertPublicOnly(login, remote, stored.credential.key);
    const requestCount = remote.requests.length;
    const status = await runUbAsync(["auth", "status", remote.origin], box);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`  ${workspaces[0]} | ${name}\n`);
    expect(remote.requests).toHaveLength(requestCount);
  });

  it("signs in with zero workspaces and leaves a different hub binding unchanged", async () => {
    const remote = await rig();
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL }, userConfig: { workspace: WORKSPACE, hubUrl: DEAD_HUB_URL } });
    const binding = readFileSync(configPath(box));
    const login = await runUbAsync(["auth", "login", remote.origin], box);
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout).toBe(`hub        ${remote.origin}\napprove only a code you just started yourself\nopen       https://github.com/login/device\ncode       ABCD-EFGH\nwaiting for approval…\nsigned in  ${USERNAME} on ${remote.origin}\navailable workspaces: none\n`);
    expect(login.stderr).toBe("");
    expect(savedLogin(box, remote.origin).credential.record.workspaces).toEqual([]);
    const status = await runUbAsync(["auth", "status", remote.origin], box);
    expect(status.status).toBe(0);
    expect(status.stdout).toBe(`hub        ${remote.origin}\nsigned in  ${USERNAME}\navailable workspaces: none\n`);
    expect(status.stderr).toBe("");
    const logout = await runUbAsync(["auth", "logout", remote.origin], box);
    expect(logout.status).toBe(0);
    expect(logout.stdout).toBe(`revoked    this computer on ${remote.origin}\nremoved    login for ${remote.origin} on this computer\n`);
    expect(readFileSync(configPath(box))).toEqual(binding);
  });

  it("quotes an invalid collected username and escapes its controls before printing login success", async () => {
    const remote = await rig();
    const username = 'synthetic"\\user\n\u001b\u007f\u0080\u009b\u009f';
    remote.controls.transform = (path, status, result) => {
      if (path !== "/auth/github/collect" || result.status !== "complete") return { status, result };
      return { status, result: { ...result, identity: { ...(result.identity as Record<string, unknown>), githubUsername: username } } };
    };
    const box = sandbox();
    const login = await runUbAsync(["auth", "login", remote.origin], box);
    expect(login.status, login.stderr).toBe(0);
    expect(login.stdout).toBe(`hub        ${remote.origin}\napprove only a code you just started yourself\nopen       https://github.com/login/device\ncode       ABCD-EFGH\nwaiting for approval…\nsigned in  "synthetic\\"\\\\user\\n\\u001b\\u007f\\u0080\\u009b\\u009f" on ${remote.origin}\navailable workspaces: none\n`);
    expect(login.stderr).toBe("");
    expect(savedLogin(box, remote.origin).identity.githubUsername).toBe(username);
    assertPublicOnly(login, remote);
  });

  it("keeps an existing login byte-for-byte on denial and revokes it only after a replacement completes", async () => {
    const remote = await rig([WORKSPACE]);
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: remote.origin.replace("http:", "ws:") },
      userConfig: { workspace: WORKSPACE, hubUrl: remote.origin.replace("http:", "ws:") },
      credentials: { signingSecret: SIGNING_SECRET },
    });
    expect((await runUbAsync(["auth", "login"], box)).status).toBe(0);
    const before = readFileSync(credentialPath(box));
    remote.github.tokenResult = { error: "access_denied" };
    const denied = await runUbAsync(["auth", "login"], box);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toMatch(/denied/i);
    expect(readFileSync(credentialPath(box))).toEqual(before);
    remote.github.tokenResult = { access_token: GITHUB_TOKEN, token_type: "bearer", scope: "" };
    remote.github.identityHook = () => { expect(readFileSync(credentialPath(box))).toEqual(before); };
    const complete = await runUbAsync(["auth", "login"], box);
    expect(complete.status, complete.stderr).toBe(0);
    expect(savedLogin(box, remote.origin).identity.githubUsername).toBe(USERNAME);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(2);
    expect(privateDeviceRows(remote.databasePath).filter((row) => row.revoked_at === null)).toHaveLength(1);
    expect(privateDeviceRows(remote.databasePath).filter((row) => row.revoked_at !== null)).toHaveLength(1);
  });

  it.each(["denied", "unknown-request"])("reports terminal %s without storing or disturbing earlier state", async (outcome) => {
    const remote = await rig();
    const box = sandbox({ credentials: { signingSecret: SIGNING_SECRET, hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    if (outcome === "denied") remote.github.tokenResult = { error: "access_denied" };
    if (outcome === "unknown-request") remote.controls.onStart = () => remote.restart();
    const run = await runUbAsync(["auth", "login", remote.origin], box);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(outcome === "unknown-request" ? /lost|restart|unknown.request/i : new RegExp(outcome, "i"));
    expect(readFileSync(credentialPath(box))).toEqual(before);
    expect(privateDeviceRows(remote.databasePath)).toHaveLength(0);
    assertPublicOnly(run, remote);
  });

  it("refuses exposed or impossible stores before contacting the configured sign-in hub", async () => {
    const remote = await rig();
    const exposed = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } }, credentialsMode: 0o644 });
    const before = readFileSync(credentialPath(exposed));
    const refused = await runUbAsync(["auth", "login", remote.origin], exposed);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/chmod.*600/);
    expect(readFileSync(credentialPath(exposed))).toEqual(before);
    const impossible = sandbox();
    mkdirSync(impossible.configHome, { recursive: true });
    writeFileSync(join(impossible.configHome, "uberblick"), "not a directory");
    expect((await runUbAsync(["auth", "login", remote.origin], impossible)).status).toBe(1);
    expect(remote.requests).toHaveLength(0);
    expect(remote.github.calls).toHaveLength(0);
  });

  it("reports an issued device left on the hub when publication fails after collection", async () => {
    const remote = await rig([], true, true);
    let claimedWorkspace: string | undefined;
    remote.controls.transform = (path, status, result) => {
      if (path === "/auth/github/collect" && result.status === "complete" && typeof result.claimedWorkspaceId === "string") {
        claimedWorkspace = result.claimedWorkspaceId;
      }
      return { status, result };
    };
    const box = sandbox({ credentials: { signingSecret: SIGNING_SECRET, hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    const backup = `${credentialPath(box)}.previous`;
    remote.github.identityHook = () => {
      renameSync(credentialPath(box), backup);
      mkdirSync(credentialPath(box));
    };
    try {
      const run = await runUbAsync(["auth", "login", remote.origin], box);
      expect(run.status).toBe(1);
      expect(claimedWorkspace).toMatch(/^[0-9a-f-]{36}$/);
      expect(run.stdout).toBe(`hub        ${remote.origin}\napprove only a code you just started yourself\nthis hub is unclaimed: the first account to approve becomes its admin\nopen       https://github.com/login/device\ncode       ABCD-EFGH\nwaiting for approval…\n`);
      expect(run.stderr).toContain(`default workspace (${claimedWorkspace})`);
      expect(run.stderr).toContain("could not store login");
      expect(run.stderr).toMatch(/issued.*device.*remain|issued.*device.*hub|device.*remain.*hub/i);
      expect(privateDeviceRows(remote.databasePath)).toHaveLength(1);
      expect(readFileSync(backup)).toEqual(before);
      assertPublicOnly(run, remote);
    } finally {
      rmSync(credentialPath(box), { recursive: true, force: true });
      renameSync(backup, credentialPath(box));
    }
  });

  it.each(["SIGINT", "SIGTERM"] as const)("%s abandons the hub attempt and exits without a credential or keyboard input", async (signal) => {
    const remote = await rig();
    remote.github.tokenResult = { error: "authorization_pending" };
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    const child = spawn(process.execPath, [UB_BIN, "auth", "login", remote.origin], {
      cwd: box.cwd, env: box.env, timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const done = new Promise<Run>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr, output: stdout + stderr }));
    });
    try {
      await waitUntil("CLI sign-in approval code", () => stdout.includes("ABCD-EFGH"), 10_000);
      child.kill(signal);
      const run = await done;
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/interrupted/i);
      const cancellation = remote.requests.find((request) => request.path === "/auth/github/cancel");
      expect(cancellation).toBeDefined();
      if (!cancellation) throw new Error("missing cancellation request");
      expect((await (await remote.cancel(cancellation.body)).json() as { status: string }).status).toBe("abandoned");
      expect(readFileSync(credentialPath(box))).toEqual(before);
      expect(privateDeviceRows(remote.databasePath)).toHaveLength(0);
      assertPublicOnly(run, remote);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await done;
    }
  });

  it("SIGINT while start is awaiting its reply abandons the late attempt without showing an approval code", async () => {
    const remote = await rig();
    const box = sandbox({ credentials: { hubLogins: { [remote.origin]: fixture() } } });
    const before = readFileSync(credentialPath(box));
    let startEntered = false;
    let release!: () => void;
    const heldReply = new Promise<void>((resolve) => { release = resolve; });
    remote.controls.onStart = async () => { startEntered = true; await heldReply; };
    const child = spawn(process.execPath, [UB_BIN, "auth", "login", remote.origin], {
      cwd: box.cwd, env: box.env, timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const done = new Promise<Run>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr, output: stdout + stderr }));
    });
    try {
      // The real hub has created the request; the CLI has not received its
      // cancellation authority yet. Keep that response held across the signal.
      await waitUntil("hub created sign-in request before its reply", () => startEntered, 10_000);
      child.kill("SIGINT");
      await sleep(100);
      release();
      const run = await done;
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/interrupted/i);
      expect(run.stdout).not.toContain("ABCD-EFGH");
      const cancellation = remote.requests.find((request) => request.path === "/auth/github/cancel");
      expect(cancellation).toBeDefined();
      if (!cancellation) throw new Error("missing cancellation of late start reply");
      expect((await (await remote.cancel(cancellation.body)).json() as { status: string }).status).toBe("abandoned");
      expect(readFileSync(credentialPath(box))).toEqual(before);
      expect(privateDeviceRows(remote.databasePath)).toHaveLength(0);
      assertPublicOnly(run, remote);
    } finally {
      release();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await done;
    }
  });
});
