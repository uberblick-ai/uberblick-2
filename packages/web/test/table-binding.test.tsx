/** Legacy normalization and the palette gate on the actual bound page. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { getBlocks, getBlocksFragment, initDoc, tableRows } from "@uberblick/schema";
import type { RoomConnection, RoomStatus } from "../src/collab/rooms.js";
import { EditorPane } from "../src/ui/EditorPane.js";

const WORKSPACE = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const UUID = "9f3c1a2b-0000-4000-8000-0123456789ab";
const SOURCE = "| name | count |\n| --- | --- |\n| alpha | 1 |";
const LIVE: RoomStatus = { connected: true, synced: true, writable: true,
  hasReceivedServerState: true, hasAnswered: true, storeRefused: false,
  unsyncedChanges: 0, protocolMismatch: null, authFailed: false, tokenMissing: false };
const roots: Array<() => void> = [];
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});
afterEach(() => { for (const destroy of roots.splice(0)) destroy(); vi.restoreAllMocks(); });

function legacy(id: string): Y.XmlElement {
  const block = new Y.XmlElement("table"); block.setAttribute("id", id);
  block.insert(0, [new Y.XmlText(SOURCE)]); return block;
}
function fixture(status = LIVE) {
  const ydoc = new Y.Doc(); initDoc(ydoc, { uuid: UUID, title: "Tables" });
  getBlocksFragment(ydoc).insert(0, [legacy("table-one")]);
  const listeners = new Set<(reading: RoomStatus) => void>();
  const connection = { room: `${WORKSPACE}/${UUID}`, ydoc, provider: { awareness: null }, status: { ...status },
    onStatusChange(listener: (reading: RoomStatus) => void) {
      listeners.add(listener); listener(connection.status); return () => { listeners.delete(listener); };
    },
  } as unknown as RoomConnection;
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(() => { act(() => root.unmount()); host.remove(); ydoc.destroy(); });
  const selectThread = () => {};
  act(() => root.render(<EditorPane connection={connection} segment={WORKSPACE} presence={[]}
    author="Reader" archived={false} docLinks={null} onRestore={null} onSelectThread={selectThread} />));
  return { host, ydoc, connection, status(patch: Partial<RoomStatus>) {
    act(() => { Object.assign(connection.status, patch); for (const listener of listeners) listener(connection.status); });
  } };
}

it("waits for writable and synchronized state, then converts and binds without reloading", () => {
  const fix = fixture({ ...LIVE, writable: false, synced: false });
  expect(fix.host.querySelector(".ProseMirror")).toBeNull();
  expect((getBlocksFragment(fix.ydoc).get(0) as Y.XmlElement).firstChild).toBeInstanceOf(Y.XmlText);
  fix.status({ writable: true });
  expect(fix.host.querySelector(".ProseMirror")).toBeNull();
  fix.status({ synced: true });
  expect(fix.host.querySelectorAll(".ub-table th")).toHaveLength(2);
  expect(fix.host.querySelectorAll(".ub-table td")).toHaveLength(2);
  expect(getBlocks(fix.ydoc)[0]).toMatchObject({ id: "table-one", text: SOURCE });
});

it("binds initially writable legacy content and rebinds after a late legacy write", () => {
  const fix = fixture();
  expect(fix.host.querySelectorAll(".ub-table")).toHaveLength(1);
  act(() => getBlocksFragment(fix.ydoc).insert(1, [legacy("late-table")]));
  expect(fix.host.querySelectorAll(".ub-table")).toHaveLength(2);
  expect(getBlocks(fix.ydoc).map((block) => block.id)).toEqual(["table-one", "late-table"]);
});

it("keeps malformed table content intact behind the disabled fallback", () => {
  const fix = fixture();
  const table = getBlocksFragment(fix.ydoc).get(0) as Y.XmlElement;
  const cell = tableRows(table)[0]![0]!;
  act(() => (cell as unknown as { setAttribute(key: string, value: unknown): void }).setAttribute("rowspan", 2));
  expect(fix.host.querySelector(".ProseMirror")).toBeNull();
  expect(cell.getAttribute("rowspan")).toBe(2);
  expect(getBlocks(fix.ydoc)[0]?.text).toBe(SOURCE);
  expect(fix.host.textContent).toContain("Editor disabled");
});
