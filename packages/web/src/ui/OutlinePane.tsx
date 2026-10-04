/** A floating view of the open document's first two heading levels. */

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
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
  const closingFromTab = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);

  // A live edit can remove the last eligible heading without unmounting this
  // component. Do not remember an open surface for a later heading.
  useEffect(() => {
    if (entries.length !== 0) return;
    setOpen(false);
  }, [entries.length]);

  useEffect(() => {
    // The state is meaningful only where CSS turns the rail into an overlay;
    // on a wide screen the same rail state must not dismiss this sibling.
    if (!obscured) return;
    const closeWhenCovered = (): void => {
      if (trigger.current?.getClientRects().length !== 0) return;
      setOpen(false);
    };
    closeWhenCovered();
    window.addEventListener("resize", closeWhenCovered);
    return () => window.removeEventListener("resize", closeWhenCovered);
  }, [obscured]);

  if (entries.length === 0) return null;

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <div
        // The drawer covers this edge; hiding also removes the trigger from Tab order.
        className={`ub-outline self-start shrink-0 mt-3 me-3${obscured ? " max-xl:hidden" : ""}`}
      >
        <DropdownMenuTrigger asChild>
          <button
            ref={trigger}
            type="button"
            className="ub-outline-trigger inline-flex min-h-6 min-w-6 items-center gap-[0.45rem] rounded-full border border-border bg-(--card-accent) px-[0.55rem] py-1 text-secondary-foreground text-xs/[1.4] whitespace-nowrap cursor-pointer [font-family:inherit] hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 [@media(any-pointer:coarse)]:min-h-11"
          >
            Contents <span className="text-[0.7rem] text-muted-foreground">{entries.length}</span>
          </button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent
        align="end"
        side="bottom"
        collisionPadding={8}
        className="ub-outline-panel flex w-[min(20rem,calc(100vw_-_2rem))] max-h-[min(calc(100vh_-_2rem),var(--radix-dropdown-menu-content-available-height))]! flex-col overflow-hidden! p-0!"
        onCloseAutoFocus={(event) => {
          if (closingFromTab.current) {
            closingFromTab.current = false;
            event.preventDefault();
          }
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
