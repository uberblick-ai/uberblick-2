/** Document navigation shared by the comments column and narrow document pane. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent, ReactElement } from "react";
import type { RoomConnection } from "../../collab/rooms.js";
import { useOutline } from "../hooks.js";
import { scrollBlockIntoView } from "./outline.js";
import { Popover, PopoverContent, PopoverTrigger } from "../shadcn/popover.js";

type OpenMode = "closed" | "hover" | "click";

export function OutlinePane({
  connection,
  obscured = false,
  decisionsId = null,
}: {
  connection: RoomConnection | null;
  /** A narrow-screen threads drawer currently covers this control. */
  obscured?: boolean;
  /** Page chrome follows the document headings without entering its blocks. */
  decisionsId?: string | null;
}): ReactElement | null {
  const headings = useOutline(connection);
  const entries = useMemo(
    () => decisionsId === null ? headings : [...headings, { id: decisionsId, level: 1, text: "Decisions" }],
    [headings, decisionsId],
  );
  const [mode, setMode] = useState<OpenMode>("closed");
  const openMode = useRef<OpenMode>("closed");
  const restoreFocus = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const chosen = useRef<{ id: string; scrollTop: number } | null>(null);
  const [titleOffset, setTitleOffset] = useState(0);
  const [paneWidth, setPaneWidth] = useState(0);

  const clearTimer = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const changeMode = (next: OpenMode): void => {
    clearTimer();
    if (next === "closed") restoreFocus.current = openMode.current === "click";
    openMode.current = next;
    setMode(next);
  };
  const enter = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    clearTimer();
    if (openMode.current === "closed") {
      timer.current = setTimeout(() => changeMode("hover"), 250);
    }
  };
  const leave = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    clearTimer();
    if (openMode.current === "hover") {
      timer.current = setTimeout(() => changeMode("closed"), 200);
    }
  };

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (entries.length !== 0 && !obscured) return;
    if (timer.current !== null) clearTimeout(timer.current);
    openMode.current = "closed";
    restoreFocus.current = false;
    setMode("closed");
  }, [entries.length, obscured]);

  useLayoutEffect(() => {
    if (entries.length === 0) return;
    const shell = trigger.current?.closest('[data-slot="sidebar-wrapper"]') ?? document.body;
    let pane: HTMLElement | null = null;
    let frame = 0;
    const update = (): void => {
      // Hydration replaces the waiting pane without necessarily changing headings.
      const nextPane = shell.querySelector<HTMLElement>(".ub-document-pane");
      if (pane !== nextPane) {
        pane?.removeEventListener("scroll", schedule);
        sizes?.disconnect();
        pane = nextPane;
        if (pane !== null) {
          pane.addEventListener("scroll", schedule, { passive: true });
          sizes?.observe(pane);
          const column = pane.querySelector(".ub-column");
          if (column !== null) sizes?.observe(column);
        }
      }
      if (pane === null) return;
      const { top, width } = pane.getBoundingClientRect();
      setPaneWidth(width);
      const title = pane.querySelector<HTMLElement>("[data-outline-title]");
      setTitleOffset(Math.max(0, (title?.getBoundingClientRect().top ?? top) - top));
      // Several short final sections can share the same clamped scroll position.
      if (
        chosen.current !== null && chosen.current.scrollTop === pane.scrollTop &&
        entries.some((entry) => entry.id === chosen.current?.id)
      ) {
        setCurrentId(chosen.current.id);
        return;
      }
      chosen.current = null;
      const reachedEnd = pane.scrollTop > 0 && pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2;
      let active: string | null = null;
      for (const entry of entries) {
        const element = document.getElementById(entry.id);
        if (element !== null && (element.getBoundingClientRect().top <= top + 16 || reachedEnd)) active = entry.id;
      }
      setCurrentId(active);
    };
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    window.addEventListener("resize", schedule);
    const mutations = new MutationObserver(schedule);
    mutations.observe(shell, { childList: true, subtree: true, characterData: true });
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    update();
    return () => {
      cancelAnimationFrame(frame);
      pane?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      mutations.disconnect();
      sizes?.disconnect();
    };
  }, [entries]);

  if (entries.length === 0) return null;
  const current = entries.find((entry) => entry.id === currentId);
  const label = (text: string): string => text.trim() === "" ? "Untitled heading" : text;

  return (
    <Popover open={mode !== "closed"} onOpenChange={(open) => changeMode(open ? "click" : "closed")}>
      <div
        className={`ub-outline z-5 w-full shrink-0 bg-background pt-(--outline-title-offset) pointer-events-auto max-xl:absolute max-xl:start-12 max-xl:top-0 max-xl:w-auto max-xl:pt-0 ${obscured ? "max-xl:hidden" : ""}`}
        style={{ "--outline-title-offset": `${titleOffset}px`, "--outline-pane-width": `${paneWidth}px` } as CSSProperties}
      >
        <PopoverTrigger asChild>
          <button
            ref={trigger}
            type="button"
            aria-haspopup="false"
            className="ub-outline-trigger flex min-h-8 w-full min-w-0 items-center gap-2 border-b border-border bg-transparent px-0 py-2 text-left [font-family:inherit] cursor-pointer focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 [@media(any-pointer:coarse)]:min-h-11"
            onPointerEnter={enter}
            onPointerLeave={leave}
            onClick={(event) => {
              clearTimer();
              if (openMode.current === "hover") {
                event.preventDefault();
                changeMode("click");
              }
            }}
          >
            <span className="shrink-0 ub-type-caption text-muted-foreground">On this page</span>
            {current !== undefined && <span className="min-w-0 truncate ub-type-small text-foreground">{label(current.text)}</span>}
            <svg className="ms-auto size-3 shrink-0 text-muted-foreground" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d={mode === "closed" ? "m3 4.5 3 3 3-3" : "m3 7.5 3-3 3 3"} stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={0}
        collisionPadding={8}
        role="navigation"
        aria-label="On this page"
        className="ub-outline-panel flex w-(--radix-popover-trigger-width)! max-h-[min(60dvh,var(--radix-popover-content-available-height))] flex-col overflow-hidden p-0!"
        onPointerEnter={enter}
        onPointerLeave={leave}
        onOpenAutoFocus={(event) => {
          if (openMode.current === "hover") event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          if (!restoreFocus.current) event.preventDefault();
        }}
      >
        <ul className="m-0 min-h-0 list-none overflow-y-auto p-2">
          {entries.map((entry) => (
            <li key={entry.id} className={`ub-outline-l${entry.level}`}>
              <button
                type="button"
                aria-current={entry.id === currentId ? "location" : undefined}
                className={`block w-full truncate border-s-2 px-2 py-2 text-left ub-type-small hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring [@media(any-pointer:coarse)]:min-h-11 ${entry.id === currentId ? "border-(--brand) text-foreground" : "border-transparent text-muted-foreground"} ${entry.level === 2 ? "ps-5" : ""}`}
                onClick={() => {
                  scrollBlockIntoView(entry.id);
                  const pane = document.querySelector<HTMLElement>(".ub-document-pane");
                  chosen.current = { id: entry.id, scrollTop: pane?.scrollTop ?? 0 };
                  setCurrentId(entry.id);
                  if (openMode.current === "click") changeMode("closed");
                }}
              >
                {label(entry.text)}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
