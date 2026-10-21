/** General facts, tag-catalog curation and live workspace access. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement, ReactNode } from "react";
import type { Doc } from "yjs";
import {
  createTagCatalogEntry,
  directoryRoom,
  getWorkspaceMainRepository,
  getWorkspaceName,
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
import type { SettingsPage as SettingsRoutePage, Workspace } from "../route.js";
import { Button } from "../shadcn/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../shadcn/collapsible.js";
import { Input } from "../shadcn/input.js";
import { statusReading } from "../status/status-reading.js";
import { useTagCatalog } from "../tags.js";
import { formatTimestamp, useTimestampClock } from "../timestamps.js";
import { workspaceLocationLabel } from "../workspace-location.js";
import { useWorkspaceSetting } from "../workspace-setting.js";
import { AccessSettings } from "./AccessSettings.js";
import { SettingsPage } from "./settings-kit.js";

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
    <SettingsPage title="General">
      <SharedSettingField key={workspace.uuid} setting={NAME} workspace={workspace} connection={catalogConnection} />
      <SharedSettingField key={`repository-${workspace.uuid}`} setting={MAIN_REPOSITORY} workspace={workspace} connection={catalogConnection} />
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
    </SettingsPage>
  );
}

interface SharedSetting {
  id: string;
  label: string;
  read: (settings: Doc) => string | null;
  /** Stores the validated draft and returns the stored value; throws on invalid input. */
  write: (settings: Doc, draft: string) => string | null;
  saved: (value: string | null) => string;
  hint?: string;
  placeholder?: string;
  /** The accessible name of a quiet Save; without it Save is the filled primary button. */
  quietSave?: string;
  reconnect: string;
  invalid: string;
  unavailable: string;
}

const NAME: SharedSetting = {
  id: "ub-workspace-name",
  label: "Name",
  read: getWorkspaceName,
  write: setWorkspaceName,
  saved: (name) => `Saved “${name}”.`,
  hint: "Shown in the sidebar header and the workspace menu.",
  placeholder: "Unnamed workspace",
  reconnect: "Reconnect before renaming the workspace.",
  invalid: "The workspace name is invalid.",
  unavailable: "Workspace renaming is unavailable while this page is disconnected.",
};

const MAIN_REPOSITORY: SharedSetting = {
  id: "ub-main-repository",
  label: "Main repository",
  read: getWorkspaceMainRepository,
  write: setWorkspaceMainRepository,
  saved: (repository) => repository === null ? "Main repository cleared." : `Saved main repository “${repository}”.`,
  quietSave: "Save main repository",
  reconnect: "Reconnect before changing the main repository.",
  invalid: "The main repository is invalid.",
  unavailable: "Main repository changes are unavailable while this page is disconnected.",
};

/**
 * A pristine draft follows remote changes and an edited one survives them.
 * Saving waits for the routed settings room's server state and refuses while
 * that room cannot write.
 */
function SharedSettingField({
  setting,
  workspace,
  connection,
}: {
  setting: SharedSetting;
  workspace: Workspace;
  connection: RoomConnection | null;
}): ReactElement {
  const { id, hint } = setting;
  const status = useRoomStatus(connection);
  const shared = useWorkspaceSetting(connection, setting.read);
  const arrived = connection?.room === settingsRoom(workspace.uuid) && status.hasReceivedServerState;
  const current = arrived ? shared : null;
  const [draft, setDraft] = useState(current ?? "");
  const previous = useRef(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const writable = arrived && status.writable;

  useEffect(() => {
    const before = previous.current;
    const next = current ?? "";
    setDraft((value) => value === before ? next : value);
    previous.current = next;
  }, [current]);

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (
      connection === null ||
      connection.room !== settingsRoom(workspace.uuid) ||
      !connection.status.hasReceivedServerState ||
      !connection.status.writable
    ) {
      setError(setting.reconnect);
      return;
    }
    try {
      const value = setting.write(connection.ydoc, draft);
      setDraft(value ?? "");
      setError(null);
      toast.success(setting.saved(value), { id: "workspace-settings" });
    } catch (error) {
      setError(error instanceof Error ? error.message : setting.invalid);
    }
  };

  const describedBy = [hint === undefined ? null : `${id}-help`, error === null ? null : `${id}-error`]
    .filter((part) => part !== null).join(" ");
  return (
    <div className="mb-4 flex flex-col gap-3">
      <form className="flex flex-col gap-2" onSubmit={save}>
        <label htmlFor={id} className="ub-type-ui font-medium">{setting.label}</label>
        <div className="flex gap-2">
          <Input
            id={id}
            className="flex-1"
            value={draft}
            placeholder={setting.placeholder}
            disabled={!writable}
            aria-invalid={error !== null}
            aria-describedby={describedBy === "" ? undefined : describedBy}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setError(null);
            }}
          />
          <Button type="submit" variant={setting.quietSave === undefined ? "default" : "outline"} aria-label={setting.quietSave} disabled={!writable}>
            Save
          </Button>
        </div>
        {hint !== undefined && <p id={`${id}-help`} className="m-0 ub-type-small">{hint}</p>}
      </form>
      {!writable && <p className="m-0 ub-type-ui" role="status">
        {arrived ? setting.unavailable : "Waiting for workspace settings…"}
      </p>}
      {error !== null && <p id={`${id}-error`} className="m-0 ub-type-ui" role="alert">{error}</p>}
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
      <SettingsPage title="Tags">
        <div className="rounded-(--radius) border border-(--border) bg-card p-4 text-card-foreground">
          <p className="m-0 ub-type-ui" role="status">
            Waiting for the tag catalog…
          </p>
        </div>
      </SettingsPage>
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
    <SettingsPage title="Tags">
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
    </SettingsPage>
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
  page?: SettingsRoutePage;
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
  if (!admin) return <SettingsPage><p role="status">Reading workspace permissions…</p></SettingsPage>;
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
