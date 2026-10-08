/** Member management across the real CLI, signed requests and a real hub. */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { writeHubLogin } from "@uberblick/hub/auth-store";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { writeHubAdmission } from "../src/config.js";
import {
  OTHER_WORKSPACE, USERNAME, WORKSPACE, assertPublicOnly, cleanUp, credentialPath,
  privateDeviceRows, rig, savedLogin,
} from "./auth-fixtures.js";
import { removeTempDirs, runUbAsync, sandbox, unboundSandbox, type Run, type Sandbox } from "./helpers.js";

afterEach(cleanUp);
afterAll(removeTempDirs);

const ACCOUNT = "5678";
const LOGIN = "Member-Agent";
type Rig = Awaited<ReturnType<typeof rig>>;

function bind(box: Sandbox, origin: string | null, workspace = WORKSPACE): void {
  writeFileSync(join(box.cwd, ".uberblick.json"), JSON.stringify({ workspaceId: workspace, hubUrl: origin }));
}

function binding(box: Sandbox): string {
  return readFileSync(join(box.cwd, ".uberblick.json"), "utf8");
}

function actions(remote: Rig, operation: string) {
  return remote.requests.filter(request => request.path === "/auth/manage" && request.body.operation === operation)
    .map(request => {
      const { token: _proof, protocolVersion: _version, ...action } = request.body;
      return action;
    });
}

function publicOutput(run: Run, remote: Rig): void {
  assertPublicOnly(run, remote, savedLogin(remote.box, remote.origin).credential.key);
  for (const request of remote.requests) {
    if (typeof request.body.token === "string") {
      expect(run.output.includes(request.body.token), "no request proof was printed").toBe(false);
    }
  }
}

async function administrator(workspaces = [WORKSPACE, OTHER_WORKSPACE], deviceCredentials = false): Promise<Rig> {
  const remote = await rig(workspaces, true, false, deviceCredentials);
  const login = await runUbAsync(["auth", "login", remote.origin], remote.box);
  expect(login.status, login.stderr).toBe(0);
  const database = new DatabaseSync(remote.databasePath);
  try { database.prepare("UPDATE hub_memberships SET role = 'admin' WHERE workspace_id = ?").run(WORKSPACE); }
  finally { database.close(); }
  bind(remote.box, remote.origin);
  remote.github.lookupHook = () => Response.json({ id: Number(ACCOUNT), login: LOGIN, type: "User" });
  remote.requests.length = 0;
  remote.github.calls.length = 0;
  return remote;
}

function member(remote: Rig, account = ACCOUNT, login = LOGIN, role: "admin" | "member" = "member", workspace = WORKSPACE) {
  const identity = remote.hub.principals!.identify(account, login);
  remote.hub.memberships!.grant({ workspaceId: workspace, principalId: identity.id, role });
  return identity;
}

/** Only terminal input is replaced; the process and its signed HTTP calls are real. */
function terminal(remote: Rig, args: string[], answer: string): Promise<Run> {
  const preload = join(remote.box.cwd, `terminal-${randomUUID()}.mjs`);
  writeFileSync(preload, `
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url);
const readline = require("node:readline/promises");
Object.defineProperty(process.stdin, "isTTY", { value: true });
readline.createInterface = () => ({
  question: async (prompt) => { process.stderr.write(prompt); return ${JSON.stringify(answer)}; },
  close: () => {},
});
syncBuiltinESMExports();
`, "utf8");
  return runUbAsync(["workspace", "member", ...args], remote.box, {
    NODE_OPTIONS: `${remote.box.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim(),
  });
}

describe("workspace member selection and usage", () => {
  it("provides group and leaf help, and refuses unsupported arguments before any request", async () => {
    const remote = await administrator();
    const group = await runUbAsync(["workspace", "--help"], remote.box);
    expect(group.stdout).toMatch(/^\s+member\b/m);
    for (const command of [[], ["add"], ["list"], ["role"], ["remove"]]) {
      const run = await runUbAsync(["workspace", "member", ...command, "--help"], remote.box);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain(`ub workspace member${command.length === 0 ? "" : ` ${command[0]}`}`);
      expect(run.stderr).toBe("");
    }
    for (const args of [["unknown"], ["constructor"], ["toString"], ["__proto__"], ["add"], ["add", LOGIN, "--yes"], ["add", LOGIN, "--role", "owner"],
      ["add", ACCOUNT, "--hub", remote.origin], ["list", "extra"], ["role", LOGIN], ["role", LOGIN, "owner"], ["remove"]]) {
      const run = await runUbAsync(["workspace", "member", ...args], remote.box);
      expect(run.status, run.output).toBe(2);
      expect(run.stdout).toBe("");
    }
    expect(remote.requests).toEqual([]);
  });

  it("refuses missing and local-only bindings without touching a hub", async () => {
    const remote = await administrator();
    for (const [box, message] of [
      [unboundSandbox(), "No workspace selected"],
      [sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } }), "local-only"],
    ] as const) {
      for (const args of [["list"], ["add", LOGIN], ["role", LOGIN, "admin"], ["remove", LOGIN]]) {
        const run = await runUbAsync(["workspace", "member", ...args], box);
        expect(run.status, run.output).toBe(1);
        expect(run.stderr).toContain(message);
      }
      expect(existsSync(credentialPath(box))).toBe(false);
    }
    expect(remote.requests).toEqual([]);
  });

  it("uses both environment overrides without changing the project binding", async () => {
    const remote = await administrator();
    member(remote, ACCOUNT, LOGIN, "member", OTHER_WORKSPACE);
    const database = new DatabaseSync(remote.databasePath);
    try { database.prepare("UPDATE hub_memberships SET role = 'admin' WHERE workspace_id = ? AND principal_id = ?")
      .run(OTHER_WORKSPACE, savedLogin(remote.box, remote.origin).identity.id); }
    finally { database.close(); }
    bind(remote.box, "wss://unselected.invalid", randomUUID());
    const original = binding(remote.box);
    const run = await runUbAsync(["workspace", "member", "list", "--json"], remote.box, {
      UB_WORKSPACE_ID: `other-${OTHER_WORKSPACE}`, UB_HUB_URL: remote.origin,
    });
    expect(run.status, run.output).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ hub: remote.origin, workspaceId: OTHER_WORKSPACE });
    expect(actions(remote, "list-members")).toEqual([{ operation: "list-members", workspaceId: OTHER_WORKSPACE }]);
    expect(binding(remote.box)).toBe(original);
    publicOutput(run, remote);
  });
});

describe("confirmed grants", () => {
  it.each([undefined, "admin"] as const)("confirms the resolved account ID and grants role %s", async role => {
    const remote = await administrator();
    const original = binding(remote.box);
    const run = await terminal(remote, ["add", LOGIN.toLowerCase(), ...(role ? ["--role", role] : [])], "YeS");
    expect(run.status, run.output).toBe(0);
    for (const value of [remote.origin, WORKSPACE, LOGIN, ACCOUNT, role ?? "member"]) expect(run.stderr).toContain(value);
    expect(actions(remote, "resolve-account")).toEqual([{ operation: "resolve-account", workspaceId: WORKSPACE, githubUsername: LOGIN.toLowerCase() }]);
    const [grant] = actions(remote, "grant-member");
    expect(grant).toMatchObject({ operation: "grant-member", workspaceId: WORKSPACE, githubAccountId: ACCOUNT });
    expect(grant).not.toHaveProperty("githubUsername");
    expect(grant?.role ?? "member").toBe(role ?? "member");
    const target = remote.hub.principals!.getByGithubAccountId(ACCOUNT)!;
    expect(remote.hub.memberships!.roleFor(WORKSPACE, target.id)).toBe(role ?? "member");
    expect(run.stdout).toContain(LOGIN);
    expect(run.stdout).toContain(ACCOUNT);
    expect(run.stdout).toContain(`Access is discovered on sign-in or credential renewal; select the workspace explicitly with \`ub workspace use ${remote.origin}/${WORKSPACE}\`.\n`);
    expect(binding(remote.box)).toBe(original);
    expect(remote.github.calls.filter(url => url.includes("github.com/login/"))).toEqual([]);
    publicOutput(run, remote);
  });

  it.each(["", "no", "yes please"])("grants nothing for the answer %j", async answer => {
    const remote = await administrator();
    const run = await terminal(remote, ["add", LOGIN], answer);
    expect(run.status, run.output).toBe(0);
    expect(actions(remote, "grant-member")).toEqual([]);
    expect(remote.hub.principals!.getByGithubAccountId(ACCOUNT)).toBeNull();
    expect(run.output).toMatch(/cancel|no.*grant|not.*grant/i);
    publicOutput(run, remote);
  });

  it("refuses non-terminal grants even when stdin could carry yes", async () => {
    const remote = await administrator();
    const run = await runUbAsync(["workspace", "member", "add", LOGIN], remote.box);
    expect(run.status, run.output).toBe(1);
    expect(run.stderr).toMatch(/terminal|interactive/i);
    expect(actions(remote, "grant-member")).toEqual([]);
    expect(remote.hub.principals!.getByGithubAccountId(ACCOUNT)).toBeNull();
    publicOutput(run, remote);
  });

  it.each(["admin", "member"] as const)("reports an existing %s without changing its role", async role => {
    const remote = await administrator();
    const target = member(remote, ACCOUNT, LOGIN, role);
    const run = await runUbAsync(["workspace", "member", "add", LOGIN, "--role", role === "admin" ? "member" : "admin"], remote.box);
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toMatch(/already.*member/i);
    expect(run.stdout).toContain(role);
    expect(run.stdout).toContain("member role");
    expect(actions(remote, "grant-member")).toEqual([]);
    expect(remote.hub.memberships!.roleFor(WORKSPACE, target.id)).toBe(role);
    publicOutput(run, remote);
  });

  it("preserves a role granted after confirmation starts and reports already-member", async () => {
    const remote = await administrator();
    remote.github.lookupHook = url => {
      // The list was empty when the admin confirmed; another grant wins before
      // the hub's second lookup returns and its mutation checks membership.
      if (url.includes("/user/")) member(remote, ACCOUNT, LOGIN, "admin");
      return Response.json({ id: Number(ACCOUNT), login: LOGIN, type: "User" });
    };
    const run = await terminal(remote, ["add", LOGIN, "--role", "member"], "yes");
    expect(run.status, run.output).toBe(0);
    expect(actions(remote, "grant-member")).toHaveLength(1);
    expect(run.stdout).toMatch(/already.*member/i);
    expect(run.stdout).toContain("admin");
    expect(run.stdout).toContain("member role");
    const target = remote.hub.principals!.getByGithubAccountId(ACCOUNT)!;
    expect(remote.hub.memberships!.roleFor(WORKSPACE, target.id)).toBe("admin");
    publicOutput(run, remote);
  });

  it("refuses malformed handles before any network request", async () => {
    const remote = await administrator();
    for (const handle of ["bad/handle", "-bad", "bad--handle", "a".repeat(40)]) {
      const run = await terminal(remote, ["add", handle], "yes");
      expect(run.status, run.output).toBe(2);
      expect(run.stderr).toMatch(/GitHub.*handle|GitHub.*login|username/i);
    }
    expect(remote.requests).toEqual([]);
    expect(remote.github.calls).toEqual([]);
  });

  it.each([
    ["missing", 404, { message: "Not Found" }, /no such GitHub user/i],
    ["organization", 200, { id: Number(ACCOUNT), login: LOGIN, type: "Organization" }, /no such GitHub user/i],
    ["bot", 200, { id: Number(ACCOUNT), login: LOGIN, type: "Bot" }, /no such GitHub user/i],
    ["unavailable", 503, {}, /lookup unavailable.*retry later/i],
  ] as const)("distinguishes %s during resolution and the grant's second lookup", async (_kind, status, body, message) => {
    for (const failingPhase of ["resolve", "grant"] as const) {
      const remote = await administrator();
      remote.github.lookupHook = url => url.includes("/users/") && failingPhase === "grant"
        ? Response.json({ id: Number(ACCOUNT), login: LOGIN, type: "User" })
        : Response.json(body, { status });
      const run = await terminal(remote, ["add", LOGIN], "yes");
      expect(run.status, run.output).toBe(1);
      expect(run.stderr).toMatch(message);
      expect(remote.hub.principals!.getByGithubAccountId(ACCOUNT)).toBeNull();
      expect(actions(remote, "grant-member")).toHaveLength(failingPhase === "grant" ? 1 : 0);
      publicOutput(run, remote);
    }
  });
});

describe("current member matching and mutations", () => {
  it("lists login, permanent ID and role, with only public JSON on stdout", async () => {
    const remote = await administrator();
    member(remote);
    const listed = await runUbAsync(["workspace", "member", "list"], remote.box);
    expect(listed.status, listed.output).toBe(0);
    for (const value of [LOGIN, ACCOUNT, "member", USERNAME, "1234", "admin"]) expect(listed.stdout).toContain(value);
    const json = await runUbAsync(["workspace", "member", "list", "--json"], remote.box);
    expect(json.status, json.output).toBe(0);
    const result = JSON.parse(json.stdout);
    expect(Object.keys(result).sort()).toEqual(["hub", "members", "workspaceId"]);
    expect(result).toMatchObject({ hub: remote.origin, workspaceId: WORKSPACE });
    expect(result.members).toHaveLength(2);
    expect(result.members).toContainEqual({ githubUsername: LOGIN, githubAccountId: ACCOUNT, role: "member" });
    expect(result.members).toContainEqual({ githubUsername: USERNAME, githubAccountId: "1234", role: "admin" });
    publicOutput(listed, remote);
    publicOutput(json, remote);
  });

  it("changes roles by case-insensitive login and removes by account ID without revoking devices or other memberships", async () => {
    const remote = await administrator();
    const target = member(remote);
    member(remote, ACCOUNT, LOGIN, "member", OTHER_WORKSPACE);
    remote.hub.credentials!.issue({ principalId: target.id, deviceId: randomUUID(), workspaces: [WORKSPACE, OTHER_WORKSPACE] });
    const devices = privateDeviceRows(remote.databasePath);
    const original = binding(remote.box);
    const changed = await runUbAsync(["workspace", "member", "role", LOGIN.toLowerCase(), "admin"], remote.box);
    expect(changed.status, changed.output).toBe(0);
    expect(changed.stdout).toContain(LOGIN);
    expect(changed.stdout).toContain(ACCOUNT);
    expect(actions(remote, "change-role")).toEqual([{ operation: "change-role", workspaceId: WORKSPACE, principalId: target.id, role: "admin" }]);
    expect(remote.hub.memberships!.roleFor(WORKSPACE, target.id)).toBe("admin");
    const removed = await runUbAsync(["workspace", "member", "remove", ACCOUNT], remote.box);
    expect(removed.status, removed.output).toBe(0);
    for (const value of [LOGIN, ACCOUNT]) expect(removed.stdout).toContain(value);
    expect(removed.stdout).toMatch(/every device|all devices/i);
    expect(removed.stdout).toMatch(/no devices.*revoked|revokes no devices|devices.*not.*revok/i);
    expect(removed.stdout).toMatch(/other workspaces/i);
    expect(remote.hub.memberships!.roleFor(WORKSPACE, target.id)).toBeNull();
    expect(remote.hub.memberships!.roleFor(OTHER_WORKSPACE, target.id)).toBe("member");
    expect(privateDeviceRows(remote.databasePath)).toEqual(devices);
    expect(binding(remote.box)).toBe(original);
    publicOutput(changed, remote);
    publicOutput(removed, remote);
  });

  it("refuses missing and ambiguous logins without a mutation, while IDs remain unambiguous", async () => {
    const remote = await administrator();
    const first = member(remote, ACCOUNT, "old-login");
    member(remote, "6789", "OLD-LOGIN");
    for (const selector of ["absent", "old-login"]) {
      for (const args of [["role", selector, "admin"], ["remove", selector]]) {
        const run = await runUbAsync(["workspace", "member", ...args], remote.box);
        expect(run.status, run.output).toBe(1);
        expect(run.stderr).toMatch(selector === "absent" ? /no.*member|not.*member|not found/i : /ambiguous|more than one|multiple|matches 2/i);
      }
    }
    expect(actions(remote, "change-role")).toEqual([]);
    expect(actions(remote, "remove-member")).toEqual([]);
    const byId = await runUbAsync(["workspace", "member", "role", ACCOUNT, "admin"], remote.box);
    expect(byId.status, byId.output).toBe(0);
    expect(remote.hub.memberships!.roleFor(WORKSPACE, first.id)).toBe("admin");
    publicOutput(byId, remote);
  });

  it("refuses a numeric selector that matches one login and another permanent ID", async () => {
    const remote = await administrator();
    member(remote, ACCOUNT, "6789");
    member(remote, "6789", "different-login");
    for (const args of [["role", "6789", "admin"], ["remove", "6789"]]) {
      const run = await runUbAsync(["workspace", "member", ...args], remote.box);
      expect(run.status, run.output).toBe(1);
      expect(run.stderr).toMatch(/ambiguous|more than one|multiple|matches 2/i);
      publicOutput(run, remote);
    }
    expect(actions(remote, "change-role")).toEqual([]);
    expect(actions(remote, "remove-member")).toEqual([]);
  });

  it("quotes stored logins as display data and explains the last-admin refusal", async () => {
    const remote = await administrator();
    const display = "changed\nlogin\u001b[31m";
    member(remote, ACCOUNT, display);
    const listed = await runUbAsync(["workspace", "member", "list"], remote.box);
    expect(listed.status, listed.output).toBe(0);
    expect(listed.stdout).toContain(JSON.stringify(display));
    expect(listed.stdout.includes(display), "stored login cannot inject terminal formatting").toBe(false);
    for (const args of [["role", "1234", "member"], ["remove", "1234"]]) {
      const run = await runUbAsync(["workspace", "member", ...args], remote.box);
      expect(run.status, run.output).toBe(1);
      expect(run.stderr).toMatch(/last.*admin|final.*admin/i);
      publicOutput(run, remote);
    }
    expect(remote.hub.memberships!.roleFor(WORKSPACE, savedLogin(remote.box, remote.origin).identity.id)).toBe("admin");
  });
});

describe("stored device renewal and hub failures", () => {
  it.each(["missing-scope", "rejected"] as const)("renews once for %s and never starts GitHub approval", async failure => {
    const remote = await administrator();
    const original = binding(remote.box);
    const previous = savedLogin(remote.box, remote.origin);
    if (failure === "missing-scope") {
      const issued = remote.hub.credentials!.issue({ principalId: previous.identity.id, deviceId: previous.credential.record.deviceId, workspaces: [OTHER_WORKSPACE] });
      await writeHubLogin(remote.origin, { identity: previous.identity,
        credential: { record: issued.record, key: Buffer.from(issued.keyBytes).toString("base64url") } }, remote.box.env);
    } else {
      let rejected = false;
      remote.controls.transform = (path, status, result) => {
        if (path === "/auth/manage" && !rejected) {
          rejected = true;
          return { status: 401, result: { status: "sign-in-required" } };
        }
        return { status, result };
      };
    }
    const run = await runUbAsync(["workspace", "member", "list", "--json"], remote.box);
    expect(run.status, run.output).toBe(0);
    expect(JSON.parse(run.stdout).workspaceId).toBe(WORKSPACE);
    expect(remote.requests.filter(request => request.path === "/auth/credential/renew")).toHaveLength(1);
    expect(savedLogin(remote.box, remote.origin).credential.record.workspaces).toContain(WORKSPACE);
    expect(remote.requests.filter(request => request.path.startsWith("/auth/github/"))).toEqual([]);
    expect(remote.github.calls).toEqual([]);
    expect(binding(remote.box)).toBe(original);
    publicOutput(run, remote);
    expect(run.output.includes(previous.credential.key), "retired device key was not printed").toBe(false);
  });

  it("does not repeatedly renew a rejected management request", async () => {
    const remote = await administrator();
    remote.controls.transform = (path, status, result) => path === "/auth/manage"
      ? { status: 401, result: { status: "sign-in-required" } } : { status, result };
    const run = await runUbAsync(["workspace", "member", "list"], remote.box);
    expect(run.status, run.output).toBe(1);
    expect(run.stderr).toContain(`ub auth login ${remote.origin}`);
    expect(remote.requests.filter(request => request.path === "/auth/credential/renew")).toHaveLength(1);
    expect(actions(remote, "list-members")).toHaveLength(2);
    expect(remote.requests.filter(request => request.path.startsWith("/auth/github/"))).toEqual([]);
    publicOutput(run, remote);
  });

  it("names the login command when no usable device login exists, and starts no sign-in", async () => {
    const remote = await rig([WORKSPACE]);
    bind(remote.box, remote.origin);
    const run = await runUbAsync(["workspace", "member", "list"], remote.box);
    expect(run.status, run.output).toBe(1);
    expect(run.stderr).toContain(`ub auth login ${remote.origin}`);
    expect(remote.requests).toEqual([]);
    expect(remote.github.calls).toEqual([]);
    expect(existsSync(credentialPath(remote.box))).toBe(false);
  });

  it("distinguishes an unreachable hub without exposing the stored key", async () => {
    const remote = await administrator();
    const unreachable = "http://127.0.0.1:1";
    const login = savedLogin(remote.box, remote.origin);
    await writeHubLogin(unreachable, login, remote.box.env);
    bind(remote.box, unreachable);
    const run = await runUbAsync(["workspace", "member", "list"], remote.box);
    expect(run.status, run.output).toBe(1);
    expect(run.stderr).toMatch(/unreachable/i);
    expect(remote.requests).toEqual([]);
    publicOutput(run, remote);
  });

  it.each([
    [403, "forbidden", /admin.*required|requires.*admin|administrator/i],
    [409, "protocol-mismatch", /protocol.*mismatch|protocol.*version|update/i],
    [503, "not-configured", /not configured|not-configured/i],
    [500, "failed", /failed|could not complete/i],
  ] as const)("reports %s %s distinctly with nonzero exit and no private response fields", async (status, answer, message) => {
    const remote = await administrator();
    const key = savedLogin(remote.box, remote.origin).credential.key;
    remote.controls.transform = (path, upstream, result) => path === "/auth/manage"
      ? { status, result: { status: answer, reason: key, token: remote.requests.at(-1)?.body.token } }
      : { status: upstream, result };
    const run = await runUbAsync(["workspace", "member", "list"], remote.box);
    expect(run.status, run.output).toBe(1);
    expect(run.stderr).toMatch(message);
    publicOutput(run, remote);
  });

  it("reports closure failure as a committed removal and leaves devices and other workspaces alone", async () => {
    const remote = await administrator();
    const target = member(remote);
    member(remote, ACCOUNT, LOGIN, "member", OTHER_WORKSPACE);
    const devices = privateDeviceRows(remote.databasePath);
    const unsubscribe = remote.hub.memberships!.onRemove(() => { throw new Error("synthetic closure failure"); });
    try {
      const run = await runUbAsync(["workspace", "member", "remove", ACCOUNT], remote.box);
      expect(run.status, run.output).toBe(1);
      expect(run.stderr).toMatch(/committed/i);
      expect(run.stderr).toMatch(/closure|connection|close/i);
      expect(run.stderr).toContain(LOGIN);
      expect(run.stderr).toContain(ACCOUNT);
      expect(remote.hub.memberships!.roleFor(WORKSPACE, target.id)).toBeNull();
      expect(remote.hub.memberships!.roleFor(OTHER_WORKSPACE, target.id)).toBe("member");
      expect(privateDeviceRows(remote.databasePath)).toEqual(devices);
      publicOutput(run, remote);
    } finally { unsubscribe(); }
  });

  it("lets a previously signed-in granted account use a link through renewal without new GitHub approval", async () => {
    const remote = await administrator([WORKSPACE, OTHER_WORKSPACE], true);
    const identity = remote.hub.principals!.identify(ACCOUNT, LOGIN);
    const issued = remote.hub.credentials!.issue({ principalId: identity.id, deviceId: randomUUID(), workspaces: [] });
    const other = sandbox({ projectBinding: { workspaceId: OTHER_WORKSPACE, hubUrl: null } });
    // The rig's HTTP front records management requests; the real hub also
    // serves the WebSocket connection that fetching the link needs.
    const joinOrigin = `http://127.0.0.1:${remote.hub.port}`;
    writeHubAdmission(`ws://127.0.0.1:${remote.hub.port}/ws`, true, other.env);
    await writeHubLogin(joinOrigin, { identity,
      credential: { record: issued.record, key: Buffer.from(issued.keyBytes).toString("base64url") } }, other.env);
    const beforeAdmin = binding(remote.box);
    const beforeOther = binding(other);
    const granted = await terminal(remote, ["add", LOGIN], "y");
    expect(granted.status, granted.output).toBe(0);
    expect(binding(remote.box)).toBe(beforeAdmin);
    expect(binding(other)).toBe(beforeOther);
    const joined = await runUbAsync(["workspace", "use", `${joinOrigin}/${WORKSPACE}`], other);
    expect(joined.status, joined.output).toBe(0);
    expect(JSON.parse(binding(other)).workspaceId).toBe(WORKSPACE);
    const renewed = savedLogin(other, joinOrigin);
    expect(renewed.credential.record.workspaces).toContain(WORKSPACE);
    expect(renewed.credential.record.id).not.toBe(issued.record.id);
    expect(remote.requests.filter(request => request.path.startsWith("/auth/github/"))).toEqual([]);
    expect(remote.github.calls.filter(url => url.includes("github.com/login/"))).toEqual([]);
    publicOutput(granted, remote);
    assertPublicOnly(joined, remote, Buffer.from(issued.keyBytes).toString("base64url"));
    assertPublicOnly(joined, remote, renewed.credential.key);
  });
});
