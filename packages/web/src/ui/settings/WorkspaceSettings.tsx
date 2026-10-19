/** General facts, tag-catalog curation and live workspace access. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement, ReactNode } from "react";
import {
  createTagCatalogEntry,
  directoryRoom,
  isTagCatalogSeeded,
  isTagName,
  listTagCatalog,
  restoreTagCatalogEntry,
  retireTagCatalogEntry,
  seedTagCatalog,
  setWorkspaceMainRepository,
  setWorkspaceName,
  settingsRoom,
} from "@uberblick/schema";
import type { TagCatalogEntry } from "@uberblick/schema";
import { endpointSourceLabel } from "../../config.js";
import type { HubEndpoint, LocalServing } from "../../config.js";
import type { RoomConnection } from "../../collab/rooms.js";
import { writeToClipboard } from "../../editor/source-chrome.js";
import { toast } from "sonner";
import { rawSyncState, useCalmSyncState } from "../status/calm.js";
import { useDirectory, useRoomStatus } from "../hooks.js";
import type { SettingsPage, Workspace } from "../route.js";
import { Button } from "../shadcn/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../shadcn/collapsible.js";
import { Input } from "../shadcn/input.js";
import { statusReading } from "../status/status-reading.js";
import { useTagCatalog } from "../tags.js";
import { formatTimestamp, useTimestampClock } from "../timestamps.js";
import { workspaceLocationLabel } from "../workspace-location.js";
import { useWorkspaceName } from "../workspace-names.js";
import { useWorkspaceMainRepository } from "./workspace-main-repository.js";
import { AccessSettings } from "./AccessSettings.js";

/** What a SyncPanel-style fact reads as before this client knows it. */
const UNKNOWN = "—";

function Fact({ label, children, mono = false, tabular = false }: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  tabular?: boolean;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-(--border) py-3 first:pt-0 last:border-b-0 last:pb-0">
      <dt className="ub-type-ui">{label}</dt>
      <dd className={`m-0 min-w-0 max-w-full ub-type-ui text-right wrap-anywhere${mono ? " font-(family-name:--font-mono)" : ""}${tabular ? " tabular-nums" : ""}`}>
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
  workspaceLocation,
  endpoint,
  connection,
  catalogConnection,
  agentSessions,
}: {
  workspace: Workspace;
  workspaceLocation: string | null;
  endpoint: HubEndpoint | null;
  connection: RoomConnection | null;
  catalogConnection: RoomConnection | null;
  agentSessions: number;
}): ReactElement {
  const status = useRoomStatus(connection);
  const catalogStatus = useRoomStatus(catalogConnection);
  const entries = useDirectory(connection, true);
  const catalog = useTagCatalog(catalogConnection);
  const now = useTimestampClock();
  const state = useCalmSyncState(rawSyncState(status));
  const reading = statusReading(status, state);
  const directoryReceived =
    connection !== null &&
    connection.room === directoryRoom(workspace.uuid) &&
    status.hasReceivedServerState;
  const documents = entries.filter((entry) => !entry.kind && !entry.deleted).length;
  const archived = entries.filter((entry) => !entry.kind && entry.deleted).length;
  const tagsReceived = catalogConnection?.room === settingsRoom(workspace.uuid) && catalogStatus.hasReceivedServerState;
  const tags = tagsReceived ? catalog?.entries.filter((entry) => entry.state === "active").length : null;
  const latest = entries.reduce<number | null>((stamp, entry) =>
    entry.deleted || entry.updatedAt === undefined ? stamp : Math.max(stamp ?? entry.updatedAt, entry.updatedAt), null);
  const edited = directoryReceived && latest !== null ? formatTimestamp(latest, now, true) : null;

  const copyId = async (): Promise<void> => {
    const copied = await writeToClipboard(workspace.uuid);
    toast[copied ? "success" : "error"](
      copied ? "Workspace ID copied" : "Couldn't copy the workspace ID. Try again in a browser with clipboard access.",
      { id: "copy-workspace-id" },
    );
  };

  return (
    <section className="ub-pane ub-page-pane" data-settings-page aria-labelledby="ub-settings-title">
      <div className="ub-column">
        <h1 id="ub-settings-title" className="ub-title">
          General
        </h1>
        <WorkspaceNameForm key={workspace.uuid} workspace={workspace} connection={catalogConnection} />
        <MainRepositoryForm key={`repository-${workspace.uuid}`} workspace={workspace} connection={catalogConnection} />
        <section className="mt-8" aria-labelledby="ub-workspace-location-title">
          <h2 id="ub-workspace-location-title" className="mt-0 mb-4 ub-type-h2 font-semibold">Where it lives</h2>
          <dl className="m-0 grid" data-settings-facts>
            <Fact label="Hub">{workspaceLocationLabel(workspaceLocation) ?? UNKNOWN}</Fact>
            <Fact label="Workspace ID">
              <span className="inline-flex max-w-full flex-wrap items-baseline justify-end gap-2">
                <span className="min-w-0 wrap-anywhere font-(family-name:--font-mono)">{workspace.uuid}</span>
                <Button type="button" variant="outline" size="sm" aria-label="Copy workspace ID" onClick={() => void copyId()}>Copy</Button>
              </span>
            </Fact>
          </dl>
        </section>
        <section className="mt-8" aria-labelledby="ub-workspace-about-title">
          <h2 id="ub-workspace-about-title" className="mt-0 mb-4 ub-type-h2 font-semibold">About this workspace</h2>
          <dl className="m-0 grid" data-settings-facts>
            <Fact label="Documents" tabular>{directoryReceived ? `${documents}${archived > 0 ? ` (${archived} archived)` : ""}` : UNKNOWN}</Fact>
            <Fact label="Tags" tabular>{tags ?? UNKNOWN}</Fact>
            <Fact label="Last edited" tabular>
              {edited === null ? UNKNOWN : <time dateTime={edited.dateTime} title={edited.title}>{edited.label}</time>}
            </Fact>
          </dl>
        </section>
        <Collapsible key={`connection-${workspace.uuid}`} className="mt-8">
          <h2 className="mt-0 mb-4 ub-type-h2 font-semibold">
            <CollapsibleTrigger className="group flex max-w-full items-center gap-2 border-0 bg-transparent p-0 text-left font-[inherit] text-inherit cursor-pointer [@media(any-pointer:coarse)]:min-h-11">
              Connection details
              <svg className="size-4 shrink-0 group-data-[state=open]:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            </CollapsibleTrigger>
          </h2>
          <CollapsibleContent>
            <dl className="m-0 grid" data-settings-facts>
              <Fact label="Address segment" mono>{workspace.segment}</Fact>
              <Fact label="Source">
                {endpoint === null ? UNKNOWN : endpointSourceLabel(endpoint.source)}
              </Fact>
              <Fact label="Connection">
                <span>{reading.word}</span>
                {reading.detail !== null && (
                  <span className="mt-1 block">
                    {" "}{reading.detail}
                  </span>
                )}
              </Fact>
              <Fact label="MCP connections" tabular>{directoryReceived ? agentSessions : UNKNOWN}</Fact>
            </dl>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </section>
  );
}

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
  const previousName = useRef(currentName ?? "");
  const [error, setError] = useState<string | null>(null);
  const writable = arrived && status.writable;

  useEffect(() => {
    const previous = previousName.current;
    const next = currentName ?? "";
    setDraft((value) => value === previous ? next : value);
    previousName.current = next;
  }, [currentName]);

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (
      connection === null ||
      connection.room !== settingsRoom(workspace.uuid) ||
      !connection.status.hasReceivedServerState ||
      !connection.status.writable
    ) {
      setError("Reconnect before renaming the workspace.");
      return;
    }
    try {
      const name = setWorkspaceName(connection.ydoc, draft);
      setDraft(name);
      setError(null);
      toast.success(`Saved “${name}”.`, { id: "workspace-settings" });
    } catch (error) {
      setError(error instanceof Error ? error.message : "The workspace name is invalid.");
    }
  };

  return (
    <div className="mb-4 flex flex-col gap-3">
      <form className="flex flex-col gap-2" onSubmit={save}>
        <label htmlFor="ub-workspace-name" className="ub-type-ui font-medium">Name</label>
        <div className="flex gap-2">
          <Input
            id="ub-workspace-name"
            className="min-w-0 flex-1"
            value={draft}
            placeholder="Unnamed workspace"
            disabled={!writable}
            aria-invalid={error !== null}
            aria-describedby="ub-workspace-name-help"
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setError(null);
            }}
          />
          <Button type="submit" disabled={!writable}>Save</Button>
        </div>
        <p id="ub-workspace-name-help" className="m-0 ub-type-small">
          Shown in the sidebar header and the workspace menu.
        </p>
      </form>
      {!writable && <p className="m-0 ub-type-ui" role="status">
        {arrived ? "Workspace renaming is unavailable while this page is disconnected." : "Waiting for workspace settings…"}
      </p>}
      {error !== null && <p className="m-0 ub-type-ui" role="alert">{error}</p>}
    </div>
  );
}

function MainRepositoryForm({
  workspace,
  connection,
}: {
  workspace: Workspace;
  connection: RoomConnection | null;
}): ReactElement {
  const status = useRoomStatus(connection);
  const sharedRepository = useWorkspaceMainRepository(connection);
  const arrived = connection?.room === settingsRoom(workspace.uuid) && status.hasReceivedServerState;
  const currentRepository = arrived ? sharedRepository : null;
  const [draft, setDraft] = useState(currentRepository ?? "");
  const previousRepository = useRef(currentRepository ?? "");
  const [error, setError] = useState<string | null>(null);
  const writable = arrived && status.writable;

  useEffect(() => {
    const previous = previousRepository.current;
    const next = currentRepository ?? "";
    setDraft((value) => value === previous ? next : value);
    previousRepository.current = next;
  }, [currentRepository]);

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (
      connection === null ||
      connection.room !== settingsRoom(workspace.uuid) ||
      !connection.status.hasReceivedServerState ||
      !connection.status.writable
    ) {
      setError("Reconnect before changing the main repository.");
      return;
    }
    try {
      const repository = setWorkspaceMainRepository(connection.ydoc, draft);
      setDraft(repository ?? "");
      setError(null);
      toast.success(
        repository === null ? "Main repository cleared." : `Saved main repository “${repository}”.`,
        { id: "workspace-settings" },
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "The main repository is invalid.");
    }
  };

  return (
    <div className="mb-4 flex flex-col gap-3">
      <form className="flex flex-col gap-2" onSubmit={save}>
        <label htmlFor="ub-main-repository" className="ub-type-ui font-medium">Main repository</label>
        <div className="flex gap-2">
          <Input
            id="ub-main-repository"
            className="flex-1"
            value={draft}
            disabled={!writable}
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : "ub-main-repository-error"}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setError(null);
            }}
          />
          <Button type="submit" variant="outline" aria-label="Save main repository" disabled={!writable}>Save</Button>
        </div>
      </form>
      {!writable && <p className="m-0 ub-type-ui" role="status">
        {arrived ? "Main repository changes are unavailable while this page is disconnected." : "Waiting for workspace settings…"}
      </p>}
      {error !== null && <p id="ub-main-repository-error" className="m-0 ub-type-ui" role="alert">{error}</p>}
    </div>
  );
}

function TagSettings({
  workspace,
  connection,
  local,
}: {
  workspace: Workspace;
  connection: RoomConnection | null;
  local: boolean;
}): ReactElement {
  const status = useRoomStatus(connection);
  const catalog = useTagCatalog(connection);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const groups = useRef<HTMLDivElement | null>(null);
  /**
   * Remember position only for a local lifecycle gesture: moving catalog
   * entries unmounts their focused button. Resolve a surviving focus target
   * after both lists commit; remote catalog changes must not move focus.
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
  const writable = arrived && status.writable;

  // The examples are one schema-owned, merge-safe transition. Wait for the
  // server's answer first: seeding an empty Y.Doc before that answer could
  // recreate an example another client already retired.
  useEffect(() => {
    if (
      connection === null ||
      !local ||
      !arrived ||
      !status.writable ||
      isTagCatalogSeeded(connection.ydoc)
    ) {
      return;
    }
    seedTagCatalog(connection.ydoc);
  }, [arrived, connection, local, status.writable]);

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

  if (!arrived) {
    return (
      <section className="ub-pane ub-page-pane" data-settings-page aria-labelledby="ub-settings-title">
        <div className="ub-column">
          <h1 id="ub-settings-title" className="ub-title">
            Tags
          </h1>
          <div className="rounded-(--radius) border border-(--border) bg-card p-4 text-card-foreground">
            <p className="m-0 ub-type-ui" role="status">
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
      setError("Reconnect before changing the tag catalog.");
      return;
    }
    const name = draft.trim().toLowerCase();
    if (!isTagName(name)) {
      setError("Use 1–30 letters or numbers, separated by single hyphens.");
      return;
    }
    const existing = listTagCatalog(connection.ydoc).find(
      (entry) => entry.name === name,
    );
    if (existing !== undefined) {
      setError(existing.state === "retired"
        ? `“${name}” is retired. Restore it from the retired list.`
        : `“${name}” is already an active tag.`);
      return;
    }
    createTagCatalogEntry(connection.ydoc, name);
    setError(null);
    toast.success(`Created “${name}”.`, { id: "workspace-settings" });
    setDraft("");
  };

  const changeState = (entry: TagCatalogEntry, at: number): void => {
    if (connection === null || !connection.status.writable) return;
    if (entry.state === "active") retireTagCatalogEntry(connection.ydoc, entry.id);
    else restoreTagCatalogEntry(connection.ydoc, entry.id);
    setRefocus({ from: entry.state, at, moved: entry.id });
    setError(null);
    toast.success(`${entry.state === "active" ? "Retired" : "Restored"} “${entry.name}”.`, { id: "workspace-settings" });
  };

  const list = (state: "active" | "retired", items: TagCatalogEntry[]) => (
    <section className="min-w-0" aria-labelledby={`ub-${state}-tags`}>
      <h2 id={`ub-${state}-tags`} className="mt-0 mb-2 ub-type-h2 font-semibold">
        {state === "active" ? "Active" : "Retired"}
      </h2>
      {items.length === 0 ? (
        <p className="m-0 ub-type-ui">No {state} tags.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-tag-list>
          {items.map((entry, at) => (
            <li
              key={entry.id}
              className="flex items-center justify-between gap-3 rounded-(--radius-sm) border border-(--border) p-2 ub-type-body"
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
    <section className="ub-pane ub-page-pane" data-settings-page aria-labelledby="ub-settings-title">
      <div className="ub-column">
        <h1 id="ub-settings-title" className="ub-title">
          Tags
        </h1>
        <div className="flex flex-col gap-4 rounded-(--radius) border border-(--border) bg-card p-4 text-card-foreground">
          <form className="flex flex-col gap-2" onSubmit={create}>
            <label htmlFor="ub-new-tag" className="ub-type-ui font-medium">Create a tag</label>
            <div className="flex gap-2">
              <Input
                className="flex-1"
                id="ub-new-tag"
                value={draft}
                disabled={!writable}
                aria-describedby="ub-tag-name-help"
                onChange={(event) => {
                  setDraft(event.currentTarget.value);
                  setError(null);
                }}
              />
              <Button type="submit" disabled={!writable}>
                Create
              </Button>
            </div>
            <p id="ub-tag-name-help" className="m-0 ub-type-small">
              Letters and numbers, separated by hyphens; saved in lowercase; 30
              characters maximum.
            </p>
          </form>
          {!writable && (
            <p className="m-0 ub-type-ui" role="status">
              Tag changes are unavailable while this page is disconnected.
            </p>
          )}
          {error !== null && (
            <p className="m-0 rounded-(--radius-sm) border border-destructive p-2 ub-type-ui" role="alert">
              {error}
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
  admin,
  local = false,
  page = "general",
  workspace,
  workspaceLocation = null,
  endpoint,
  connection,
  catalogConnection = null,
  agentSessions,
  serving = null,
  subject = "browser",
  verifiedHandle = null,
}: {
  admin: boolean;
  local?: boolean;
  page?: SettingsPage;
  workspace: Workspace;
  workspaceLocation?: string | null;
  endpoint: HubEndpoint | null;
  connection: RoomConnection | null;
  catalogConnection?: RoomConnection | null;
  agentSessions: number;
  serving?: LocalServing | null;
  subject?: string;
  verifiedHandle?: string | null;
}): ReactElement {
  if (!admin) return <section className="ub-pane ub-page-pane" data-settings-page>
    <div className="ub-column"><p role="status">Reading workspace permissions…</p></div>
  </section>;
  return page === "members" ? (
    <AccessSettings key={workspace.uuid} workspace={workspace} serving={serving} subject={subject} verifiedHandle={verifiedHandle} />
  ) : page === "tags" ? (
    <TagSettings workspace={workspace} connection={catalogConnection} local={local} />
  ) : (
    <GeneralSettings
      workspace={workspace}
      workspaceLocation={workspaceLocation}
      endpoint={endpoint}
      connection={connection}
      catalogConnection={catalogConnection}
      agentSessions={agentSessions}
    />
  );
}
