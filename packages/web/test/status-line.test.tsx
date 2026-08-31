/**
 * The status line's sync-backlog label.
 *
 * `sync_status` reports a count of unsynced *rooms*; this reports a count of
 * provider sync *messages* awaiting acknowledgement. Both used to read
 * "pending", which made two correct numbers look like a contradiction during an
 * outage. The rendered wording is the fix, so it is what the test pins — down to
 * the unit, because the honest unit here is messages and not updates.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { StatusLine } from "../src/ui/EditorPane.js";
import { TOKEN_MISSING } from "../src/ui/status-reading.js";
import { AUTH_REJECTED } from "@uberblick/hub/protocol";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import type { RemotePresence } from "../src/ui/doc-chrome.js";

/** The workspace these stub room keys sit in. A workspace id is a uuid. */
const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";

/** Nobody else in the room: this suite is about the line, not the strip. */
const NOBODY: readonly RemotePresence[] = [];

/** A connection that only reports status — no socket, no awareness, no peers. */
function stubConnection(
  unsyncedChanges: number,
  patch: Partial<RoomStatus> = {},
): RoomConnection {
  const status: RoomStatus = {
    connected: false,
    synced: false,
    unsyncedChanges,
    localReplicaLoaded: false,
    hasLocalCache: false,
    protocolMismatch: null,
    authFailed: false,
    tokenMissing: false,
    ...patch,
  };
  return {
    room: `${WORKSPACE}/doc`,
    provider: { awareness: null },
    status,
    onStatusChange: (listener: (next: RoomStatus) => void) => {
      listener(status);
      return () => {};
    },
  } as unknown as RoomConnection;
}

function label(
  unsyncedChanges: number,
  patch: Partial<RoomStatus> = {},
): string | null {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <StatusLine
        connection={stubConnection(unsyncedChanges, patch)}
        presence={NOBODY}
      />,
    ),
  );
  const text = host.querySelector(".ub-pending")?.textContent ?? null;
  act(() => root.unmount());
  host.remove();
  return text?.replace(/\s+/g, " ").trim() ?? null;
}

describe("the status line names the unit of its backlog count", () => {
  it("reads in sync messages, not the bare word pending", () => {
    expect(label(38)).toBe("38 sync messages unacked");
    expect(label(1)).toBe("1 sync message unacked");
  });

  it("says nothing when everything is acknowledged", () => {
    expect(label(0)).toBeNull();
  });

});

/** The whole line, for a room in the given state. */
function line(patch: Partial<RoomStatus>): string {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <StatusLine
        connection={stubConnection(0, patch)}
        presence={NOBODY}
      />,
    ),
  );
  const text = host.querySelector(".ub-status")?.textContent ?? "";
  act(() => root.unmount());
  host.remove();
  return text.replace(/\s+/g, " ").trim();
}

describe("a hub that refuses this page", () => {
  it("says an update is needed, and which side needs it", () => {
    // A reading of its own, not a fourth sync state: the other three describe a
    // connection that works or is coming back, and this one describes a page
    // that will not sync again until somebody updates something. Both integers
    // are shown because "which side" is the only actionable part.
    const older = line({ protocolMismatch: { hub: 2, client: 1 } });
    expect(older).toContain("update required");
    expect(older).toContain("this app is older than the hub");
    expect(older).toContain("(app 1, hub 2)");

    const newer = line({ protocolMismatch: { hub: 1, client: 2 } });
    expect(newer).toContain("the hub is older than this app");
    expect(newer).toContain("(app 2, hub 1)");

    // Neither reading appears without its refusal, whichever sync state the
    // room is in — they replace the line, so a false positive hides the truth.
    expect(line({})).not.toContain("update required");
    expect(line({ connected: true, synced: true })).not.toContain("update required");
    expect(line({})).not.toContain(AUTH_REJECTED);
  });

  it("names both causes when the refusal was not a version mismatch", () => {
    // An older hub cannot read our envelope and answers exactly as a wrong
    // secret does, so this is the one direction nothing can detect: the copy
    // names both causes rather than guessing, and it is composed locally —
    // the hub's own words never reach the line.
    expect(line({ authFailed: true })).toContain(AUTH_REJECTED);
  });
});

describe("an app served without a token", () => {
  it("names the missing token rather than blaming the hub", () => {
    // Since #426 the secret arrives in the served configuration document, so a
    // deployment can be complete in every other way and still hand out an app
    // that cannot authenticate. The reader is told which half is missing: no
    // token was ever sent, so "the hub refused us" would be false, and the
    // deployment is what can be fixed. Composed locally — the missing value is
    // the whole subject, so there is nothing remote to echo.
    const missing = line({ tokenMissing: true });
    expect(missing).toContain("no hub token");
    expect(missing).toContain(TOKEN_MISSING);
    expect(missing).not.toContain(AUTH_REJECTED);

    // It outranks a refusal left over from before the secret went missing, and
    // it never appears without one.
    expect(line({ tokenMissing: true, authFailed: true })).toContain(TOKEN_MISSING);
    expect(line({ connected: true, synced: true })).not.toContain(TOKEN_MISSING);
  });
});

/**
 * What the settled line says about a local copy, or null when it says nothing.
 *
 * Settled on purpose: every mount starts at "offline" and debounces towards the
 * truth, so a line read before the window is up would answer for a state the
 * reader never sees — which is exactly how "nothing while synced" would pass
 * against a line that says it all the time.
 */
function localCopyNote(patch: Partial<RoomStatus>): string | null {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <StatusLine connection={stubConnection(0, patch)} presence={NOBODY} />,
    ),
  );
  act(() => void vi.advanceTimersByTime(5_000));
  const note = host.querySelector(".ub-status .ub-local-copy")?.textContent ?? null;
  act(() => root.unmount());
  host.remove();
  return note;
}

describe("the line says whether a durable local copy is here", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says nothing about it while the reading is synced", () => {
    // A promise nobody is waiting on. It stood permanently beside a healthy
    // "synced" and is now one click away in the sync panel instead (#535).
    expect(
      localCopyNote({
        connected: true,
        synced: true,
        localReplicaLoaded: true,
        hasLocalCache: true,
      }),
    ).toBeNull();
  });

  it("claims nothing either way before the local read settles", () => {
    // `hasLocalCache` is false while the IndexedDB read is still running as
    // well as where there is nothing to find, and those are different claims.
    expect(localCopyNote({ hasLocalCache: false })).toBeNull();
  });

  it("states availability once it is known, refusal included", () => {
    expect(localCopyNote({ localReplicaLoaded: true, hasLocalCache: true })).toBe(
      "local copy",
    );
    // `localReplicaLoaded` means the read is *over*, and it is over instantly
    // where there is no IndexedDB to read or it refused to open — environments
    // with no cache at all. Telling a reader their document survives a reload
    // there would be a promise the browser cannot keep.
    expect(localCopyNote({ localReplicaLoaded: true, hasLocalCache: false })).toBe(
      "no local copy",
    );
    // And under a refusal, which is the state it matters most in: nothing will
    // sync again until somebody acts, so whether the work is durably here is
    // the one thing on this line that is still worth reading.
    //
    // `connected`/`synced` are true on purpose, and they are what make this
    // case worth its lines. The gate is `reading.tone`, not the calm `state`,
    // and only a refusal that arrives while the socket still looks healthy
    // tells the two apart: `statusReading` forces `tone` to "offline" for a
    // refusal, while the calm state settles to "synced". Reading the calm
    // state here would suppress the note in exactly the situation the owner
    // asked for it, and with an ordinary offline fixture both gates agree and
    // the mistake passes (Codex round 1 proved it by mutation).
    expect(
      localCopyNote({
        connected: true,
        synced: true,
        protocolMismatch: { hub: 2, client: 1 },
        localReplicaLoaded: true,
        hasLocalCache: true,
      }),
    ).toBe("local copy");
  });
});

/**
 * The badge is hidden while the indicator reads "synced" (#76), which is only
 * safe because a backlog is itself what stops the state being `synced`. The trap
 * is `provider.isSynced`: the initial handshake raises it and nothing ever
 * lowers it, so a room with writes stranded at the hub keeps reporting
 * `synced: true` — and reading that flag alone would leave the line showing a
 * green dot and no badge for as long as the outage lasted.
 *
 * This has to be asserted on the *settled* line. Every mount starts at
 * "offline" and debounces towards the truth, so a line read before the window
 * is up shows the badge whatever the derivation does — which is exactly how a
 * broken derivation slips past an unsettled assertion.
 */
describe("a backlog is delayed by the calm treatment, never hidden by it", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function settledLine(status: Partial<RoomStatus>): {
    word: string | null;
    badge: string | null;
  } {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <StatusLine
          connection={stubConnection(4, status)}
          presence={NOBODY}
        />,
      ),
    );
    // Past every settle window, so what is on screen is what the reader sees.
    act(() => void vi.advanceTimersByTime(5_000));
    const read = {
      word: host.querySelector(".ub-status-word")?.textContent ?? null,
      badge:
        host.querySelector(".ub-pending")?.textContent?.replace(/\s+/g, " ").trim() ??
        null,
    };
    act(() => root.unmount());
    host.remove();
    return read;
  }

  it("reports a backlog the provider's synced flag has stopped tracking", () => {
    expect(settledLine({ connected: true, synced: true })).toEqual({
      word: "syncing…",
      badge: "4 sync messages unacked",
    });
  });

  it("says synced, with no badge, once the backlog is actually empty", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <StatusLine
          connection={stubConnection(0, { connected: true, synced: true })}
          presence={NOBODY}
        />,
      ),
    );
    act(() => void vi.advanceTimersByTime(5_000));
    expect(host.querySelector(".ub-status-word")?.textContent).toBe("synced");
    expect(host.querySelector(".ub-pending")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});
