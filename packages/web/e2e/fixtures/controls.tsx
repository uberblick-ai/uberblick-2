/** Focused production controls and document-list shell; Textarea is recipe-only. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { createTagCatalogEntry } from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import * as Y from "yjs";
import type { RoomConnection, RoomStatus } from "../../src/collab/rooms.js";
import { DocumentList, INITIAL_DOCUMENT_LIST_STATE } from "../../src/shell/DocumentList.js";
import type { DocumentListState } from "../../src/shell/DocumentList.js";
import { Sidebar, SidebarProvider } from "../../src/ui/shadcn/sidebar.js";
import { Button } from "../../src/ui/shadcn/button.js";
import { Input } from "../../src/ui/shadcn/input.js";
import { Textarea } from "../../src/ui/shadcn/textarea.js";
import "../../src/ui/styles.css";
import "../../src/ui/tailwind.css";

const root = document.getElementById("root");
if (root === null) throw new Error("no fixture root");

const fixture = new URLSearchParams(location.search).get("document-list");
const live: RoomStatus = {
  connected: true, synced: true, hasReceivedServerState: true, writable: true,
  storeRefused: false, unsyncedChanges: 0, hasAnswered: true,
  protocolMismatch: null, authFailed: false, tokenMissing: false,
};

function listConnection(ydoc: Y.Doc): RoomConnection {
  return {
    ydoc, status: live,
    onStatusChange: (listener: (status: RoomStatus) => void) => { listener(live); return () => {}; },
  } as unknown as RoomConnection;
}

function DocumentListFixture() {
  const [data] = useState(() => {
    const catalog = new Y.Doc();
    const normalTags = (fixture === "font" ? ["billing", "permissions", "auth", "mcp", "rfc", "sync"] : ["auth", "billing", "mcp", "rfc", "sync"])
      .map((name) => createTagCatalogEntry(catalog, name));
    const longTags = fixture === "overflow" ? Array.from({ length: 8 }, (_, index) =>
      createTagCatalogEntry(catalog, `measure-${index}-long-overflow-tags`)) : [];
    const regular = [
      { uuid: "00000000-0000-4000-8000-000000000001", title: "Document A", tags: [], updatedAt: 100 },
      { uuid: "00000000-0000-4000-8000-000000000002", title: "Document Z", tags: [], updatedAt: 200 },
    ];
    const topic = "00000000-0000-4000-8000-000000000003";
    const entries: DirectoryEntry[] = fixture === "overflow" ? [{
      uuid: topic, title: "Long tags", tags: longTags.map((tag) => tag.id), updatedAt: Date.now(),
    }] : fixture === "font" ? [{
      uuid: topic, title: "Font arrival", tags: normalTags.map((tag) => tag.id), updatedAt: Date.now(),
    }] : [
      ...regular,
      { uuid: topic, topic, title: "Current topic", kind: "decision", status: "decided", tags: normalTags.map((tag) => tag.id),
        updatedAt: Date.now(), decidedBy: "A member", decidedAt: "2026-10-04" },
      { uuid: "00000000-0000-4000-8000-000000000004", topic, title: "Current topic", kind: "decision", status: "open", supersedes: topic, tags: [] },
    ];
    return { catalog: listConnection(catalog), directory: listConnection(new Y.Doc()), entries,
      searchClient: { search: async () => entries.map((entry) => entry.uuid) } };
  });
  const [state, setState] = useState<DocumentListState>(() => ({
    ...INITIAL_DOCUMENT_LIST_STATE,
    mode: fixture === "wrap" ? "decision" as const : "working" as const,
    stateFilter: new URLSearchParams(location.search).get("state") === "changed-after-approval" ? "changed-after-approval" as const : "all" as const,
  }));
  const [selected, setSelected] = useState("");
  return <main className="ub-app flex h-dvh flex-col" data-document-list-fixture>
    <SidebarProvider open className="ub-body" data-sidebar-collapsed={false}>
      <Sidebar className="hidden xl:flex" aria-label="Fixture sidebar" />
      <DocumentList connection={data.directory} catalog={data.catalog} entries={data.entries} groups={[]}
        searchClient={data.searchClient}
        onSelect={setSelected} onTogglePin={() => {}} state={state} onStateChange={setState} />
    </SidebarProvider>
    <output aria-label="Opened document">{selected}</output>
  </main>;
}

createRoot(root).render(
  fixture !== null ? <DocumentListFixture /> :
  <main style={{ padding: 16, background: "var(--card)", color: "var(--card-foreground)" }}>
    <section aria-label="Button recipes" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {(["default", "destructive", "secondary", "selection", "outline"] as const).flatMap((variant) =>
        (["default", "sm", "icon", "selection"] as const).map((size) => (
          <Button key={`${variant}-${size}`} variant={variant} size={size} aria-label={`${variant} ${size}`}>
            {size === "icon" ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v12M2 8h12" stroke="currentColor" /></svg> : `${variant} ${size}`}
          </Button>
        )),
      )}
      <Button variant="plain" size="custom" className="flex w-full text-left font-normal">
        A full width row keeps its own layout
      </Button>
      <Button variant="tool" size="custom">Quiet tool</Button>
      <Button variant="tool" size="custom" data-emphasis="true">Emphasized tool</Button>
    </section>
    <section aria-label="Field recipes" style={{ display: "grid", gap: 8, marginBlock: 16, cursor: "pointer" }}>
      <Input aria-label="Input" defaultValue="Field text" />
      <Textarea aria-label="Textarea" defaultValue="Field text" />
      <Input aria-label="Invalid Input" aria-invalid="true" defaultValue="Field text" />
      <Textarea aria-label="Invalid Textarea" aria-invalid="true" defaultValue="Field text" />
      <Button aria-invalid="true">Invalid Button</Button>
      <Button variant="selection" disabled>Disabled Button</Button>
      <Button variant="selection" aria-disabled="true">Aria-disabled Button</Button>
      <Input aria-label="Disabled Input" defaultValue="Field text" disabled />
      <Textarea aria-label="Disabled Textarea" defaultValue="Field text" disabled />
    </section>
    <section aria-label="Browser focus references">
      <button type="button">Native Button</button>
      <input aria-label="Native Input" defaultValue="Field text" />
      <textarea aria-label="Native Textarea" defaultValue="Field text" />
    </section>
    <section aria-label="Cursor references" style={{ cursor: "pointer" }}>
      <button type="button" disabled>Disabled native Button</button>
      <button type="button" aria-disabled="true">Aria-disabled native Button</button>
      <button type="button" className="cursor-text">Text cursor Button</button>
      <button type="button" className="ub-figma-resize">Resize cursor Button</button>
      <div className="ub-editor">
        <div className="resize-cursor"><button type="button">Column resize cursor Button</button></div>
      </div>
    </section>
  </main>,
);
