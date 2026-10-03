/** General facts and the workspace tag-catalog curation page. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement, ReactNode } from "react";
import {
  createTagCatalogEntry,
  directoryRoom,
  isTagCatalogSeeded,
  isTagName,
  listDirectory,
  listTagCatalog,
  restoreTagCatalogEntry,
  retireTagCatalogEntry,
  seedTagCatalog,
  setWorkspaceName,
  settingsRoom,
} from "@uberblick/schema";
import type { TagCatalogEntry } from "@uberblick/schema";
import { endpointSourceLabel } from "../config.js";
import type { HubEndpoint } from "../config.js";
import type { RoomConnection } from "../collab/rooms.js";
import { rawSyncState, useCalmSyncState } from "./calm.js";
import { useRoomStatus } from "./hooks.js";
import type { SettingsPage, Workspace } from "./route.js";
import { Button } from "./shadcn/button.js";
import { Input } from "./shadcn/input.js";
import { statusReading } from "./status-reading.js";
import { useTagCatalog } from "./tags.js";
import { useWorkspaceName } from "./workspace-names.js";

/** What a SyncPanel-style fact reads as before this client knows it. */
const UNKNOWN = "—";

function Fact({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-(--border) py-3 first:pt-0 last:border-b-0 last:pb-0">
      <dt className="text-sm">{label}</dt>
      <dd className="m-0 max-w-[70%] font-(family-name:--font-mono) text-sm text-right wrap-anywhere">
        {children}
      </dd>
    </div>
  );
}

/**
 * State the shell already holds, presented without another persistence or RPC
 * path. The directory room is the connection reading because it is the room
 * every workspace page has, including this one.
 */
function GeneralSettings({
  workspace,
  endpoint,
  connection,
  catalogConnection,
  agentSessions,
}: {
  workspace: Workspace;
  endpoint: HubEndpoint | null;
  connection: RoomConnection | null;
  catalogConnection: RoomConnection | null;
  agentSessions: number;
}): ReactElement {
  const status = useRoomStatus(connection);
  const state = useCalmSyncState(rawSyncState(status));
  const reading = statusReading(status, state);
  const directoryReceived =
    connection !== null &&
    connection.room === directoryRoom(workspace.uuid) &&
    status.hasReceivedServerState;
  const documents = directoryReceived ? listDirectory(connection.ydoc).length : null;

  return (
    <section className="ub-pane" data-settings-page aria-labelledby="ub-settings-title">
      <div className="mx-auto w-full max-w-3xl">
        <h1 id="ub-settings-title" className="mt-0 mb-4 text-2xl font-medium">
          General
        </h1>
        <WorkspaceNameForm key={workspace.uuid} workspace={workspace} connection={catalogConnection} />
        <div className="rounded-(--radius) border border-(--border) bg-card p-4 text-card-foreground">
          <dl className="m-0 grid" data-settings-facts>
            <Fact label="Workspace UUID">{workspace.uuid}</Fact>
            <Fact label="Address segment">{workspace.segment}</Fact>
            <Fact label="Documents">{documents ?? UNKNOWN}</Fact>
            <Fact label="Hub">{endpoint?.url ?? UNKNOWN}</Fact>
            <Fact label="Source">
              {endpoint === null ? UNKNOWN : endpointSourceLabel(endpoint.source)}
            </Fact>
            <Fact label="Connection">
              <span>{reading.word}</span>
              {reading.detail !== null && (
                <span className="mt-1 block font-(family-name:--font-sans)">
                  {" "}{reading.detail}
                </span>
              )}
            </Fact>
            <Fact label="MCP connections">{agentSessions}</Fact>
          </dl>
        </div>
      </div>
    </section>
  );
}

type Feedback = { kind: "error" | "success"; text: string };

function WorkspaceNameForm({
  workspace,
  connection,
}: {
  workspace: Workspace;
  connection: RoomConnection | null;
}): ReactElement {
  const status = useRoomStatus(connection);
  const sharedName = useWorkspaceName(connection);
  const arrived = connection?.room === settingsRoom(workspace.uuid) && status.hasReceivedServerState;
  const currentName = arrived ? sharedName : null;
  const [draft, setDraft] = useState(currentName ?? "");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const writable = arrived && status.writable;

  useEffect(() => {
    setDraft(currentName ?? "");
  }, [currentName]);

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (
      connection === null ||
      connection.room !== settingsRoom(workspace.uuid) ||
      !connection.status.hasReceivedServerState ||
      !connection.status.writable
    ) {
      setFeedback({ kind: "error", text: "Reconnect before renaming the workspace." });
      return;
    }
    try {
      const name = setWorkspaceName(connection.ydoc, draft);
      setDraft(name);
      setFeedback({ kind: "success", text: `Saved “${name}”.` });
    } catch (error) {
      setFeedback({ kind: "error", text: error instanceof Error ? error.message : "The workspace name is invalid." });
    }
  };

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-(--radius) border border-(--border) bg-card p-4 text-card-foreground">
      <form className="flex flex-col gap-2" onSubmit={save}>
        <label htmlFor="ub-workspace-name" className="text-sm font-medium">Workspace name</label>
        <div className="flex gap-2">
          <Input
            id="ub-workspace-name"
            className="flex-1"
            value={draft}
            placeholder="Unnamed workspace"
            disabled={!writable}
            aria-invalid={feedback?.kind === "error"}
            aria-describedby="ub-workspace-name-help"
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setFeedback(null);
            }}
          />
          <Button type="submit" disabled={!writable}>Save</Button>
        </div>
        <p id="ub-workspace-name-help" className="m-0 text-sm">
          Use 1–64 characters, with no control or format characters. Spaces at the ends are removed.
        </p>
      </form>
      {!writable && <p className="m-0 text-sm" role="status">
        {arrived ? "Workspace renaming is unavailable while this page is disconnected." : "Waiting for workspace settings…"}
      </p>}
      {feedback !== null && <p className="m-0 text-sm" role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</p>}
    </div>
  );
}

function TagSettings({
  workspace,
  connection,
}: {
  workspace: Workspace;
  connection: RoomConnection | null;
}): ReactElement {
  const status = useRoomStatus(connection);
  const catalog = useTagCatalog(connection);
  const [draft, setDraft] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const groups = useRef<HTMLDivElement | null>(null);
  /**
   * The lifecycle action this client just activated, and where its entry stood.
   *
   * Retiring or restoring moves the entry to the other list, so the button that
   * had focus unmounts, and focus on a detached element is focus on `<body>` —
   * the keyboard reader is silently returned to the top of the page, mid-
   * curation. The target cannot be picked here, because it does not exist until
   * the write has re-rendered both lists, so the *position* is remembered and
   * resolved in the layout effect below. Only a local action sets it: a peer's
   * catalog change re-renders through the same path and must not move focus.
   */
  const [refocus, setRefocus] = useState<{
    from: "active" | "retired";
    at: number;
    moved: string;
  } | null>(null);
  const arrived =
    connection !== null &&
    connection.room === settingsRoom(workspace.uuid) &&
    status.hasReceivedServerState;
  const seeded = arrived && catalog?.seeded === true;
  const writable = seeded && status.writable;

  // The examples are one schema-owned, merge-safe transition. Wait for the
  // server's answer first: seeding an empty Y.Doc before that answer could
  // recreate an example another client already retired.
  useEffect(() => {
    if (
      connection === null ||
      !arrived ||
      !status.writable ||
      isTagCatalogSeeded(connection.ydoc)
    ) {
      return;
    }
    seedTagCatalog(connection.ydoc);
  }, [arrived, connection, status.writable]);

  useLayoutEffect(() => {
    if (refocus === null) return;
    setRefocus(null);
    const card = groups.current;
    if (card === null) return;
    const left = [
      ...card.querySelectorAll<HTMLButtonElement>(
        `[aria-labelledby="ub-${refocus.from}-tags"] [data-tag-entry]`,
      ),
    ];
    // The control that took the moved entry's place, the last one when it was
    // last, and the entry's own new control when the list it left is now empty.
    const target =
      left[Math.min(refocus.at, left.length - 1)] ??
      card.querySelector<HTMLButtonElement>(`[data-tag-entry="${refocus.moved}"]`);
    target?.focus();
  }, [refocus]);

  if (!seeded) {
    return (
      <section className="ub-pane" data-settings-page aria-labelledby="ub-settings-title">
        <div className="mx-auto w-full max-w-3xl">
          <h1 id="ub-settings-title" className="mt-0 mb-4 text-2xl font-medium">
            Tags
          </h1>
          <div className="rounded-(--radius) border border-(--border) bg-card p-4 text-card-foreground">
            <p className="m-0 text-sm" role="status">
              Waiting for the tag catalog…
            </p>
          </div>
        </div>
      </section>
    );
  }

  const entries = catalog?.entries ?? [];
  const active = entries.filter((entry) => entry.state === "active");
  const retired = entries.filter((entry) => entry.state === "retired");

  const create = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (connection === null || !connection.status.writable) {
      setFeedback({
        kind: "error",
        text: "Reconnect before changing the tag catalog.",
      });
      return;
    }
    if (!isTagName(draft)) {
      setFeedback({
        kind: "error",
        text: "Use 1–30 lowercase letters or numbers, separated by single hyphens.",
      });
      return;
    }
    const existing = listTagCatalog(connection.ydoc).find(
      (entry) => entry.name === draft,
    );
    if (existing !== undefined) {
      setFeedback({
        kind: "error",
        text:
          existing.state === "retired"
            ? `“${draft}” is retired. Restore it from the retired list.`
            : `“${draft}” is already an active tag.`,
      });
      return;
    }
    createTagCatalogEntry(connection.ydoc, draft);
    setFeedback({ kind: "success", text: `Created “${draft}”.` });
    setDraft("");
  };

  const changeState = (entry: TagCatalogEntry, at: number): void => {
    if (connection === null || !connection.status.writable) return;
    if (entry.state === "active") retireTagCatalogEntry(connection.ydoc, entry.id);
    else restoreTagCatalogEntry(connection.ydoc, entry.id);
    setRefocus({ from: entry.state, at, moved: entry.id });
    setFeedback({
      kind: "success",
      text: `${entry.state === "active" ? "Retired" : "Restored"} “${entry.name}”.`,
    });
  };

  const list = (state: "active" | "retired", items: TagCatalogEntry[]) => (
    <section className="min-w-0" aria-labelledby={`ub-${state}-tags`}>
      <h2 id={`ub-${state}-tags`} className="mt-0 mb-2 text-base font-medium">
        {state === "active" ? "Active" : "Retired"}
      </h2>
      {items.length === 0 ? (
        <p className="m-0 text-sm">No {state} tags.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-tag-list>
          {items.map((entry, at) => (
            <li
              key={entry.id}
              className="flex items-center justify-between gap-3 rounded-(--radius-sm) border border-(--border) p-2 text-sm"
            >
              <span className="min-w-0 wrap-anywhere">{entry.name}</span>
              <Button
                variant="outline"
                size="sm"
                type="button"
                data-tag-entry={entry.id}
                disabled={!writable}
                onClick={() => changeState(entry, at)}
              >
                {entry.state === "active" ? "Retire" : "Restore"}
                <span className="sr-only"> {entry.name}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <section className="ub-pane" data-settings-page aria-labelledby="ub-settings-title">
      <div className="mx-auto w-full max-w-3xl">
        <h1 id="ub-settings-title" className="mt-0 mb-4 text-2xl font-medium">
          Tags
        </h1>
        <div className="flex flex-col gap-4 rounded-(--radius) border border-(--border) bg-card p-4 text-card-foreground">
          <form className="flex flex-col gap-2" onSubmit={create}>
            <label htmlFor="ub-new-tag" className="text-sm font-medium">Create a tag</label>
            <div className="flex gap-2">
              <Input
                className="flex-1"
                id="ub-new-tag"
                value={draft}
                disabled={!writable}
                aria-describedby="ub-tag-name-help"
                onChange={(event) => {
                  setDraft(event.currentTarget.value);
                  setFeedback(null);
                }}
              />
              <Button type="submit" disabled={!writable}>
                Create
              </Button>
            </div>
            <p id="ub-tag-name-help" className="m-0 text-sm">
              Lowercase letters and numbers, separated by hyphens; 30 characters
              maximum.
            </p>
          </form>
          {!writable && (
            <p className="m-0 text-sm" role="status">
              Tag changes are unavailable while this page is disconnected.
            </p>
          )}
          {feedback !== null && (
            <p
              className={
                feedback.kind === "error"
                  ? "m-0 rounded-(--radius-sm) border border-destructive p-2 text-sm"
                  : "m-0 text-sm"
              }
              role={feedback.kind === "error" ? "alert" : "status"}
            >
              {feedback.text}
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2" ref={groups}>
            {list("active", active)}
            {list("retired", retired)}
          </div>
        </div>
      </div>
    </section>
  );
}

export function WorkspaceSettings({
  page = "general",
  workspace,
  endpoint,
  connection,
  catalogConnection = null,
  agentSessions,
}: {
  page?: SettingsPage;
  workspace: Workspace;
  endpoint: HubEndpoint | null;
  connection: RoomConnection | null;
  catalogConnection?: RoomConnection | null;
  agentSessions: number;
}): ReactElement {
  return page === "tags" ? (
    <TagSettings workspace={workspace} connection={catalogConnection} />
  ) : (
    <GeneralSettings
      workspace={workspace}
      endpoint={endpoint}
      connection={connection}
      catalogConnection={catalogConnection}
      agentSessions={agentSessions}
    />
  );
}
