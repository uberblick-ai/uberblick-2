/** A floating view of the open document's first two heading levels. */

import { useEffect, useRef, useState } from "react";
import type { PointerEvent, ReactElement } from "react";
import type { RoomConnection } from "../collab/rooms.js";
import { useOutline } from "./hooks.js";
import { scrollBlockIntoView } from "./outline.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./shadcn/dropdown-menu.js";

/** Long enough to cross the trigger/content gap, short enough to feel direct. */
const HOVER_CLOSE_DELAY_MS = 120;

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
  const focusBeforeHover = useRef<HTMLElement | null>(null);
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
    focusBeforeHover.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
    if (open) closingFromHover.current = true;
    setOpen(false);
  }, [entries.length, open]);

  useEffect(() => {
    // The state is meaningful only where CSS turns the rail into an overlay;
    // on a wide screen the same rail state must not dismiss this sibling.
    if (!obscured) return;
    const closeWhenCovered = (): void => {
      if (trigger.current?.getClientRects().length !== 0) return;
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
      closeTimer.current = null;
      if (open) closingFromHover.current = true;
      setOpen(false);
    };
    closeWhenCovered();
    window.addEventListener("resize", closeWhenCovered);
    return () => window.removeEventListener("resize", closeWhenCovered);
  }, [obscured, open]);

  if (entries.length === 0) return null;

  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(shown) => {
        cancelClose();
        if (shown) {
          closingFromHover.current = false;
        } else {
          openedFromHover.current = false;
        }
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
        className="ub-outline-panel flex w-[min(20rem,calc(100vw_-_2rem))] max-h-[min(calc(100vh_-_2rem),var(--radix-dropdown-menu-content-available-height))]! flex-col overflow-hidden! p-0!"
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
          if (focusBeforeHover.current?.isConnected) {
            focusBeforeHover.current.focus({ preventScroll: true });
          }
          focusBeforeHover.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          event.preventDefault();
          closingFromTab.current = true;
          setOpen(false);
          trigger.current?.focus({ preventScroll: true });
        }}
      >
        <div className="ub-outline-panel-body flex min-h-0 flex-col p-3">
          <DropdownMenuLabel className="mb-[0.4rem] mt-0 text-[0.7rem]! tracking-[0.06em] uppercase">On this page</DropdownMenuLabel>
          <ul role="none" className="m-0 min-h-0 list-none overflow-y-auto p-0">
            {entries.map((entry) => (
              <li
                key={entry.id}
                role="none"
                className={`ub-outline-l${entry.level}`}
              >
                <DropdownMenuItem
                  asChild
                  className={`block! w-full overflow-hidden px-2! py-[0.35rem]! text-muted-foreground text-left text-ellipsis whitespace-nowrap ${entry.level === 2 ? "pl-5!" : ""}`}
                >
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
