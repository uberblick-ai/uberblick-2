/** A floating view of the open document's first two heading levels. */

import { useEffect, useRef, useState } from "react";
import type { PointerEvent, ReactElement } from "react";
import { flushSync } from "react-dom";
import type { RoomConnection } from "../collab/rooms.js";
import { useOutline } from "./hooks.js";
import { scrollBlockIntoView } from "./outline.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./shadcn/dropdown-menu.js";

/** Long enough to cross the trigger/content gap, short enough to feel direct. */
const HOVER_CLOSE_DELAY_MS = 120;

const FOCUSABLE =
  "a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[contenteditable='true'],[tabindex]:not([tabindex='-1'])";

/** The first real page control after the outline's in-flow slot. */
function nextPageControl(outline: HTMLElement | null): HTMLElement | null {
  for (
    let sibling = outline?.nextElementSibling;
    sibling;
    sibling = sibling.nextElementSibling
  ) {
    const candidates = [
      ...(sibling.matches(FOCUSABLE) ? [sibling] : []),
      ...sibling.querySelectorAll(FOCUSABLE),
    ];
    const visible = candidates.find(
      (candidate): candidate is HTMLElement =>
        candidate instanceof HTMLElement &&
        candidate.getClientRects().length > 0 &&
        candidate.closest("[hidden], [inert], [aria-hidden='true']") === null,
    );
    if (visible) return visible;
  }
  return null;
}

export function OutlinePane({
  connection,
  obscured = false,
}: {
  connection: RoomConnection | null;
  /** A narrow-screen threads drawer currently covers this control. */
  obscured?: boolean;
}): ReactElement | null {
  const entries = useOutline(connection);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedFromHover = useRef(false);
  const closingFromHover = useRef(false);
  const closingFromTab = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);

  const cancelClose = (): void => {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  const openFromHover = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse") return;
    cancelClose();
    if (open) return;
    openedFromHover.current = true;
    setOpen(true);
  };

  const closeAfterHover = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse") return;
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      const focused = document.activeElement;
      if (
        !openedFromHover.current &&
        (
          trigger.current?.matches(":hover") ||
          trigger.current?.matches(":focus-visible") ||
          document.querySelector(".ub-outline-panel")?.contains(focused)
        )
      ) {
        return;
      }
      closingFromHover.current = true;
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
    closingFromHover.current = true;
    setOpen(false);
  }, [entries.length]);

  useEffect(() => {
    // The state is meaningful only where CSS turns the rail into an overlay;
    // on a wide screen the same rail state must not dismiss this sibling.
    if (!obscured) return;
    const closeWhenCovered = (): void => {
      if (trigger.current?.getClientRects().length !== 0) return;
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
      closeTimer.current = null;
      closingFromHover.current = true;
      setOpen(false);
    };
    closeWhenCovered();
    window.addEventListener("resize", closeWhenCovered);
    return () => window.removeEventListener("resize", closeWhenCovered);
  }, [obscured]);

  if (entries.length === 0) return null;

  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(shown) => {
        cancelClose();
        if (shown) closingFromHover.current = false;
        setOpen(shown);
      }}
    >
      <div
        className={obscured ? "ub-outline ub-outline-obscured" : "ub-outline"}
        onPointerEnter={openFromHover}
        onPointerLeave={closeAfterHover}
      >
        <DropdownMenuTrigger asChild>
          <button
            ref={trigger}
            type="button"
            className="ub-outline-trigger"
            onPointerDown={() => {
              openedFromHover.current = false;
            }}
          >
            Contents <span>{entries.length}</span>
          </button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent
        align="end"
        side="bottom"
        collisionPadding={8}
        className="ub-outline-panel"
        aria-label="On this page"
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") cancelClose();
        }}
        onPointerLeave={closeAfterHover}
        onOpenAutoFocus={(event) => {
          if (!openedFromHover.current) return;
          event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          if (closingFromTab.current) {
            closingFromTab.current = false;
            event.preventDefault();
            return;
          }
          if (!closingFromHover.current) return;
          closingFromHover.current = false;
          openedFromHover.current = false;
          event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          event.preventDefault();
          closingFromTab.current = true;
          // Remove Radix's menu focus scope, then continue at the next control
          // in this in-flow lane rather than its portalled focus guards.
          flushSync(() => setOpen(false));
          if (event.shiftKey) {
            trigger.current?.focus({ preventScroll: true });
          } else {
            nextPageControl(
              trigger.current?.closest(".ub-outline") ?? null,
            )?.focus({ preventScroll: true });
          }
        }}
      >
        <div className="ub-outline-panel-body">
          <p className="ub-rail-head">On this page</p>
          <ul>
            {entries.map((entry) => (
              <li key={entry.id} className={`ub-outline-l${entry.level}`}>
                <DropdownMenuItem asChild>
                  <button
                    type="button"
                    onClick={() => {
                      scrollBlockIntoView(entry.id);
                    }}
                  >
                    {entry.text.trim() === "" ? (
                      <em>Untitled heading</em>
                    ) : (
                      entry.text
                    )}
                  </button>
                </DropdownMenuItem>
              </li>
            ))}
          </ul>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
