/**
 * Display client-held sync and code-check facts plus the shell's
 * local /api/status answer. Never query the remote hub or wait on
 * HTTP for local durability. Omit local-update count because this client has
 * no update log.
 */

import type { ReactElement } from "react";
import { endpointSourceLabel } from "../../config.js";
import type { HubEndpoint } from "../../config.js";
import type { RoomConnection } from "../../collab/rooms.js";
import type { NotSharedReason } from "../../shell/document-search.js";
import { backlogLabel, rawSyncState, useCalmSyncState } from "./calm.js";
import { statusReading } from "./status-reading.js";
import { documentSyncFacts } from "./sync-facts.js";
import { useDocMeta, useDocRev, useRoomStatus } from "../hooks.js";
import { formatExactTimestamp, formatTimestamp, useTimestampClock } from "../timestamps.js";
import { CodeCheckPaths } from "./CodeCheckPaths.js";
import { staleCodeCheckAgeDays } from "./code-check-age.js";

/** What a fact reads as before this client knows it. */
const UNKNOWN = "—";

function Fact({
  label,
  value,
  mono = false,
  fill = false,
}: {
  label: string;
  value: string | ReactElement;
  mono?: boolean;
  fill?: boolean;
}): ReactElement {
  return (
    <div className="ub-sync-fact flex items-baseline gap-2 py-[0.15rem]">
      <dt className="w-[4.5rem] flex-none ub-type-caption text-(--muted-foreground)">
        {label}
      </dt>
      {/* Identifiers and exact timestamps wrap inside the panel. */}
      <dd className={`m-0 min-w-0 ub-type-caption [overflow-wrap:anywhere]${mono ? " font-mono" : ""}${fill ? " flex-1" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Mount only while open and only for the document status room. The shell
 * supplies its resolved endpoint; null stays unknown. Name the remote hub
 * beside upstream facts using the credential-free config label so local and
 * promoted hubs cannot be confused.
 */
export function SyncPanel({
  connection,
  endpoint,
  hubAcked,
  notSharedReason = null,
  lastUpdated,
}: {
  connection: RoomConnection | null;
  /** The endpoint the provider was constructed with, or null until resolved. */
  endpoint: HubEndpoint | null;
  /** `ub open`'s upstream reading; undefined when this page talks to a hub. */
  hubAcked?: boolean | null | undefined;
  notSharedReason?: NotSharedReason | null;
  /** The stamp currently shown by the status line; absent while it omits it. */
  lastUpdated?: number | undefined;
}): ReactElement {
  const status = useRoomStatus(connection);
  const meta = useDocMeta(connection);
  const revision = useDocRev(connection);
  const clock = useTimestampClock();
  const now = Math.max(clock, Date.now());
  const codeChecks = meta?.code_check ?? [];
  const raw = rawSyncState(status);
  const state = useCalmSyncState(raw, connection);
  // Show the same calm word as the opening status control; only redraw
  // cadence changes, never truth.
  const reading = statusReading(status, state ?? raw);
  const localWorkspace = endpoint?.url === "local";
  const facts = documentSyncFacts(status, state, reading, hubAcked, notSharedReason, localWorkspace);
  const reason = reading.detail ?? facts.hubDetail;
  const hasReading = connection !== null && facts.primary !== null;
  const namedEndpoint = hubAcked !== undefined && !facts.twoFact ? null : endpoint;
  const updated =
    lastUpdated === undefined ? null : formatExactTimestamp(lastUpdated);

  return (
    <div>
      {localWorkspace ? <p className="m-0 mb-5 text-center ub-type-caption text-(--muted-foreground)">Local-only workspace</p> : <>
      <h2 className="m-0 mb-[0.4rem] ub-type-caption tracking-[0.06em] uppercase text-muted-foreground">Sync</h2>
      <dl className="ub-sync-facts m-0 mb-5">
        <Fact label="Hub" value={namedEndpoint?.url ?? UNKNOWN} mono />
        {/* Always name the configuration source beside its hub endpoint. */}
        <Fact
          label="Source"
          value={
            namedEndpoint === null
              ? UNKNOWN
              : endpointSourceLabel(namedEndpoint.source)
          }
        />
        <Fact label="Room" value={connection?.room ?? UNKNOWN} mono />
        <Fact
          label="State"
          value={hasReading ? (facts.primary ?? UNKNOWN) : UNKNOWN}
        />
        {facts.twoFact && !localWorkspace && (
          <Fact label="Hub state" value={facts.hub ?? UNKNOWN} />
        )}
        {/* Refusals and known not-shared causes explain their own reading.
            Ordinary states have no cause to name, so this row stays absent. */}
        {connection !== null && reason !== null && (
          <Fact label="Reason" value={reason} />
        )}
        {/*
            * Keep the backlog row at zero so nothing waiting stays distinct from
            * unreported.
         */}
        <Fact
          label="Backlog"
          value={
            connection === null ? UNKNOWN : backlogLabel(status.unsyncedChanges)
          }
        />
        {updated !== null && (
          <Fact
            label="Last updated"
            value={<time dateTime={updated.dateTime}>{updated.label}</time>}
          />
        )}
      </dl>
      </>}
      {codeChecks.length > 0 && (
        <section className="mb-5">
          <h2 className="m-0 mb-[0.4rem] ub-type-caption tracking-[0.06em] uppercase text-muted-foreground">Code</h2>
          {codeChecks.map((check) => {
            const checked = formatTimestamp(check.checked_at, now, true);
            return (
              <dl key={check.repository} className="ub-code-check m-0 mb-3 last:mb-0">
                <Fact label="Repository" value={check.repository} />
                <Fact label="Compared" value={
                  <>
                    <a href={`https://github.com/${check.repository}/commit/${check.commit}`} target="_blank" rel="noopener noreferrer" className="font-mono text-foreground underline">
                      {check.commit.slice(0, 8)}
                    </a>
                    {checked !== null && <> · <time dateTime={checked.dateTime} title={checked.title}>{checked.label}</time></>}
                    {staleCodeCheckAgeDays(check.checked_at, now) !== null && " · due for a re-check"}
                  </>
                } />
                <Fact label="Result" value={
                  <span className={check.result === "drift" ? "text-(--status-warning-ink)" : check.result === "ahead" ? "text-muted-foreground" : undefined}>
                    {check.result === "matches" ? "Matches the code" : check.result === "ahead" ? "Ahead of the code (intended)" : "Differs from the code"}
                  </span>
                } />
                <Fact label="Page edited since" value={check.rev === undefined ? "Unknown (older check)" : check.rev === revision ? "No" : "Yes"} />
                {check.paths !== undefined && check.paths.length > 0 && (
                  <Fact label="Looked at" value={<CodeCheckPaths paths={check.paths} />} mono fill />
                )}
              </dl>
            );
          })}
        </section>
      )}
    </div>
  );
}
