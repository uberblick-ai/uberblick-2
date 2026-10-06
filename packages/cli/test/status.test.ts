/** The human overview stays bounded; the report keeps its machine detail. */

import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import { mkdirSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { StatusReport } from "../src/status.js";
import { renderStatus } from "../src/status.js";
import { fixture } from "./auth-fixtures.js";
import { DEAD_HUB_URL, removeTempDirs, runUb, sandbox, unboundSandbox } from "./helpers.js";

afterAll(removeTempDirs);

const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";
const HUB = "wss://hub.example.test/ws";

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

describe("the human status overview", () => {
  it("places the stored GitHub account directly after the hub, even when the hub refuses it", () => {
    const text = renderStatus(report({
      hub: { status: "auth-failed", url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION },
    }));
    expect(text).toContain(`hub         ${HUB}\naccount     @bk-one (GitHub)\n`);
    expect(row(text, "connection")).toMatch(/auth-failed$/);
  });

  it.each(["https://hub.example.test", "http://localhost:8080"])(
    "names the authentication origin %s when no device login is stored",
    (origin) => {
      const text = renderStatus(report({ account: null }), origin);
      expect(text).toContain(`hub         ${HUB}\naccount     not signed in, run ub auth login ${origin}\n`);
    },
  );

  it.each([null, DEAD_HUB_URL])("omits the account without device admission for hub %s", (hubUrl) => {
    const text = renderStatus(report({ account: null, binding: { workspaceId: WORKSPACE, hubUrl } }));
    expect(row(text, "account")).toBe("");
  });

  it("quotes and escapes invalid stored handles without adding terminal controls or lines", () => {
    const login = 'synthetic"\\user\n\u001b\u007f\u0085\u009b';
    const text = renderStatus(report({ account: { login, provider: "github" } }));
    expect(row(text, "account")).toBe('account     @"synthetic\\"\\\\user\\n\\u001b\\u007f\\u0085\\u009b" (GitHub)');
    expect(text.split("\n")).toHaveLength(renderStatus(report()).split("\n").length);
  });

  it("aggregates rooms and pending work without adding rows or leaking detail", () => {
    const small = report();
    const rooms = Array.from({ length: 43 }, (_, index) => ({
      room: `${WORKSPACE}/attached-${index}`,
      appliedSeq: 912345 + index,
      synced: index % 2 === 0,
    }));
    const large = report({
      rooms,
      pendingRooms: rooms.slice(0, 21).map(({ room }) => ({ room, seq: 987654 })),
      unsyncedChanges: 21,
      inFlightUpdates: 37,
    });
    const text = renderStatus(large);

    expect(text.split("\n")).toHaveLength(renderStatus(small).split("\n").length);
    expect(row(text, "rooms")).toContain("43 rooms attached");
    expect(row(text, "pending")).toContain(
      "21 rooms with unacknowledged local changes",
    );
    expect(row(text, "pending")).toContain("37 sync messages unacknowledged");
    for (const { room, appliedSeq } of rooms) {
      expect(text).not.toContain(room);
      expect(text).not.toContain(String(appliedSeq));
    }
    expect(text).not.toContain("987654");
    expect(text).not.toMatch(/credential|shadowed|user config/);
    expect(row(text, "selection")).toContain("/project/.uberblick.json");
    for (const path of Object.values(large.storage)) {
      if (path !== "xdg") expect(text).not.toContain(path);
    }
    expect(row(text, "pending")).not.toContain("5284");
    expect(row(text, "local log")).toContain("5284 update records stored");
    expect(row(text, "hub")).toContain(HUB);
    const lines = text.split("\n");
    expect(lines.indexOf(row(text, "pending"))).toBe(
      lines.indexOf(row(text, "connection")) + 1,
    );
    expect(row(text, "connection")).toMatch(/connected$/);
    expect(text).not.toMatch(/\bsynced\b|\bseq\b/);
  });

  it("names the workspace UUID only when the configured spelling hides it", () => {
    expect(renderStatus(report())).not.toMatch(/^uuid\s/m);
    const text = renderStatus(report({ workspace: `notes-${WORKSPACE}` }));
    expect(row(text, "workspace")).toContain(`notes-${WORKSPACE}`);
    expect(row(text, "uuid")).toContain(WORKSPACE);
  });

  it.each(["auth-failed", "update-required", "hub-down", "quarantined"] as const)(
    "counts %s and shows its recovery detail",
    (status) => {
      const text = renderStatus(
        report({
          hub: {
            status,
            url: HUB,
            protocolVersion: SYNC_PROTOCOL_VERSION,
            ...(status === "update-required"
              ? { hubProtocolVersion: SYNC_PROTOCOL_VERSION + 1 }
              : {}),
            reason: "failure detail that belongs in doctor",
          },
        }),
      );
      expect(row(text, "failures")).toContain("1 detected failure");
      expect(row(text, "failures")).toContain("`ub doctor`");
      expect(row(text, "recovery")).toContain("failure detail that belongs in doctor");
    },
  );

  it.each(["connected", "disabled"] as const)(
    "does not count %s as a failure",
    (status) => {
      const text = renderStatus(
        report({
          hub: {
            status,
            url: status === "disabled" ? null : HUB,
            protocolVersion: SYNC_PROTOCOL_VERSION,
          },
        }),
      );
      expect(row(text, "failures")).toMatch(/0 detected failures$/);
      expect(row(text, "failures")).not.toContain("ub doctor");
    },
  );

  it("counts a persistence failure once with its quarantine and separately from an independent hub failure", () => {
    const persistence = { room: `${WORKSPACE}/refused-room`, message: "disk is full" };
    for (const status of ["connected", "quarantined"] as const) {
      const text = renderStatus(report({
        persistence,
        hub: { status, url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION },
      }));
      expect(row(text, "failures")).toContain("1 detected failure — run `ub doctor`");
      expect(text).not.toContain(persistence.room);
      expect(text).not.toContain(persistence.message);
    }
    for (const status of ["auth-failed", "update-required", "hub-down"] as const) {
      const text = renderStatus(report({
        persistence,
        hub: { status, url: HUB, protocolVersion: SYNC_PROTOCOL_VERSION },
      }));
      expect(row(text, "failures")).toContain("2 detected failures — run `ub doctor`");
    }
  });

  it("keeps an unfinished hub reading unknown, including alongside a known failure", () => {
    const hub = {
      status: "connecting",
      url: HUB,
      protocolVersion: SYNC_PROTOCOL_VERSION,
    } as const;
    const pending = row(renderStatus(report({ hub })), "failures");
    expect(pending).toContain("hub state not yet known");
    expect(pending).not.toContain("0 detected failures");
    const failed = row(
      renderStatus(report({
        hub,
        persistence: { room: `${WORKSPACE}/refused-room`, message: "disk is full" },
      })),
      "failures",
    );
    expect(failed).toContain("1 detected failure — run `ub doctor`");
    expect(failed).toContain("hub state not yet known");
  });
});


describe("project selection in ub status", () => {
  it("reports no selection without opening a replica or borrowing the machine default", () => {
    const box = unboundSandbox({ userConfig: { workspace: WORKSPACE, hubUrl: HUB } });
    const text = runUb(["status"], box);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("No workspace selected");
    expect(text.stdout).not.toContain(WORKSPACE);
    const json = runUb(["status", "--json"], box);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ workspace: null, binding: null, hubUrl: null });
    expect(JSON.parse(json.stdout).account).toBeNull();
    expect(existsSync(join(box.dataHome, "uberblick", `${WORKSPACE}.sqlite`))).toBe(false);
  });

  it("finds the same project binding when run from a nested directory", () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const projectPath = realpathSync(join(box.cwd, ".uberblick.json"));
    const nested = join(box.cwd, "src", "nested");
    mkdirSync(nested, { recursive: true });
    const run = runUb(["status", "--json"], { ...box, cwd: nested });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      workspace: WORKSPACE,
      binding: { workspaceId: WORKSPACE, hubUrl: null },
      projectConfig: projectPath,
      account: null,
      sources: { workspace: "project config", hubUrl: "project config" },
    });
    const text = runUb(["status"], { ...box, cwd: nested });
    expect(text.stdout).toMatch(/hub\s+local \(this computer\)/);
    expect(row(text.stdout, "account")).toBe("");
    expect(text.stdout).toContain(projectPath);
  });
});

describe("the locally stored account in ub status", () => {
  it.each(["previous-user", 'synthetic"\\user\n\u001b\u007f\u009b'])(
    "carries the stored login %j in JSON while the hub is unavailable",
    (username) => {
      const login = fixture([WORKSPACE]);
      login.identity.githubUsername = username;
      const box = sandbox({
        projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
        credentials: { hubLogins: { "http://127.0.0.1:1": login } },
      });
      const json = runUb(["status", "--json"], box);
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({
        account: { login: username, provider: "github" }, credentialPresent: true,
      });
      const text = runUb(["status"], box);
      expect(text.status, text.stderr).toBe(0);
      const auth = runUb(["auth", "status"], box);
      const displayed = row(auth.stdout, "signed in").replace(/^signed in\s+/, "");
      expect(text.stdout).toContain(`hub         ${DEAD_HUB_URL}\naccount     @${displayed} (GitHub)\n`);
      expect(text.output.includes(login.credential.key)).toBe(false);
    },
  );

  it.each([
    { name: "missing", files: {} },
    { name: "another hub", files: { credentials: { hubLogins: { "https://other.example.test": fixture() } } } },
    { name: "unreadable store", files: { raw: { credentials: "{" } } },
    { name: "unreadable hub login", files: { credentials: { hubLogins: { "https://hub.example.test": {} } } } },
    { name: "refused store", files: {
      credentials: { hubLogins: { "https://hub.example.test": fixture() } }, credentialsMode: 0o644,
    } },
  ])("reports no stored account for a $name", ({ files }) => {
    const endpoint = "wss://Hub.Example.Test:443/ws";
    const box = sandbox({ ...files, projectBinding: { workspaceId: WORKSPACE, hubUrl: endpoint } });
    const json = runUb(["status", "--json"], box);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ account: null, credentialPresent: false });
    const text = runUb(["status"], box);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain(`hub         ${endpoint}\naccount     not signed in, run ub auth login https://hub.example.test\n`);
    expect(text.stdout).not.toContain("previous-user");
  });

  it("preserves HTTP in the sign-in hint for plaintext device admission", () => {
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      userConfig: { hubAdmissions: { [DEAD_HUB_URL]: "device" } },
    });
    const text = runUb(["status"], box);
    expect(text.status, text.stderr).toBe(0);
    expect(row(text.stdout, "account")).toBe("account     not signed in, run ub auth login http://127.0.0.1:1");
  });

  it("omits the account for a local workspace even with a login for the fallback hub", () => {
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: null },
      credentials: { hubLogins: { "http://localhost:1234": fixture([WORKSPACE]) } },
    });
    const json = runUb(["status", "--json"], box);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).account).toBeNull();
    const text = runUb(["status"], box);
    expect(row(text.stdout, "account")).toBe("");
  });

  it("omits the account for local signing-secret admission", () => {
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: "local-status-test-secret" },
    });
    const json = runUb(["status", "--json"], box);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ account: null, credentialPresent: true });
    const text = runUb(["status"], box);
    expect(row(text.stdout, "account")).toBe("");
    expect(text.output).not.toContain("local-status-test-secret");
  });
});
