/** A bounded, keyboard-operable document-presence cluster. */

import { useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { RemotePresence } from "./doc-chrome.js";
import { presenceKey, presenceLabel } from "./doc-chrome.js";
import { PeerAvatar } from "./PeerAvatar.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./shadcn/popover.js";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./shadcn/tooltip.js";

const VISIBLE_PEERS = 3;
const PEER_CONTROL_CLASS = "ub-peer-control relative box-border size-[28px] flex-none cursor-pointer rounded-full m-0 p-0 not-first:-ml-[6px] hover:z-4 focus-visible:z-4 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-(--ring) focus-visible:outline-offset-2";
// Earlier circles paint above their overlapping siblings; hover and keyboard
// focus use a higher stack level than any circle's resting order.
const PEER_STACK_CLASSES = ["z-3", "z-2", "z-1"];

/**
 * Cap the roster at three controls plus overflow. The title reader preserves
 * session order across connection changes.
 */
export function PeerCluster({
  presence,
  onActivate,
  reserveSpace = false,
}: {
  presence: readonly RemotePresence[];
  onActivate?: ((session: RemotePresence) => void) | undefined;
  /** Keep the editor's status and prose still as the capped roster changes. */
  reserveSpace?: boolean;
}): ReactElement {
  const visible = presence.slice(0, VISIBLE_PEERS);
  const remaining = presence.slice(VISIBLE_PEERS);
  const [open, setOpen] = useState(false);
  const cluster = useRef<HTMLSpanElement | null>(null);
  const overflow = useRef<HTMLDivElement | null>(null);
  const overflowTrigger = useRef<HTMLButtonElement | null>(null);
  const focusedPeer = useRef<string | null>(null);
  const focusWasInside = useRef(false);
  const interactedOutside = useRef(false);

  const containsFocus = (): boolean =>
    cluster.current?.contains(document.activeElement) === true ||
    overflow.current?.contains(document.activeElement) === true;

  const focusFallback = (key: string | null): void => {
    const root = cluster.current;
    if (root === null) return;
    const controls = [
      ...root.querySelectorAll<HTMLButtonElement>("[data-peer-id]"),
      ...(overflow.current?.querySelectorAll<HTMLButtonElement>("[data-peer-id]") ?? []),
    ];
    const samePeer =
      key === null
        ? undefined
        : controls.find((control) => control.dataset.peerId === key);
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
        {/* Four 28px controls with three 6px overlaps occupy 94px. Only the
            editor reserves the cap; waiting notices keep their compact row. */}
        <span className={`ub-peers relative flex flex-none items-center justify-end ml-auto${reserveSpace ? " min-w-[94px]" : ""}`} ref={cluster}>
          {visible.map((session, index) => {
            const label = presenceLabel(session);
            return (
              <Tooltip key={presenceKey(session)}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={`${PEER_CONTROL_CLASS} border-0 bg-(--background) text-(--foreground) [font:inherit] ${PEER_STACK_CLASSES[index]}`}
                    data-peer-id={presenceKey(session)}
                    aria-label={label}
                    onFocus={() => {
                      focusWasInside.current = true;
                      focusedPeer.current = presenceKey(session);
                    }}
                    onBlur={leaveCluster}
                    onClick={() => activate(session)}
                  >
                    <PeerAvatar session={session} />
                  </button>
                </TooltipTrigger>
                <TooltipContent align="end">
                  {session.name} · {session.kind === "agent" ? "agent" : "person"}
                  {session.departed ? " · left" : ""}
                </TooltipContent>
              </Tooltip>
            );
          })}
          {remaining.length > 0 && (
            <PopoverTrigger asChild>
              <button
                ref={overflowTrigger}
                type="button"
                className={`${PEER_CONTROL_CLASS} ub-peer-more border border-solid border-(--border) bg-(--secondary) text-(--secondary-foreground) font-(family-name:--font-sans) text-[0.7rem] font-semibold [line-height:inherit]`}
                aria-label={`${remaining.length} more ${
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
            aria-label="More collaborators"
            onInteractOutside={() => {
              interactedOutside.current = true;
            }}
            onCloseAutoFocus={(event) => {
              // Keep Radix close policy, but restore trigger focus with
              // preventScroll so closing overflow does not jump the editor to
              // this row.
              if (interactedOutside.current) return;
              event.preventDefault();
              overflowTrigger.current?.focus({ preventScroll: true });
            }}
          >
            {remaining.map((session) => (
              <button
                key={presenceKey(session)}
                type="button"
                className="ub-peer-overflow-row flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-(--radius-sm) border-0 bg-transparent p-[0.35rem] text-left text-inherit [font:inherit] hover:bg-(--card-accent) focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-(--ring) focus-visible:outline-offset-2"
                data-peer-id={presenceKey(session)}
                aria-label={presenceLabel(session)}
                onFocus={() => {
                  focusWasInside.current = true;
                  focusedPeer.current = presenceKey(session);
                }}
                onBlur={leaveCluster}
                onClick={() => activate(session, true)}
              >
                <PeerAvatar session={session} />
                <span className="ub-peer-overflow-name">{session.name}</span>
                <span className="ub-muted">
                  {session.kind === "agent" ? "agent" : "person"}
                  {session.departed ? " · left" : ""}
                </span>
              </button>
            ))}
          </PopoverContent>
        )}
      </Popover>
    </TooltipProvider>
  );
}
