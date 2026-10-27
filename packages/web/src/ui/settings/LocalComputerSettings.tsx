import { useCallback, useState } from "react";
import type { ReactElement } from "react";
import type { HistoryRetention, WorkspaceSize } from "@uberblick/mcp-server";
import type { LocalServing } from "../../config.js";
import { mintHubAuthMessage } from "../../collab/rooms.js";
import { localSessionHeaders } from "../../collab/local-session.js";
import { Button } from "../shadcn/button.js";
import { NativeSelect } from "../shadcn/native-select.js";
import { servesWorkspace } from "./hub-administration.js";
import { FeedbackLine, useHubMutation } from "./settings-kit.js";

interface LocalSettings {
  retention?: HistoryRetention;
  size: WorkspaceSize | null;
}

const DEFAULT: Extract<HistoryRetention, { mode: "recent" }> = { mode: "recent", days: 30, keepNamed: true };

async function request(workspace: string, subject: string, signal: AbortSignal,
  retention?: HistoryRetention): Promise<LocalSettings> {
  const response = await fetch("/api/local-settings", {
    method: retention === undefined ? "GET" : "POST",
    cache: "no-store",
    redirect: "error",
    headers: {
      Accept: "application/json",
      ...(retention === undefined ? {} : { "Content-Type": "application/json" }),
      Authorization: `Bearer ${await mintHubAuthMessage(workspace, subject)}`,
      ...await localSessionHeaders(),
    },
    ...(retention === undefined ? {} : { body: JSON.stringify({ retention }) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  if (!response.ok) throw new Error("Local settings unavailable");
  return await response.json() as LocalSettings;
}

function sizeLabel(size: WorkspaceSize | null): string {
  if (size === null) return "—";
  const unit = size.bytes >= 1_000_000_000 ? "GB" : size.bytes >= 1_000_000 ? "MB" : "KB";
  const divisor = unit === "GB" ? 1_000_000_000 : unit === "MB" ? 1_000_000 : 1_000;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(size.bytes / divisor)} ${unit} · ${Math.round(size.usedFraction * 100)}% used`;
}

export function LocalComputerSettings({ workspace, serving, subject, local }: {
  workspace: string; serving: LocalServing | null; subject: string; local: boolean;
}): ReactElement {
  const available = servesWorkspace(serving, workspace);
  const [size, setSize] = useState<WorkspaceSize | null>(null);
  const [saved, setSaved] = useState<HistoryRetention | null>(null);
  const [draft, setDraft] = useState<HistoryRetention>(DEFAULT);
  const [readFailed, setReadFailed] = useState(false);
  const load = useCallback(async (signal: AbortSignal): Promise<void> => {
    if (!available) return;
    try {
      const result = await request(workspace, subject, signal);
      if (signal.aborted) return;
      if (!local && result.retention === undefined) throw new Error("Missing retention");
      setSize(result.size);
      setSaved(result.retention ?? null);
      setDraft(result.retention ?? DEFAULT);
      setReadFailed(false);
    } catch { if (!signal.aborted) setReadFailed(true); }
  }, [available, local, subject, workspace]);
  const mutation = useHubMutation(load);
  const save = (): void => {
    void mutation.run(async (signal) => {
      try {
        const result = await request(workspace, subject, signal, draft);
        if (signal.aborted) return;
        if (result.retention === undefined) throw new Error("Missing retention");
        setSize(result.size);
        setSaved(result.retention);
        setDraft(result.retention);
        mutation.setFeedback({ applied: true, text: "History retention saved on this computer." });
      } catch {
        if (!signal.aborted) mutation.setFeedback({ applied: false, text: "Couldn't save history retention. Try again." });
      }
    });
  };
  const recent = draft.mode === "recent" ? draft : DEFAULT;
  const disabled = !available || saved === null || mutation.busy;
  return <section className="mt-8" aria-labelledby="ub-local-computer-title">
    <h2 id="ub-local-computer-title" className="mt-0 mb-4 ub-type-h2 font-semibold">On this computer</h2>
    {!local && <div className="mb-4 flex flex-col items-start gap-3">
      <label htmlFor="ub-history-retention" className="ub-type-ui">History retention</label>
      <NativeSelect id="ub-history-retention" value={draft.mode} disabled={disabled}
        onChange={(event) => setDraft(event.target.value === "recent" ? recent
          : { mode: event.target.value as "named" | "everything" })}>
        <option value="named">Named revisions only</option>
        <option value="recent">Recent history</option>
        <option value="everything">Everything</option>
      </NativeSelect>
      {draft.mode === "recent" && <>
        <NativeSelect aria-label="Recent history period" value={draft.days} disabled={disabled}
          onChange={(event) => setDraft({ ...draft, days: Number(event.target.value) as 7 | 30 | 90 })}>
          <option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option>
        </NativeSelect>
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 ub-type-ui">
          <input type="checkbox" checked={draft.keepNamed} disabled={disabled}
            onChange={(event) => setDraft({ ...draft, keepNamed: event.target.checked })} />
          Keep named revisions
        </label>
      </>}
      <Button type="button" variant="outline" size="sm" disabled={disabled || JSON.stringify(saved) === JSON.stringify(draft)} onClick={save}>Save history retention</Button>
      <FeedbackLine feedback={mutation.feedback} />
    </div>}
    <dl className="m-0 grid" data-settings-facts>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
        <dt className="ub-type-ui">Size</dt>
        <dd className="m-0 ub-type-ui tabular-nums">{sizeLabel(size)}</dd>
      </div>
    </dl>
    {!available && <p className="ub-type-ui">Open this workspace with ub open to read settings on this computer.</p>}
    {readFailed && <div className="flex flex-wrap items-baseline gap-2">
      <p className="ub-type-ui" role="alert">Couldn't read settings on this computer. Try again.</p>
      <Button type="button" variant="outline" size="sm" disabled={mutation.busy} onClick={() => void mutation.run(load)}>Retry</Button>
    </div>}
  </section>;
}
