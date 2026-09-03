/** The compact, operable document-presence cluster (#616). */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { RemotePresence } from "./doc-chrome.js";
import { presenceLabel } from "./doc-chrome.js";
import { PeerAvatar } from "./PeerAvatar.js";

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
  const overflowTrigger = useRef<HTMLButtonElement | null>(null);
  const focusedPeer = useRef<number | null>(null);
  const focusWasInside = useRef(false);

  const focusFallback = (clientId: number | null): void => {
    const root = cluster.current;
    if (root === null) return;
    const controls = Array.from(
      root.querySelectorAll<HTMLButtonElement>("[data-peer-id]"),
    );
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
      if (cluster.current?.contains(document.activeElement)) return;
      focusedPeer.current = null;
      focusWasInside.current = false;
    });
  };

  // A live leave or room switch can remove the focused DOM node without a
  // blur event. Restore focus inside the surviving cluster, or to the stable
  // sync-details control when nobody remains.
  useLayoutEffect(() => {
    if (remaining.length === 0 && open) setOpen(false);
    if (!focusWasInside.current || cluster.current?.contains(document.activeElement)) {
      return;
    }
    focusFallback(focusedPeer.current);
  });

  // Escape is the overflow surface's ordinary dismissal. The trigger is still
  // mounted whenever the surface is, so focus has a deterministic way home.
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      overflowTrigger.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [open]);

  const activate = (session: RemotePresence, dismiss = false): void => {
    onActivate?.(session);
    if (!dismiss) return;
    setOpen(false);
    overflowTrigger.current?.focus({ preventScroll: true });
  };

  return (
    <span className="ub-peers" ref={cluster}>
      {visible.map((session) => {
        const label = presenceLabel(session);
        return (
          <button
            key={session.clientId}
            type="button"
            className="ub-peer-control"
            data-peer-id={peerKey(session.clientId)}
            aria-label={label}
            title={label}
            onFocus={() => {
              focusWasInside.current = true;
              focusedPeer.current = session.clientId;
            }}
            onBlur={leaveCluster}
            onClick={() => activate(session)}
          >
            <PeerAvatar session={session} decorative />
            <span className="ub-peer-tooltip" role="tooltip">
              {session.name} · {session.kind === "agent" ? "agent" : "person"}
            </span>
          </button>
        );
      })}
      {remaining.length > 0 && (
        <button
          ref={overflowTrigger}
          type="button"
          className="ub-peer-control ub-peer-more"
          aria-label={`${remaining.length} more active ${
            remaining.length === 1 ? "collaborator" : "collaborators"
          }`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls="ub-peer-overflow"
          onFocus={() => {
            focusWasInside.current = true;
            focusedPeer.current = null;
          }}
          onBlur={leaveCluster}
          onClick={() => setOpen((shown) => !shown)}
        >
          +{remaining.length}
        </button>
      )}
      {open && remaining.length > 0 && (
        <span
          id="ub-peer-overflow"
          className="ub-peer-overflow"
          role="dialog"
          aria-label="More active collaborators"
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
              <PeerAvatar session={session} decorative />
              <span className="ub-peer-overflow-name">{session.name}</span>
              <span className="ub-muted">
                {session.kind === "agent" ? "agent" : "person"}
              </span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
