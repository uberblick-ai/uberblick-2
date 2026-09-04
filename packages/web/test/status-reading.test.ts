/**
 * The one derivation four surfaces read (#448).
 *
 * What is worth pinning here is the *precedence*, because that is the whole
 * reason this is one function: three surfaces used to re-derive their own
 * reading, none of them looked at the failure flags, and a page the hub had
 * refused read `syncing…` in all three. The words themselves are pinned once,
 * here, rather than again in each surface's test — those assert that the
 * surface shows the derivation's word, not what the word is.
 */

import { describe, expect, it } from "vitest";
import { AUTH_REJECTED } from "@uberblick/hub/protocol";
import type { RoomStatus } from "../src/collab/rooms.js";
import type { SyncState } from "../src/ui/calm.js";
import {
  STORE_REFUSED,
  TOKEN_MISSING,
  statusReading,
} from "../src/ui/status-reading.js";

/** A room that is connected, synced and refused by nothing. */
const CALM: RoomStatus = {
  connected: true,
  synced: true,
  writable: true,
  storeRefused: false,
  unsyncedChanges: 0,
  localReplicaLoaded: true,
  hasLocalCache: false,
  protocolMismatch: null,
  authFailed: false,
  tokenMissing: false,
};

function read(patch: Partial<RoomStatus>, settled: SyncState = "synced") {
  return statusReading({ ...CALM, ...patch }, settled);
}

describe("a refusal is read before the connection is", () => {
  /**
   * Every rung of the precedence, each with the rung below it also set — which
   * is the only way a table proves an order rather than three separate cases.
   * The mismatch rows also carry `connected: false`, because the halt settles
   * that flag: a reading that consulted the calm state first would call a page
   * that can never sync again merely `offline`.
   */
  const table: Array<{
    name: string;
    status: Partial<RoomStatus>;
    word: string;
    detail: string;
  }> = [
    {
      name: "a mismatch outranks every other flag, halted socket and all",
      status: {
        connected: false,
        synced: false,
        protocolMismatch: { hub: 2, client: 1 },
        storeRefused: true,
        tokenMissing: true,
        authFailed: true,
      },
      word: "update required",
      detail:
        "this app is older than the hub — update it and reload (app 1, hub 2); " +
        "this document is not saved",
    },
    {
      name: "a store refusal outranks reconnectable token failures",
      status: { storeRefused: true, tokenMissing: true, authFailed: true },
      word: "edit refused",
      detail: STORE_REFUSED,
    },
    {
      name: "the other direction names the hub as what to update",
      status: { connected: false, protocolMismatch: { hub: 1, client: 2 } },
      word: "update required",
      detail:
        "the hub is older than this app — update the hub (app 2, hub 1); " +
        "this document is not saved",
    },
    {
      name: "a missing token outranks a refusal left over from before it went missing",
      status: { tokenMissing: true, authFailed: true },
      word: "no hub token",
      detail: TOKEN_MISSING,
    },
    {
      name: "a refusal names both causes, in the hub's stead",
      status: { authFailed: true },
      word: "not authorized",
      detail: `${AUTH_REJECTED}; this document is not saved`,
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      const reading = read(row.status);
      expect(reading.word).toBe(row.word);
      expect(reading.detail).toBe(row.detail);
      // Every refusal is drawn as offline: the off dot, the destructive tint.
      expect(reading.tone).toBe("offline");
    });
  }
});

describe("nothing refused reads as the settled state, and says so", () => {
  it("carries the calm word and no detail at all", () => {
    // Null detail is the discriminator the sidebar and the sync panel read —
    // "this is the ordinary reading" — so it is part of the contract.
    expect(read({}, "synced")).toEqual({ word: "synced", detail: null, tone: "synced" });
    expect(read({}, "syncing")).toEqual({
      word: "syncing…",
      detail: null,
      tone: "syncing",
    });
    expect(read({ connected: false, synced: false }, "offline")).toEqual({
      word: "offline",
      detail: null,
      tone: "offline",
    });
  });

  it("reads a lowered authFailed as the ordinary word again", () => {
    // `authFailed` is not terminal, so the derivation has to answer for a
    // lowered flag as well as a raised one. What lowers it — a hub unloading a
    // room refuses, the next `authenticated` clears — is `collab/rooms.ts`'s
    // behavior and is pinned there, not here.
    expect(read({ authFailed: true }, "synced").word).toBe("not authorized");
    expect(read({ authFailed: false }, "synced").word).toBe("synced");
  });
});
