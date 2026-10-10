/** The public status report answers whether this project's work reaches the hub. */

import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import { defaultDatabasePath } from "@uberblick/mcp-server";
import { setWorkspaceName, settingsRoom } from "@uberblick/schema";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { MirrorStore } from "../../mcp-server/src/store.js";
import type { StatusReport } from "../src/status.js";
import { renderStatus, shortStatusReport } from "../src/status.js";
import { fixture } from "./auth-fixtures.js";
import { DEAD_HUB_URL, removeTempDirs, runUb, sandbox, unboundSandbox } from "./helpers.js";

afterAll(removeTempDirs);

const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";
const HUB = "wss://hub.example.test/ws";
const ORIGIN = "https://hub.example.test";

function report(overrides: Partial<StatusReport> = {}): StatusReport {
  return {
    version: "1.2.3",
    workspace: WORKSPACE,
    workspaceUuid: WORKSPACE,
    binding: { workspaceId: WORKSPACE, hubUrl: HUB },
    projectConfig: "/project/.uberblick.json",
    hubUrl: HUB,
    account: { login: "bk-one", provider: "github" },
    databasePath: "/workspace/replica.sqlite",
    credentialPresent: true,
    credentialSource: "credentials file",
    sources: { workspace: "project config", hubUrl: "project config" },
    shadowed: [{ setting: "credential", layer: "credentials file" }],
    hub: { status: "connected", url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION },
    rooms: [{ room: `${WORKSPACE}/a-room`, appliedSeq: 912345, synced: true }],
    unsyncedChanges: 0,
    pendingRooms: [],
    lastSync: null,
    inFlightUpdates: 0,
    logEntries: 5284,
    persistence: null,
    storage: {
      layout: "xdg",
      config: "/config/config.json",
      data: "/data/root",
      hub: "/data/hub.sqlite",
      workspace: "/workspace/replica.sqlite",
    },
    ...overrides,
  };
}

function row(text: string, name: string): string {
  return text.split("\n").find((line) => line.startsWith(`${name} `)) ?? "";
}

describe("the short status report", () => {
  it("prints the hub example in its specified order with no internal diagnostics", () => {
    expect(renderStatus(report(), undefined, "Uberblick")).toBe(
      `workspace   Uberblick (${WORKSPACE})\n` +
      `hub         ${ORIGIN}\n` +
      "account     @bk-one (GitHub)\n" +
      "connection  connected\n" +
      "pending     none\n" +
      "last sync   never\n" +
      "problems    none\n",
    );
    expect(shortStatusReport(report(), "Uberblick")).toEqual({
      workspace: { id: WORKSPACE, name: "Uberblick" },
      hub: ORIGIN,
      account: { login: "bk-one", provider: "github" },
      connection: { state: "connected", cause: null, detail: null },
      pending: { count: 0 },
      lastSync: null,
      problems: [],
    });
  });

  it("uses the bare UUID when this replica has no workspace name", () => {
    const reading = report({ workspace: `notes-${WORKSPACE}` });
    expect(row(renderStatus(reading), "workspace")).toBe(`workspace   ${WORKSPACE}`);
    expect(shortStatusReport(reading).workspace).toEqual({ id: WORKSPACE, name: null });
  });

  it.each([0, 1, 4])("reports %d pending rooms without counting messages or log records", (count) => {
    const reading = report({ unsyncedChanges: count, inFlightUpdates: 37, logEntries: 5284 });
    expect(row(renderStatus(reading), "pending")).toBe(count === 0
      ? "pending     none"
      : `pending     ${count} change${count === 1 ? "" : "s"} not yet on the hub`);
    expect(shortStatusReport(reading).pending).toEqual({ count });
    expect(renderStatus(reading)).not.toMatch(/37|5284|rooms|local log|selection|recovery|failures|uuid/);
  });

  it.each([null, "2026-10-05T19:58:12Z"])("prints four local rows regardless of stored sync time %s", (lastSync) => {
    const reading = report({
      binding: { workspaceId: WORKSPACE, hubUrl: null },
      lastSync, unsyncedChanges: 5, inFlightUpdates: 7,
    });
    expect(renderStatus(reading, ORIGIN, "My Workspace")).toBe(
      `workspace   My Workspace (${WORKSPACE})\n` +
      "hub         local, this computer only\n" +
      "account     none needed for a local workspace\n" +
      "problems    none\n",
    );
    expect(shortStatusReport(reading, "My Workspace")).toEqual({
      workspace: { id: WORKSPACE, name: "My Workspace" },
      hub: null, account: null, connection: null, pending: { count: 0 }, lastSync: null, problems: [],
    });
  });

  it("clears recorded causes when the current connection is connected", () => {
    const reading = report({ hub: {
      status: "connected", url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION,
      cause: "dns", detail: "ENOTFOUND hub.example.test",
    } });
    expect(shortStatusReport(reading).connection).toEqual({ state: "connected", cause: null, detail: null });
    expect(row(renderStatus(reading), "connection")).toBe("connection  connected");
  });

  it.each([
    ["dns", "ENOTFOUND hub.example.test", "DNS lookup failed for hub.example.test (ENOTFOUND)"],
    ["refused", "ECONNREFUSED 203.0.113.7:443", "refused by 203.0.113.7:443 (ECONNREFUSED)"],
    ["timeout", "1.5 203.0.113.7:443", "timed out after 1.5s connecting to 203.0.113.7:443"],
    ["tls", "ERR_TLS_CERT_ALTNAME_INVALID hub.example.test", "TLS certificate not valid for hub.example.test (ERR_TLS_CERT_ALTNAME_INVALID)"],
    ["http", "502 hub.example.test", "HTTP 502 from hub.example.test during WebSocket upgrade"],
    ["closed", "4401", "closed by the hub (code 4401)"],
  ] as const)("names the safe recorded %s cause in text and JSON", (cause, detail, phrase) => {
    const reading = report({ hub: {
      status: "hub-down", url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION,
      cause, detail, reason: "untrusted hub reason must stay hidden",
    } });
    expect(row(renderStatus(reading), "connection")).toBe(`connection  ${phrase}`);
    expect(shortStatusReport(reading).connection).toEqual({ state: "failed", cause, detail });
    expect(shortStatusReport(reading).problems).toEqual([
      { name: "hub-unreachable", fix: expect.stringMatching(/network.*ub doctor for details$/) },
    ]);
    expect(renderStatus(reading)).toContain("problems    hub unreachable");
    expect(renderStatus(reading)).toMatch(/\n {14}→ .*ub doctor for details\n$/);
    expect(JSON.stringify(shortStatusReport(reading)) + renderStatus(reading)).not.toContain("untrusted hub reason");
  });

  it.each([
    { cause: "dns" as const, detail: "ENOTFOUND https://user:secret@hub.example.test?token=secret" },
    { cause: "closed" as const, detail: "4401 hub-supplied secret" },
    { cause: "tls" as const, detail: "certificate failed\nsecret" },
    { cause: "http" as const },
    { detail: "hub-supplied secret" },
  ])("rejects incomplete or unsafe recorded detail %j", (failure) => {
    const reading = report({ hub: {
      status: "hub-down", url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION, ...failure,
    } });
    expect(shortStatusReport(reading).connection).toEqual({ state: "failed", cause: null, detail: null });
    expect(row(renderStatus(reading), "connection")).toBe("connection  hub does not answer");
    expect(JSON.stringify(shortStatusReport(reading)) + renderStatus(reading)).not.toContain("secret");
  });

  it("shows no answer yet while connecting without inventing a hub-unreachable problem", () => {
    const reading = report({ hub: { status: "connecting", url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION } });
    expect(row(renderStatus(reading), "connection")).toBe("connection  no answer yet");
    expect(shortStatusReport(reading).connection).toEqual({ state: "failed", cause: null, detail: null });
    expect(shortStatusReport(reading).problems).toEqual([]);
  });

  it.each([
    [SYNC_PROTOCOL_VERSION + 1, "refused: the hub needs a newer Uberblick", "ub update"],
    [SYNC_PROTOCOL_VERSION - 1, "refused: the hub runs an older Uberblick", `ask whoever runs ${ORIGIN} to update the hub`],
  ])("explains protocol refusal from hub version %d", (hubProtocolVersion, phrase, fix) => {
    const reading = report({ hub: {
      status: "update-required", url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION, hubProtocolVersion,
    } });
    expect(row(renderStatus(reading), "connection")).toBe(`connection  ${phrase}`);
    expect(row(renderStatus(reading), "problems")).toBe("problems    update required");
    expect(shortStatusReport(reading).connection).toEqual({ state: "refused", cause: null, detail: null });
    expect(shortStatusReport(reading).problems).toEqual([{ name: "update-required", fix }]);
  });

  it("moves the sign-in fix to problems and preserves a recorded hub close", () => {
    const reading = report({ account: null, hub: {
      status: "auth-failed", url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION,
      authRecovery: "sign-in-required", cause: "closed", detail: "4401",
    } });
    const text = renderStatus(reading, ORIGIN);
    expect(row(text, "account")).toBe(`account     not signed in to ${ORIGIN}`);
    expect(row(text, "connection")).toBe("connection  closed by the hub (code 4401)");
    expect(row(text, "problems")).toBe("problems    not signed in");
    expect(text).toContain(`\n              → ub auth login ${ORIGIN}\n`);
    expect(shortStatusReport(reading).connection).toEqual({ state: "refused", cause: "closed", detail: "4401" });
    expect(shortStatusReport(reading).problems).toEqual([{ name: "not-signed-in", fix: `ub auth login ${ORIGIN}` }]);
  });

  it.each([
    ["bk-one", "ask a workspace admin to run: ub workspace member add bk-one"],
    ["a; echo secret", "ask a workspace admin for access"],
    ["-invalid", "ask a workspace admin for access"],
    [null, "ask a workspace admin for access"],
  ])("offers a safe workspace-access fix for account %s", (login, fix) => {
    const reading = report({
      account: login === null ? null : { login, provider: "github" },
      hub: { status: "auth-failed", url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION,
        authRecovery: "no-workspace-access" },
    });
    expect(row(renderStatus(reading), "connection")).toBe("connection  refused");
    expect(shortStatusReport(reading).problems).toEqual([{ name: "no-workspace-access", fix }]);
  });

  it("quotes and escapes invalid stored handles without adding terminal controls or lines", () => {
    const login = 'synthetic"\\user\n\u001b\u007f\u0085\u009b';
    const text = renderStatus(report({ account: { login, provider: "github" } }));
    expect(row(text, "account")).toBe('account     @"synthetic\\"\\\\user\\n\\u001b\\u007f\\u0085\\u009b" (GitHub)');
    expect(text.split("\n")).toHaveLength(renderStatus(report()).split("\n").length);
  });

  it.each(["credential-store", "renewal-unavailable", undefined] as const)(
    "gives other refusals a stable problem name and doctor's fix: %s",
    (authRecovery) => {
      const reading = report({ hub: {
        status: "auth-failed", url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION,
        ...(authRecovery === undefined ? {} : { authRecovery }), reason: "hub-supplied reason",
      } });
      const result = shortStatusReport(reading);
      expect(result.connection).toEqual({ state: "refused", cause: null, detail: null });
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toEqual({ name: expect.stringMatching(/^[a-z]+(?:-[a-z]+)+$/), fix: "ub doctor for details" });
      expect(JSON.stringify(result) + renderStatus(reading)).not.toContain("hub-supplied reason");
    },
  );

  it("makes a hub binding with sync disabled a diagnostic problem", () => {
    const reading = report({ hub: { status: "disabled", url: null, protocolVersion: SYNC_PROTOCOL_VERSION } });
    expect(shortStatusReport(reading).connection).toEqual({ state: "failed", cause: null, detail: null });
    expect(shortStatusReport(reading).problems).toEqual([
      { name: expect.stringMatching(/^[a-z]+(?:-[a-z]+)+$/), fix: "ub doctor for details" },
    ]);
  });

  it.each([HUB, null])("reports a persistence failure once despite quarantine for hub %s", (hubUrl) => {
    const reading = report({ binding: { workspaceId: WORKSPACE, hubUrl },
      hub: { status: "quarantined", url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION },
      persistence: { room: `${WORKSPACE}/refused-room`, message: "disk is full: secret" },
    });
    expect(shortStatusReport(reading).problems).toEqual([
      { name: "persistence-failed", fix: "ub doctor for details" },
    ]);
    expect(renderStatus(reading)).toContain("              → ub doctor for details\n");
    expect(JSON.stringify(shortStatusReport(reading)) + renderStatus(reading)).not.toContain("refused-room");
    expect(JSON.stringify(shortStatusReport(reading)) + renderStatus(reading)).not.toContain("secret");
  });

  it("reports quarantine as persistence failed even without a recorded persistence error", () => {
    const reading = report({ hub: { status: "quarantined", url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION } });
    expect(shortStatusReport(reading).connection).toEqual({ state: "failed", cause: null, detail: null });
    expect(shortStatusReport(reading).problems).toEqual([{ name: "persistence-failed", fix: "ub doctor for details" }]);
  });

  it("keeps independent persistence and connection problems with a fix under each", () => {
    const reading = report({ hub: { status: "hub-down", url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION },
      persistence: { room: `${WORKSPACE}/refused-room`, message: "disk is full" },
    });
    expect(shortStatusReport(reading).problems.map(({ name }) => name).sort()).toEqual(["hub-unreachable", "persistence-failed"]);
    expect(renderStatus(reading).match(/\n {14}→ /g)).toHaveLength(2);
  });
});

describe("the last hub sync in ub status", () => {
  it.each([
    [-1_000, "just now"], [0, "just now"], [4_999, "just now"], [5_000, "5 seconds ago"],
    [12_999, "12 seconds ago"], [59_999, "59 seconds ago"], [60_000, "1 minute ago"],
    [119_999, "1 minute ago"], [120_000, "2 minutes ago"], [3_599_999, "59 minutes ago"],
    [3_600_000, "1 hour ago"], [10_800_000, "3 hours ago"], [86_399_999, "23 hours ago"],
    [86_400_000, "1 day ago"], [172_800_000, "2 days ago"],
  ])("renders a last sync %d ms ago as %s", (age, expected) => {
    const lastSync = "2026-10-05T19:58:12Z";
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(lastSync) + age);
    try {
      const reading = report({ lastSync });
      expect(row(renderStatus(reading), "last sync")).toBe(`last sync   ${expected}`);
      expect(shortStatusReport(reading).lastSync).toBe(lastSync);
    } finally { clock.mockRestore(); }
  });

  it("keeps a stored acknowledgement time visible while the hub is unavailable", () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: "last-sync-status-test-secret" },
    });
    const initial = runUb(["status", "--json"], box);
    expect(initial.status, initial.stderr).toBe(0);
    expect(JSON.parse(initial.stdout).lastSync).toBeNull();
    const timestamp = Math.floor((Date.now() - 3 * 3_600_000 - 30_000) / 1_000) * 1_000;
    const database = new DatabaseSync(defaultDatabasePath(WORKSPACE, box.env));
    try { database.prepare("INSERT INTO meta (key, value) VALUES ('last_sync_at', ?)").run(String(timestamp)); }
    finally { database.close(); }
    const json = runUb(["status", "--json"], box);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).lastSync).toBe(new Date(timestamp).toISOString().replace(".000Z", "Z"));
    expect(row(runUb(["status"], box).stdout, "last sync")).toBe("last sync   3 hours ago");
  });
});

describe("the real project's short report", () => {
  it.each([false, true])("prints only the stderr hint with no binding (json=%s)", (json) => {
    const box = unboundSandbox();
    const run = runUb(json ? ["status", "--json"] : ["status"], box);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("no .uberblick.json here or in any parent directory\n  → ub workspace create <name>, or ub workspace use <link|id>\n");
    expect(existsSync(defaultDatabasePath(WORKSPACE, box.env))).toBe(false);
  });

  it("does not borrow the legacy machine default without a project binding", () => {
    const box = unboundSandbox({ userConfig: { workspace: WORKSPACE, hubUrl: HUB } });
    const run = runUb(["status", "--json"], box);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("no .uberblick.json here or in any parent directory\n  → ub workspace create <name>, or ub workspace use <link|id>\n");
    expect(existsSync(defaultDatabasePath(WORKSPACE, box.env))).toBe(false);
  });

  it("returns usage errors as exit 2 before opening a replica", () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const run = runUb(["status", "--unknown"], box);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(existsSync(defaultDatabasePath(WORKSPACE, box.env))).toBe(false);
  });

  it.each([
    "wss://user:url-secret@hub.example.test/ws",
    "wss://hub.example.test/ws?token=url-secret",
    "wss://hub.example.test/ws#url-secret",
  ])("rejects invalid hub URL secrets without exposing them: %s", (hubUrl) => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl } });
    const run = runUb(["status", "--json"], box);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.output).not.toContain("url-secret");
  });

  it("uses the same binding from nested directories without exposing selection or storage", () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const nested = join(box.cwd, "src", "nested");
    mkdirSync(nested, { recursive: true });
    const run = runUb(["status", "--json"], { ...box, cwd: nested });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ workspace: { id: WORKSPACE, name: null },
      hub: null, account: null, connection: null, pending: { count: 0 }, lastSync: null, problems: [],
    });
    expect(runUb(["status"], { ...box, cwd: nested }).stdout).toBe(`workspace   ${WORKSPACE}\nhub         local, this computer only\naccount     none needed for a local workspace\nproblems    none\n`);
  });

  it.each([DEAD_HUB_URL, null])("reads the local name and counts reserved pending rooms only for a hub %s", (hubUrl) => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl },
      credentials: { signingSecret: "pending-status-test-secret" },
    });
    const store = new MirrorStore(defaultDatabasePath(WORKSPACE, box.env), WORKSPACE);
    const settings = new Y.Doc();
    try {
      setWorkspaceName(settings, "Stored name");
      store.appendUpdate(settingsRoom(WORKSPACE), Y.encodeStateAsUpdate(settings), "local");
    } finally { settings.destroy(); store.close(); }
    const database = new DatabaseSync(defaultDatabasePath(WORKSPACE, box.env));
    try {
      for (const room of ["_directory", "_sidebar", "a-document"]) {
        database.prepare("INSERT INTO pending_rooms (room, seq) VALUES (?, ?)").run(`${WORKSPACE}/${room}`, 1);
      }
      database.prepare("INSERT INTO meta (key, value) VALUES ('last_sync_at', ?)").run("1791226692000");
    } finally { database.close(); }
    const json = runUb(["status", "--json"], box);
    expect(json.status, json.stderr).toBe(0);
    const reading = JSON.parse(json.stdout);
    expect(Object.keys(reading).sort()).toEqual(["account", "connection", "hub", "lastSync", "pending", "problems", "workspace"]);
    expect(reading.workspace).toEqual({ id: WORKSPACE, name: "Stored name" });
    expect(reading.pending).toEqual({ count: hubUrl === null ? 0 : 4 });
    const text = runUb(["status"], box);
    expect(text.status, text.stderr).toBe(0);
    expect(row(text.stdout, "workspace")).toBe(`workspace   Stored name (${WORKSPACE})`);
    if (hubUrl === null) {
      expect(reading.lastSync).toBeNull();
      expect(text.stdout.trim().split("\n")).toHaveLength(4);
    } else {
      expect(row(text.stdout, "pending")).toBe("pending     4 changes not yet on the hub");
      expect(reading.connection.state).toBe("failed");
      expect(reading.problems.map((problem: { name: string }) => problem.name)).toEqual(["hub-unreachable"]);
    }
  });
});

describe("the locally stored account in ub status", () => {
  it.each(["previous-user", 'synthetic"\\user\n\u001b\u007f\u009b'])(
    "carries the stored login %j in JSON while the hub is unavailable",
    (username) => {
      const login = fixture([WORKSPACE]);
      login.identity.githubUsername = username;
      const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
        credentials: { hubLogins: { "http://127.0.0.1:1": login } },
      });
      const json = runUb(["status", "--json"], box);
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout).account).toEqual({ login: username, provider: "github" });
      const text = runUb(["status"], box);
      const auth = runUb(["auth", "status"], box);
      const displayed = row(auth.stdout, "signed in").replace(/^signed in\s+/, "");
      expect(text.stdout).toContain(`hub         http://127.0.0.1:1\naccount     @${displayed} (GitHub)\n`);
      expect(json.output + text.output).not.toContain(login.credential.key);
    },
  );

  it.each([
    { name: "missing", files: {} },
    { name: "another hub", files: { credentials: { hubLogins: { "https://other.example.test": fixture() } } } },
    { name: "unreadable store", files: { raw: { credentials: "{" } } },
    { name: "unreadable hub login", files: { credentials: { hubLogins: { "https://hub.example.test": {} } } } },
    { name: "refused store", files: { credentials: { hubLogins: { "https://hub.example.test": fixture() } }, credentialsMode: 0o644 } },
  ])("reports no stored account for a $name", ({ files }) => {
    const endpoint = "wss://Hub.Example.Test:443/ws";
    const box = sandbox({ ...files, projectBinding: { workspaceId: WORKSPACE, hubUrl: endpoint } });
    const json = runUb(["status", "--json"], box);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).account).toBeNull();
    const text = runUb(["status"], box);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain(`hub         ${ORIGIN}\naccount     not signed in to ${ORIGIN}\n`);
    expect(text.stdout).not.toContain("previous-user");
  });

  it("preserves HTTP in the account origin when no device login is stored", () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      userConfig: { hubAdmissions: { [DEAD_HUB_URL]: "device" } },
    });
    const text = runUb(["status"], box);
    expect(text.status, text.stderr).toBe(0);
    expect(row(text.stdout, "account")).toBe("account     not signed in to http://127.0.0.1:1");
  });

  it("reports no account needed locally even with a stored login for the fallback hub", () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null },
      credentials: { hubLogins: { "http://localhost:1234": fixture([WORKSPACE]) } },
    });
    expect(JSON.parse(runUb(["status", "--json"], box).stdout).account).toBeNull();
    expect(row(runUb(["status"], box).stdout, "account")).toBe("account     none needed for a local workspace");
  });

  it("omits the account row for local signing-secret admission to a hub", () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: "local-status-test-secret" },
    });
    const json = runUb(["status", "--json"], box);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).account).toBeNull();
    const text = runUb(["status"], box);
    expect(row(text.stdout, "account")).toBe("");
    expect(json.output + text.output).not.toContain("local-status-test-secret");
  });
});
