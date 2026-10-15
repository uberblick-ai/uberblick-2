import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import { PopoverTrigger } from "../shadcn/popover.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../shadcn/tooltip.js";
import { formatTimestamp, useTimestampClock } from "../timestamps.js";

/** Sync meaning is application state; Radix owns the trigger and focus behavior. */
export function SyncDot({ offline, error, confirmed, lastConfirmedAt, pulse, syncDetails }: {
  offline: boolean;
  error: boolean;
  confirmed: boolean;
  lastConfirmedAt: number | null;
  pulse: number;
  syncDetails: boolean;
}): ReactElement {
  const now = useTimestampClock();
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [finishedPulse, setFinishedPulse] = useState(0);
  useEffect(() => {
    if (pulse === 0) return;
    // Reduced motion has no animationend; retire its key on the same deadline.
    const timer = setTimeout(() => setFinishedPulse(pulse), 650);
    return () => clearTimeout(timer);
  }, [pulse]);
  const wasOffline = useRef(false);
  useEffect(() => {
    if (offline) {
      setOfflineSince((since) => since ?? Date.now());
      if (!wasOffline.current) setAnnouncement("Offline. Changes are saved on this device.");
      wasOffline.current = true;
    } else {
      setOfflineSince(null);
      if (confirmed && wasOffline.current) {
        setAnnouncement("Synced with hub.");
        wasOffline.current = false;
      } else if (!confirmed) setAnnouncement("");
    }
  }, [offline, confirmed]);
  const since = offlineSince === null ? null : new Date(offlineSince);
  const offlineTime = since === null ? null : `${String(since.getHours()).padStart(2, "0")}:${String(since.getMinutes()).padStart(2, "0")}`;
  const age = lastConfirmedAt === null ? null : formatTimestamp(lastConfirmedAt, now, true)?.label;
  const label = offline && offlineTime !== null
    ? `Offline since ${offlineTime}`
    : confirmed && age != null
      ? `Synced with hub ${age}`
      : "Sync details";
  const dot = <span
    key={pulse}
    className={`ub-dot ub-sync-dot${pulse > finishedPulse ? " ub-sync-dot--pulse" : ""}`}
    data-state={offline ? "offline" : error ? "error" : "resting"}
    data-pulse={pulse}
    aria-hidden="true"
    onAnimationEnd={() => setFinishedPulse(pulse)}
  />;
  return <>
    {syncDetails ? <TooltipProvider><Tooltip>
      <TooltipTrigger asChild><PopoverTrigger asChild>
        <button type="button" className="ub-status-sync ub-sync-toggle" aria-label={label} title={label}>
          {dot}
        </button>
      </PopoverTrigger></TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip></TooltipProvider> : <span className="ub-status-sync-slot" title={label}>{dot}</span>}
    {createPortal(<span className="ub-sync-announcement sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>, document.body)}
  </>;
}
