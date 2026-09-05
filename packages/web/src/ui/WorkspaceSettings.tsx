/** General facts and the workspace tag-catalog curation page. */

import { useEffect, useState } from "react";
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
  settingsRoom,
} from "@uberblick/schema";
import type { TagCatalogEntry } from "@uberblick/schema";
import { endpointSourceLabel } from "../config.js";
import type { HubEndpoint } from "../config.js";
import type { RoomConnection } from "../collab/rooms.js";
import { rawSyncState, useCalmSyncState } from "./calm.js";
import { useRoomStatus } from "./hooks.js";
import type { SettingsPage, Workspace } from "./route.js";
import { statusReading } from "./status-reading.js";
import { useTagCatalog } from "./tags.js";

/** What a SyncPanel-style fact reads as before this client knows it. */
const UNKNOWN = "—";

function Fact({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="ub-panel-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
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
  agentSessions,
}: {
  workspace: Workspace;
  endpoint: HubEndpoint | null;
  connection: RoomConnection | null;
  agentSessions: number;
}): ReactElement {
  const status = useRoomStatus(connection);
  const state = useCalmSyncState(rawSyncState(status));
  const reading = statusReading(status, state);
  const directoryAnswered =
    connection !== null &&
    connection.room === directoryRoom(workspace.uuid) &&
    status.hasAnswered;
  const documents = directoryAnswered ? listDirectory(connection.ydoc).length : null;

  return (
    <section className="ub-pane ub-settings-page" aria-labelledby="ub-settings-title">
      <div className="ub-settings-column">
        <h1 id="ub-settings-title">General</h1>
        <div className="ub-settings-card">
          <dl className="ub-panel-facts ub-settings-facts">
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
                <span className="ub-settings-fact-detail"> {reading.detail}</span>
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

  if (!seeded) {
    return (
      <section className="ub-pane ub-settings-page" aria-labelledby="ub-settings-title">
        <div className="ub-settings-column">
          <h1 id="ub-settings-title">Tags</h1>
          <div className="ub-settings-card">
            <p className="ub-settings-waiting" role="status">
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

  const changeState = (entry: TagCatalogEntry): void => {
    if (connection === null || !connection.status.writable) return;
    if (entry.state === "active") retireTagCatalogEntry(connection.ydoc, entry.id);
    else restoreTagCatalogEntry(connection.ydoc, entry.id);
    setFeedback({
      kind: "success",
      text: `${entry.state === "active" ? "Retired" : "Restored"} “${entry.name}”.`,
    });
  };

  const list = (state: "active" | "retired", items: TagCatalogEntry[]) => (
    <section className="ub-settings-tag-section" aria-labelledby={`ub-${state}-tags`}>
      <h2 id={`ub-${state}-tags`}>{state === "active" ? "Active" : "Retired"}</h2>
      {items.length === 0 ? (
        <p className="ub-muted">No {state} tags.</p>
      ) : (
        <ul className="ub-settings-tag-list">
          {items.map((entry) => (
            <li key={entry.id}>
              <span>{entry.name}</span>
              <button
                type="button"
                disabled={!writable}
                onClick={() => changeState(entry)}
              >
                {entry.state === "active" ? "Retire" : "Restore"}
                <span className="ub-sr-only"> {entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <section className="ub-pane ub-settings-page" aria-labelledby="ub-settings-title">
      <div className="ub-settings-column">
        <h1 id="ub-settings-title">Tags</h1>
        <div className="ub-settings-card ub-settings-tags-card">
          <form className="ub-settings-tag-create" onSubmit={create}>
            <label htmlFor="ub-new-tag">Create a tag</label>
            <div>
              <input
                id="ub-new-tag"
                value={draft}
                disabled={!writable}
                aria-describedby="ub-tag-name-help"
                onChange={(event) => {
                  setDraft(event.currentTarget.value);
                  setFeedback(null);
                }}
              />
              <button type="submit" disabled={!writable}>
                Create
              </button>
            </div>
            <p id="ub-tag-name-help" className="ub-muted">
              Lowercase letters and numbers, separated by hyphens; 30 characters
              maximum.
            </p>
          </form>
          {!writable && (
            <p className="ub-settings-read-only" role="status">
              Tag changes are unavailable while this page is disconnected.
            </p>
          )}
          {feedback !== null && (
            <p
              className={`ub-settings-feedback ub-settings-feedback-${feedback.kind}`}
              role={feedback.kind === "error" ? "alert" : "status"}
            >
              {feedback.text}
            </p>
          )}
          <div className="ub-settings-tag-groups">
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
      agentSessions={agentSessions}
    />
  );
}
