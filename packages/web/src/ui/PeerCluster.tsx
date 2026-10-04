/** The compact, operable document-presence cluster (#616). */

import { useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { RemotePresence } from "./doc-chrome.js";
import { presenceLabel } from "./doc-chrome.js";
import { PeerAvatar } from "./PeerAvatar.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./shadcn/popover.js";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./shadcn/tooltip.js";

const VISIBLE_PEERS = 3;

function peerKey(clientId: number): string {
  return String(clientId);
}

/**
 * At most three collaborators, followed by one bounded overflow surface.
 * Ordering comes from `readPresence`'s client-id order, so mutable identity or
 * caret fields never shuffle unrelated controls.
 */
export function PeerCluster({
  presence,
  onActivate,
}: {
  presence: readonly RemotePresence[];
  onActivate?: ((session: RemotePresence) => void) | undefined;
}): ReactElement {
  const visible = presence.slice(0, VISIBLE_PEERS);
  const remaining = presence.slice(VISIBLE_PEERS);
  const [open, setOpen] = useState(false);
  const cluster = useRef<HTMLSpanElement | null>(null);
  const overflow = useRef<HTMLDivElement | null>(null);
  const overflowTrigger = useRef<HTMLButtonElement | null>(null);
  const focusedPeer = useRef<number | null>(null);
  const focusWasInside = useRef(false);
  const interactedOutside = useRef(false);

  const containsFocus = (): boolean =>
    cluster.current?.contains(document.activeElement) === true ||
    overflow.current?.contains(document.activeElement) === true;

  const focusFallback = (clientId: number | null): void => {
    const root = cluster.current;
    if (root === null) return;
    const controls = [
      ...root.querySelectorAll<HTMLButtonElement>("[data-peer-id]"),
      ...(overflow.current?.querySelectorAll<HTMLButtonElement>("[data-peer-id]") ?? []),
    ];
    const samePeer =
      clientId === null
        ? undefined
        : controls.find((control) => control.dataset.peerId === peerKey(clientId));
    const fallback =
      samePeer ??
      overflowTrigger.current ??
      controls[0] ??
      root
        .closest(".ub-status")
        ?.querySelector<HTMLButtonElement>(".ub-status-sync") ??
      null;
    fallback?.focus({ preventScroll: true });
  };

  const leaveCluster = (): void => {
    // DOM removal can fire blur during the same commit that removes the
    // focused row. Let the layout-effect fallback run first; an ordinary move
    // outside clears the marker immediately afterwards.
    queueMicrotask(() => {
      if (containsFocus()) return;
      focusedPeer.current = null;
      focusWasInside.current = false;
    });
  };

  // A live leave or room switch can remove the focused DOM node without a
  // blur event. Restore focus inside the surviving cluster, or to the stable
  // sync-details control when nobody remains.
  useLayoutEffect(() => {
    if (remaining.length === 0 && open) setOpen(false);
    if (!focusWasInside.current || containsFocus()) return;
    focusFallback(focusedPeer.current);
  });

  const activate = (session: RemotePresence, dismiss = false): void => {
    onActivate?.(session);
    if (!dismiss) return;
    setOpen(false);
  };

  return (
    <TooltipProvider>
      <Popover
        open={open}
        onOpenChange={(shown) => {
          if (shown) interactedOutside.current = false;
          setOpen(shown);
        }}
      >
        {/* Reserve the capped cluster even while empty: joining must not wrap
            the sync facts and move the status rule or prose. Four 28px controls
            with three 6px overlaps occupy 94px. */}
        <span className="ub-peers relative flex min-w-[94px] flex-none items-center justify-end ml-auto" ref={cluster}>
          {visible.map((session) => {
            const label = presenceLabel(session);
            return (
              <Tooltip key={session.clientId}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="ub-peer-control"
                    data-peer-id={peerKey(session.clientId)}
                    aria-label={label}
                    onFocus={() => {
                      focusWasInside.current = true;
                      focusedPeer.current = session.clientId;
                    }}
                    onBlur={leaveCluster}
                    onClick={() => activate(session)}
                  >
                    <PeerAvatar session={session} />
                  </button>
                </TooltipTrigger>
                <TooltipContent align="end">
                  {session.name} · {session.kind === "agent" ? "agent" : "person"}
                </TooltipContent>
              </Tooltip>
            );
          })}
          {remaining.length > 0 && (
            <PopoverTrigger asChild>
              <button
                ref={overflowTrigger}
                type="button"
                className="ub-peer-control ub-peer-more"
                aria-label={`${remaining.length} more active ${
                  remaining.length === 1 ? "collaborator" : "collaborators"
                }`}
                onFocus={() => {
                  focusWasInside.current = true;
                  focusedPeer.current = null;
                }}
                onBlur={leaveCluster}
              >
                +{remaining.length}
              </button>
            </PopoverTrigger>
          )}
        </span>
        {remaining.length > 0 && (
          <PopoverContent
            ref={overflow}
            align="end"
            className="ub-peer-overflow"
            aria-label="More active collaborators"
            onInteractOutside={() => {
              interactedOutside.current = true;
            }}
            onCloseAutoFocus={(event) => {
              // Radix owns the close policy; this local override changes only its
              // trigger focus to preventScroll. Plain focus would undo #616's
              // editor jump by scrolling the pane back to this status row.
              if (interactedOutside.current) return;
              event.preventDefault();
              overflowTrigger.current?.focus({ preventScroll: true });
            }}
          >
            {remaining.map((session) => (
              <button
                key={session.clientId}
                type="button"
                className="ub-peer-overflow-row"
                data-peer-id={peerKey(session.clientId)}
                aria-label={presenceLabel(session)}
                onFocus={() => {
                  focusWasInside.current = true;
                  focusedPeer.current = session.clientId;
                }}
                onBlur={leaveCluster}
                onClick={() => activate(session, true)}
              >
                <PeerAvatar session={session} />
                <span className="ub-peer-overflow-name">{session.name}</span>
                <span className="ub-muted">
                  {session.kind === "agent" ? "agent" : "person"}
                </span>
              </button>
            ))}
          </PopoverContent>
        )}
      </Popover>
    </TooltipProvider>
  );
}
