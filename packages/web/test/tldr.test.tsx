/**
 * The document page's human-facing TL;DR (#534).
 *
 * This pins the browser-owned write boundary: the callout is absent when the
 * value is absent, the document-actions entry opens the editor, validation uses
 * schema's shared limit, and both remote metadata changes and a live archive
 * are obeyed without remounting the pane.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import * as Y from "yjs";
import {
  appendBlock,
  getMeta,
  initDoc,
  MAX_TLDR_LENGTH,
  setTldr,
} from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { EditorPane } from "../src/ui/EditorPane.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const UUID = "b4e6f1c2-9d3a-4f57-8c21-5e0a7b9d4c31";

const LIVE: RoomStatus = {
  connected: true,
  synced: true,
  hasReceivedServerState: true,
  writable: true,
  storeRefused: false,
  unsyncedChanges: 0,
  hasAnswered: true,
  protocolMismatch: null,
  authFailed: false,
  tokenMissing: false,
};

function connectionFor(ydoc: Y.Doc): RoomConnection {
  return {
    room: `${WORKSPACE}/${UUID}`,
    ydoc,
    provider: { awareness: null },
    status: LIVE,
    onStatusChange: (listener: (status: RoomStatus) => void) => {
      listener(LIVE);
      return () => {};
    },
  } as unknown as RoomConnection;
}

function documentWith(tldr: string | null): Y.Doc {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: UUID, title: "Sync topology" });
  appendBlock(ydoc, { type: "paragraph", text: "How copies move." });
  setTldr(ydoc, tldr);
  return ydoc;
}

function peerOf(local: Y.Doc): Y.Doc {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(local));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
  peer.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  return peer;
}

let mounted: { root: Root; host: HTMLElement } | null = null;

afterEach(() => {
  const open = mounted;
  mounted = null;
  if (open !== null) {
    act(() => open.root.unmount());
    open.host.remove();
  }
});

async function mountPane(
  ydoc: Y.Doc,
  archived = false,
): Promise<{ host: HTMLElement; root: Root; connection: RoomConnection }> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const connection = connectionFor(ydoc);
  mounted = { root, host };
  await act(async () => {
    root.render(
      <EditorPane
        connection={connection}
        segment={WORKSPACE}
        presence={[]}
        author="reader"
        knownTags={[]}
        archived={archived}
        docLinks={null}
        onRestore={() => {}}
        onSelectThread={() => {}}
      />,
    );
  });
  return { host, root, connection };
}

function typeInto(field: HTMLTextAreaElement | null, value: string): void {
  if (field === null) return;
  const native = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  native?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function openActions(host: HTMLElement): void {
  const trigger = host.querySelector<HTMLButtonElement>(".ub-actions-trigger");
  trigger?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
}

function menuItem(label: string): HTMLElement | undefined {
  return [
    ...document.querySelectorAll<HTMLElement>("[data-slot=dropdown-menu-item]"),
  ].find((item) => item.textContent === label);
}

function field(host: HTMLElement): HTMLTextAreaElement | null {
  return host.querySelector<HTMLTextAreaElement>("#ub-tldr-input");
}

describe("the document TL;DR", () => {
  it("adds, validates, edits and clears through the shared schema boundary", async () => {
    const ydoc = documentWith(null);
    const { host } = await mountPane(ydoc);

    expect(host.querySelector(".ub-tldr")).toBeNull();
    act(() => openActions(host));
    expect(menuItem("Add TL;DR")).not.toBeUndefined();
    act(() => menuItem("Add TL;DR")?.click());
    expect(host.querySelector(".ub-tldr-label")?.textContent).toBe("Quick summary");
    expect(host.querySelector(".ub-tldr h2")?.textContent).toBe("TL;DR");
    expect(host.querySelector(".ub-tldr-form label")?.textContent).toContain(
      "plain-English sentences",
    );

    act(() => typeInto(field(host), "x".repeat(MAX_TLDR_LENGTH + 1)));
    expect(host.querySelector("#ub-tldr-count")?.textContent).toContain(
      `${MAX_TLDR_LENGTH + 1} / ${MAX_TLDR_LENGTH}`,
    );
    act(() => host.querySelector<HTMLButtonElement>("button[type=submit]")?.click());
    expect(host.querySelector("[role=alert]")?.textContent).toContain(
      `at most ${MAX_TLDR_LENGTH} characters`,
    );
    expect(getMeta(ydoc).tldr).toBeNull();

    act(() => typeInto(field(host), "  A short summary for a person.  "));
    act(() => host.querySelector<HTMLButtonElement>("button[type=submit]")?.click());
    expect(getMeta(ydoc).tldr).toBe("A short summary for a person.");
    expect(host.querySelector(".ub-tldr-body > p")?.textContent).toBe(
      "A short summary for a person.",
    );

    act(() => openActions(host));
    act(() => menuItem("Edit TL;DR")?.click());
    act(() =>
      [...host.querySelectorAll<HTMLButtonElement>(".ub-tldr-actions button")]
        .find((button) => button.textContent === "Clear")
        ?.click(),
    );
    expect(getMeta(ydoc).tldr).toBeNull();
    expect(host.querySelector(".ub-tldr")).toBeNull();
  });

  it("follows a remote value and guards an edit when the document is archived", async () => {
    const ydoc = documentWith("The first summary.");
    const peer = peerOf(ydoc);
    const { host, root, connection } = await mountPane(ydoc);

    act(() => setTldr(peer, "Changed by another client."));
    expect(host.querySelector(".ub-tldr-body > p")?.textContent).toBe(
      "Changed by another client.",
    );

    act(() => openActions(host));
    act(() => menuItem("Edit TL;DR")?.click());
    act(() =>
      root.render(
        <EditorPane
          connection={connection}
          segment={WORKSPACE}
          presence={[]}
          author="reader"
          knownTags={[]}
          archived={true}
          docLinks={null}
          onRestore={() => {}}
          onSelectThread={() => {}}
        />,
      ),
    );
    expect(field(host)?.readOnly).toBe(true);
    expect(host.querySelector(".ub-tldr-form-meta")?.textContent).toContain(
      "Restore to edit",
    );
    act(() => typeInto(field(host), "Typed through the read-only field."));
    act(() => host.querySelector<HTMLFormElement>(".ub-tldr-form")?.requestSubmit());
    expect(getMeta(ydoc).tldr).toBe("Changed by another client.");

    act(() => setTldr(peer, null));
    // The in-progress draft stays visible and read-only while archived; cancel
    // reveals the remote clear, with no empty callout left behind.
    act(() =>
      [...host.querySelectorAll<HTMLButtonElement>(".ub-tldr-actions button")]
        .find((button) => button.textContent === "Cancel")
        ?.click(),
    );
    expect(host.querySelector(".ub-tldr")).toBeNull();
  });
});
