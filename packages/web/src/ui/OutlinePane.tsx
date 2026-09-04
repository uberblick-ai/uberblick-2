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

type CloseFocus = "none" | "trigger";

const TABBABLE_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]",
].join(",");

/** The browser's next usable stop, excluding the portalled outline itself. */
function nextTabbableAfter(
  current: HTMLElement,
  outline: HTMLElement | null,
): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR),
  ).filter((element) => {
    if (outline?.contains(element) || element.tabIndex < 0) return false;
    if (element.closest("[hidden], [inert], [aria-hidden='true']") !== null) {
      return false;
    }
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getClientRects().length > 0
    );
  });
  const currentIndex = candidates.indexOf(current);
  if (currentIndex < 0) return candidates[0] ?? null;
  return candidates[currentIndex + 1] ?? candidates[0] ?? null;
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
  const closeFocus = useRef<CloseFocus | null>(null);
  const suppressFocusOpen = useRef(false);
  const lastPointerType = useRef<string | null>(null);
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
    if (open) return;
    closeFocus.current = null;
    setOpen(true);
  };

  const closeAfterHover = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse") return;
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      const focused = document.activeElement;
      if (
        trigger.current?.matches(":focus-visible") ||
        content.current?.contains(focused)
      ) {
        return;
      }
      closeFocus.current = "none";
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
    closeFocus.current = "none";
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
      closeFocus.current = "none";
      setOpen(false);
    };
    closeWhenCovered();
    window.addEventListener("resize", closeWhenCovered);
    return () => window.removeEventListener("resize", closeWhenCovered);
  }, [obscured]);

  if (entries.length === 0) return null;

  return (
    <Popover
      open={open}
      onOpenChange={(shown) => {
        cancelClose();
        if (shown) {
          closeFocus.current = null;
        }
        setOpen(shown);
      }}
    >
      <div
        className={obscured ? "ub-outline ub-outline-obscured" : "ub-outline"}
        onPointerEnter={openFromHover}
        onPointerLeave={closeAfterHover}
      >
        <PopoverTrigger asChild>
          <button
            ref={trigger}
            type="button"
            className="ub-outline-trigger"
            onFocus={(event) => {
              if (suppressFocusOpen.current) {
                suppressFocusOpen.current = false;
                return;
              }
              if (!event.currentTarget.matches(":focus-visible")) return;
              cancelClose();
              closeFocus.current = null;
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Tab" || event.shiftKey || !open) return;
              const first = content.current?.querySelector<HTMLButtonElement>(
                "li button",
              );
              if (first === null || first === undefined) return;
              event.preventDefault();
              first.focus();
            }}
            onPointerDown={(event) => {
              lastPointerType.current = event.pointerType;
            }}
            onClick={(event) => {
              // Hover-capable pointers already opened this surface. Treat the
              // click as an affirmative open instead of toggling it shut under
              // the pointer; touch remains a normal toggle.
              if (
                open &&
                event.detail !== 0 &&
                lastPointerType.current === "mouse"
              ) {
                event.preventDefault();
              }
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
        onPointerLeave={closeAfterHover}
        onOpenAutoFocus={(event) => {
          // Opening on focus must leave the trigger in the page's Tab order.
          // Its Tab handler enters the rows deliberately; Radix's automatic
          // focus would otherwise pull the reader into a looping focus scope.
          event.preventDefault();
        }}
        onEscapeKeyDown={() => {
          closeFocus.current = "trigger";
        }}
        onCloseAutoFocus={(event) => {
          if (closeFocus.current === "trigger") {
            event.preventDefault();
            closeFocus.current = null;
            if (
              trigger.current !== null &&
              trigger.current !== document.activeElement
            ) {
              suppressFocusOpen.current = true;
              trigger.current.focus({ preventScroll: true });
            }
            return;
          }
          if (closeFocus.current === "none") {
            event.preventDefault();
            closeFocus.current = null;
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const buttons = Array.from(
            content.current?.querySelectorAll<HTMLButtonElement>("li button") ??
              [],
          );
          const first = buttons[0];
          const last = buttons.at(-1);
          if (event.shiftKey && event.target === first) {
            event.preventDefault();
            closeFocus.current = "none";
            suppressFocusOpen.current = true;
            setOpen(false);
            trigger.current?.focus({ preventScroll: true });
            return;
          }
          if (event.shiftKey || event.target !== last || trigger.current === null) {
            return;
          }
          event.preventDefault();
          const next = nextTabbableAfter(trigger.current, content.current);
          closeFocus.current = "none";
          setOpen(false);
          if (next === trigger.current) suppressFocusOpen.current = true;
          next?.focus({ preventScroll: true });
        }}
      >
        <div
          ref={content}
          className="ub-outline-panel-body"
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") cancelClose();
          }}
        >
          <p className="ub-rail-head">On this page</p>
          <ul>
            {entries.map((entry) => (
              <li key={entry.id} className={`ub-outline-l${entry.level}`}>
                <button
                  type="button"
                  onClick={(event) => {
                    scrollBlockIntoView(entry.id);
                    closeFocus.current =
                      event.detail === 0 ? "trigger" : "none";
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
