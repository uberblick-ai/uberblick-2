/**
 * The document page's human-facing TL;DR (#534).
 *
 * This pins the browser-owned write boundary: the callout is absent when the
 * value is absent, the document-actions entry opens the editor, validation uses
 * schema's shared limit, and both remote metadata changes and a live archive
 * are obeyed without remounting the pane.
 */

import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { act, renderSettled, type RenderResult } from "./react-render.js";
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

async function mountPane(
  ydoc: Y.Doc,
  archived = false,
): Promise<{ host: HTMLElement; view: RenderResult; connection: RoomConnection }> {
  const connection = connectionFor(ydoc);
  const view = await renderSettled(
    <EditorPane
      connection={connection}
      segment={WORKSPACE}
      presence={[]}
      author="reader"
      archived={archived}
      docLinks={null}
      onRestore={() => {}}
      onSelectThread={() => {}}
    />,
  );
  return { host: view.container, view, connection };
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
  const trigger = within(host).getByRole("button", { name: "Document actions" });
  trigger?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
}

function menuItem(label: string): HTMLElement | undefined {
  return screen.queryByRole("menuitem", { name: label }) ?? undefined;
}

function field(host: HTMLElement): HTMLTextAreaElement | null {
  return within(host).queryByRole<HTMLTextAreaElement>("textbox", {
    name: /Write one or two plain-English sentences/,
  });
}

describe("the document TL;DR", () => {
  it("adds, validates, edits and clears through the shared schema boundary", async () => {
    const ydoc = documentWith(null);
    const { host } = await mountPane(ydoc);

    expect(within(host).queryByRole("region", { name: "TL;DR" })).toBeNull();
    act(() => openActions(host));
    expect(menuItem("Add TL;DR")).not.toBeUndefined();
    act(() => menuItem("Add TL;DR")?.click());
    expect(within(host).getByText("Quick summary").textContent).toBe("Quick summary");
    expect(within(host).getByRole("heading", { name: "TL;DR" }).textContent).toBe("TL;DR");
    // Decorative, aria-hidden icon has no accessible handle.
    expect(host.querySelector(".ub-tldr-icon")).not.toBeNull();
    expect(within(host).getByText(/Write one or two plain-English sentences/).textContent).toContain(
      "plain-English sentences",
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(field(host));

    act(() => typeInto(field(host), "x".repeat(MAX_TLDR_LENGTH + 1)));
    expect(within(host).getByText(`${MAX_TLDR_LENGTH + 1} / ${MAX_TLDR_LENGTH} characters`).textContent).toContain(
      `${MAX_TLDR_LENGTH + 1} / ${MAX_TLDR_LENGTH}`,
    );
    act(() => within(host).getByRole("button", { name: "Save" }).click());
    expect(within(host).getByRole("alert").textContent).toContain(
      `at most ${MAX_TLDR_LENGTH} characters`,
    );
    expect(getMeta(ydoc).tldr).toBeNull();

    const atLimit = "x".repeat(MAX_TLDR_LENGTH);
    act(() => typeInto(field(host), atLimit));
    act(() => within(host).getByRole("button", { name: "Save" }).click());
    expect(getMeta(ydoc).tldr).toBe(atLimit);

    act(() => openActions(host));
    act(() => menuItem("Edit TL;DR")?.click());
    act(() => typeInto(field(host), "  A short summary for a person.  "));
    act(() => within(host).getByRole("button", { name: "Save" }).click());
    expect(getMeta(ydoc).tldr).toBe("A short summary for a person.");
    expect(within(host).getByText("A short summary for a person.").textContent).toBe(
      "A short summary for a person.",
    );

    act(() => openActions(host));
    act(() => menuItem("Edit TL;DR")?.click());
    act(() => within(host).getByRole("button", { name: "Clear" }).click());
    expect(getMeta(ydoc).tldr).toBeNull();
    expect(within(host).queryByRole("region", { name: "TL;DR" })).toBeNull();
  });

  it("follows a remote value and guards an edit when the document is archived", async () => {
    const ydoc = documentWith("The first summary.");
    const peer = peerOf(ydoc);
    const { host, view, connection } = await mountPane(ydoc);

    act(() => setTldr(peer, "Changed by another client."));
    expect(within(host).getByText("Changed by another client.").textContent).toBe(
      "Changed by another client.",
    );

    act(() => openActions(host));
    act(() => menuItem("Edit TL;DR")?.click());
    view.rerender(
      <EditorPane
        connection={connection}
        segment={WORKSPACE}
        presence={[]}
        author="reader"
        archived={true}
        docLinks={null}
        onRestore={() => {}}
        onSelectThread={() => {}}
      />,
    );
    expect(field(host)?.readOnly).toBe(true);
    expect(within(host).getByText("Restore to edit.").textContent).toContain(
      "Restore to edit",
    );
    act(() => typeInto(field(host), "Typed through the read-only field."));
    act(() => within(host).getByRole<HTMLFormElement>("form", { name: "Edit TL;DR" }).requestSubmit());
    expect(getMeta(ydoc).tldr).toBe("Changed by another client.");

    act(() => setTldr(peer, null));
    // The in-progress draft stays visible and read-only while archived; cancel
    // reveals the remote clear, with no empty callout left behind.
    act(() => within(host).getByRole("button", { name: "Cancel" }).click());
    expect(within(host).queryByRole("region", { name: "TL;DR" })).toBeNull();
  });
});
