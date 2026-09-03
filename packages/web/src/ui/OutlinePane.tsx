/** A floating view of the open document's first two heading levels. */

import { useEffect, useRef, useState } from "react";
import type { PointerEvent, ReactElement } from "react";
import type { RoomConnection } from "../collab/rooms.js";
import { useOutline } from "./hooks.js";
import { scrollBlockIntoView } from "./outline.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./shadcn/popover.js";

/** Long enough to cross the trigger/content gap, short enough to feel direct. */
const HOVER_CLOSE_DELAY_MS = 120;

type OpenReason = "activation" | "focus" | "hover";

export function OutlinePane({
  connection,
}: {
  connection: RoomConnection | null;
}): ReactElement | null {
  const entries = useOutline(connection);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openReason = useRef<OpenReason>("activation");
  const escapeClosing = useRef(false);
  const restoringTrigger = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);

  const cancelClose = (): void => {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  const openFromHover = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse") return;
    cancelClose();
    openReason.current = "hover";
    setOpen(true);
  };

  const closeAfterHover = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse") return;
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      const focused = document.activeElement;
      if (trigger.current?.contains(focused) || content.current?.contains(focused)) {
        return;
      }
      setOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  };

  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );

  // A live edit can remove the last eligible heading without unmounting this
  // component. Do not remember an open surface for a later heading.
  useEffect(() => {
    if (entries.length !== 0) return;
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setOpen(false);
  }, [entries.length]);

  if (entries.length === 0) return null;

  return (
    <Popover
      open={open}
      onOpenChange={(shown) => {
        cancelClose();
        if (shown) openReason.current = "activation";
        setOpen(shown);
      }}
    >
      <div
        className="ub-outline"
        onPointerEnter={openFromHover}
        onPointerLeave={closeAfterHover}
      >
        <PopoverTrigger asChild>
          <button
            ref={trigger}
            type="button"
            className="ub-outline-trigger"
            onFocus={(event) => {
              if (restoringTrigger.current) {
                restoringTrigger.current = false;
                return;
              }
              if (!event.currentTarget.matches(":focus-visible")) return;
              cancelClose();
              openReason.current = "focus";
              setOpen(true);
            }}
          >
            Contents <span>{entries.length}</span>
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent
        align="end"
        side="bottom"
        collisionPadding={8}
        className="ub-outline-panel"
        aria-label="On this page"
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") cancelClose();
        }}
        onOpenAutoFocus={(event) => {
          // A pointer merely crossing the trigger must never steal keyboard
          // focus. Keyboard focus and activation keep Radix's normal entry.
          if (openReason.current === "hover") event.preventDefault();
        }}
        onEscapeKeyDown={() => {
          escapeClosing.current = true;
        }}
        onCloseAutoFocus={(event) => {
          if (escapeClosing.current) {
            event.preventDefault();
            escapeClosing.current = false;
            restoringTrigger.current = true;
            trigger.current?.focus({ preventScroll: true });
            return;
          }
          if (openReason.current === "hover") event.preventDefault();
        }}
      >
        <div
          ref={content}
          className="ub-outline-panel-body"
          onPointerEnter={openFromHover}
          onPointerLeave={closeAfterHover}
        >
          <p className="ub-rail-head">On this page</p>
          <ul>
            {entries.map((entry) => (
              <li key={entry.id} className={`ub-outline-l${entry.level}`}>
                <button
                  type="button"
                  onClick={() => {
                    scrollBlockIntoView(entry.id);
                    // A keyboard activation may make Radix restore the trigger.
                    // Keep that focus return from immediately reopening it.
                    restoringTrigger.current = true;
                    requestAnimationFrame(() => {
                      restoringTrigger.current = false;
                    });
                    setOpen(false);
                  }}
                >
                  {entry.text.trim() === "" ? (
                    <em>Untitled heading</em>
                  ) : (
                    entry.text
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}
