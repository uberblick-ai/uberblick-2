/** The human overview stays bounded; the report keeps its machine detail. */

import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import { describe, expect, it } from "vitest";
import type { StatusReport } from "../src/status.js";
import { renderStatus } from "../src/status.js";

const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";
const HUB = "wss://hub.example.test/ws";

function report(overrides: Partial<StatusReport> = {}): StatusReport {
  return {
    version: "1.2.3",
    workspace: WORKSPACE,
    workspaceUuid: WORKSPACE,
    hubUrl: HUB,
    databasePath: "/workspace/replica.sqlite",
    credentialPresent: true,
    credentialSource: "credentials file",
    sources: { workspace: "user config", hubUrl: "environment" },
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
    expect(text).not.toMatch(/credential|shadowed|user config|environment/);
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
    "counts %s and sends its details to doctor",
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
      expect(text).not.toContain("failure detail that belongs in doctor");
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
