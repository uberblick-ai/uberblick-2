/**
 * The document page's human-facing TL;DR (#534).
 *
 * This pins the browser-owned write boundary: the callout is absent when the
 * value is absent, inline and document-actions editing share the same form,
 * unsaved drafts never write, validation uses schema's shared limit, and live
 * read-only changes are obeyed without remounting the pane.
 */

import { describe, expect, it, vi } from "vitest";
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

type TestConnection = RoomConnection & {
  setWritable(writable: boolean): void;
};

function connectionFor(ydoc: Y.Doc, writable: boolean): TestConnection {
  const listeners = new Set<(status: RoomStatus) => void>();
  const connection = {
    room: `${WORKSPACE}/${UUID}`,
    ydoc,
    provider: { awareness: null },
    status: { ...LIVE, writable },
    onStatusChange: (listener: (status: RoomStatus) => void) => {
      listeners.add(listener);
      listener(connection.status);
      return () => { listeners.delete(listener); };
    },
    setWritable(next: boolean) {
      connection.status = { ...connection.status, writable: next };
      for (const listener of listeners) listener(connection.status);
    },
  } as unknown as TestConnection;
  return connection;
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
  writable = true,
): Promise<{ host: HTMLElement; view: RenderResult; connection: TestConnection }> {
  const connection = connectionFor(ydoc, writable);
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

async function openInline(host: HTMLElement): Promise<void> {
  act(() => within(host).getByRole("button", { name: "Edit TL;DR" }).click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function press(field: HTMLTextAreaElement | null, key: string, init: KeyboardEventInit = {}): void {
  field?.dispatchEvent(new KeyboardEvent("keydown", {
    key, bubbles: true, cancelable: true, ...init,
  }));
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

    await openInline(host);
    act(() => within(host).getByRole("button", { name: "Clear" }).click());
    expect(getMeta(ydoc).tldr).toBeNull();
    expect(within(host).queryByRole("region", { name: "TL;DR" })).toBeNull();
  });

  it("focuses an inline edit and shares Enter saves with another client", async () => {
    const ydoc = documentWith("The first summary.");
    const peer = peerOf(ydoc);
    const { host } = await mountPane(ydoc);

    await openInline(host);
    expect(document.activeElement).toBe(field(host));
    expect(field(host)?.value).toBe("The first summary.");
    expect(within(host).getByText(`18 / ${MAX_TLDR_LENGTH} characters`)).toBeDefined();
    act(() => typeInto(field(host), "Changed in place."));
    act(() => press(field(host), "Enter"));
    expect(getMeta(ydoc).tldr).toBe("Changed in place.");
    expect(getMeta(peer).tldr).toBe("Changed in place.");
    expect(field(host)).toBeNull();
    expect(within(host).getByRole("button", { name: "Edit TL;DR" }).textContent).toBe("Changed in place.");
    peer.destroy();
  });

  it("closes unchanged blur and cancellation without writes, but keeps a changed draft open", async () => {
    const ydoc = documentWith("The first summary.");
    const peer = peerOf(ydoc);
    const { host } = await mountPane(ydoc);
    const updates = vi.fn();
    ydoc.on("update", updates);

    await openInline(host);
    const clear = within(host).getByRole("button", { name: "Clear" });
    act(() => clear.focus());
    expect(field(host)).not.toBeNull();
    act(() => clear.blur());
    expect(field(host)).toBeNull();
    expect(updates).not.toHaveBeenCalled();

    await openInline(host);
    act(() => typeInto(field(host), "A draft that has not been saved."));
    act(() => field(host)?.blur());
    expect(field(host)?.value).toBe("A draft that has not been saved.");
    expect(getMeta(ydoc).tldr).toBe("The first summary.");
    expect(updates).not.toHaveBeenCalled();
    act(() => press(field(host), "Escape"));
    expect(field(host)).toBeNull();
    expect(updates).not.toHaveBeenCalled();

    await openInline(host);
    expect(field(host)?.value).toBe("The first summary.");
    act(() => typeInto(field(host), "Another uncommitted draft."));
    act(() => within(host).getByRole("button", { name: "Cancel" }).click());
    expect(field(host)).toBeNull();
    expect(getMeta(ydoc).tldr).toBe("The first summary.");
    expect(updates).not.toHaveBeenCalled();

    await openInline(host);
    act(() => setTldr(peer, "Changed by another client."));
    expect(field(host)?.value).toBe("The first summary.");
    updates.mockClear();
    act(() => field(host)?.blur());
    expect(field(host)).toBeNull();
    expect(getMeta(ydoc).tldr).toBe("Changed by another client.");
    expect(updates).not.toHaveBeenCalled();
    peer.destroy();
  });

  it("keeps composition, Shift+Enter and overlong Enter from saving", async () => {
    const ydoc = documentWith("The first summary.");
    const { host } = await mountPane(ydoc);
    const updates = vi.fn();
    ydoc.on("update", updates);
    await openInline(host);
    act(() => typeInto(field(host), "A composed draft."));
    act(() => press(field(host), "Enter", { isComposing: true }));
    act(() => press(field(host), "Enter", { keyCode: 229 }));
    act(() => press(field(host), "Escape", { isComposing: true }));
    act(() => press(field(host), "Escape", { keyCode: 229 }));
    act(() => press(field(host), "Enter", { shiftKey: true }));
    expect(field(host)?.value).toBe("A composed draft.");
    expect(updates).not.toHaveBeenCalled();

    const overlong = "x".repeat(MAX_TLDR_LENGTH + 1);
    act(() => typeInto(field(host), overlong));
    act(() => press(field(host), "Enter"));
    expect(field(host)?.value).toBe(overlong);
    expect(within(host).getByText(`${MAX_TLDR_LENGTH + 1} / ${MAX_TLDR_LENGTH} characters`)).toBeDefined();
    expect(within(host).getByRole("alert").textContent).toBe(`A TL;DR is at most ${MAX_TLDR_LENGTH} characters.`);
    expect(getMeta(ydoc).tldr).toBe("The first summary.");
    expect(updates).not.toHaveBeenCalled();
  });

  it.each([
    { state: "archived", archived: true, writable: true },
    { state: "unwritable", archived: false, writable: false },
  ])("keeps an initially $state TL;DR read-only", async ({ archived, writable }) => {
    const ydoc = documentWith("The first summary.");
    const { host } = await mountPane(ydoc, archived, writable);
    const updates = vi.fn();
    ydoc.on("update", updates);
    const text = within(host).getByText("The first summary.");
    act(() => text.click());
    expect(within(host).queryByRole("button", { name: "Edit TL;DR" })).toBeNull();
    expect(field(host)).toBeNull();
    expect(updates).not.toHaveBeenCalled();
  });

  it("guards unwritable saves and activation before the rendered status catches up", async () => {
    const ydoc = documentWith("The first summary.");
    const { host, connection } = await mountPane(ydoc);
    await openInline(host);
    act(() => typeInto(field(host), "An unsaved draft."));
    const updates = vi.fn();
    ydoc.on("update", updates);
    // This deliberately withholds the subscription notification: the committed
    // field and controls still look writable while the connection refuses it.
    connection.status = { ...connection.status, writable: false };
    expect(field(host)?.readOnly).toBe(false);
    act(() => press(field(host), "Enter"));
    act(() => within(host).getByRole<HTMLFormElement>("form", { name: "Edit TL;DR" }).requestSubmit());
    act(() => within(host).getByRole("button", { name: "Clear" }).click());
    expect(getMeta(ydoc).tldr).toBe("The first summary.");
    expect(updates).not.toHaveBeenCalled();

    act(() => connection.setWritable(false));
    expect(field(host)?.readOnly).toBe(true);
    expect(within(host).getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
    expect(within(host).getByRole<HTMLButtonElement>("button", { name: "Clear" }).disabled).toBe(true);
    act(() => within(host).getByRole("button", { name: "Cancel" }).click());
    expect(within(host).queryByRole("button", { name: "Edit TL;DR" })).toBeNull();

    act(() => connection.setWritable(true));
    connection.status = { ...connection.status, writable: false };
    act(() => within(host).getByRole("button", { name: "Edit TL;DR" }).click());
    expect(field(host)).toBeNull();
    expect(updates).not.toHaveBeenCalled();
  });

  it("follows a remote value and guards an edit when the document is archived", async () => {
    const ydoc = documentWith("The first summary.");
    const peer = peerOf(ydoc);
    const { host, view, connection } = await mountPane(ydoc);

    act(() => setTldr(peer, "Changed by another client."));
    expect(within(host).getByText("Changed by another client.").textContent).toBe(
      "Changed by another client.",
    );

    await openInline(host);
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
