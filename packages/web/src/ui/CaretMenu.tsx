/** One public Popover anchor/placement path and one list for all editor menus. */
import { Fragment, useEffect, useId, useRef } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { Popover, PopoverAnchor, PopoverContent } from "./shadcn/popover.js";

export function useCaretMenuIds(active: number): {
  listId: string;
  activeId: string | undefined;
} {
  const listId = useId();
  return { listId, activeId: active < 0 ? undefined : `${listId}-${active}` };
}

export interface CaretMenuOption {
  id: string;
  label: string;
  group?: string;
  hint?: string | null | undefined;
}

export function CaretMenu({
  editor,
  host,
  anchor,
  open,
  onDismiss,
  listId,
  label,
  options,
  active,
  reveal,
  highlightAt,
  choose,
  empty,
  children,
  onFieldEscape,
  listKey,
}: {
  editor: Editor;
  host: RefObject<HTMLElement | null>;
  /** Without an element, anchor at the live caret; gutter mode supplies its +. */
  anchor?: RefObject<HTMLElement | null> | undefined;
  open: boolean;
  onDismiss: () => void;
  onFieldEscape?: () => void;
  listId: string;
  listKey: string;
  label: string;
  options: CaretMenuOption[];
  active: number;
  reveal: boolean;
  highlightAt: (index: number) => void;
  choose: (index: number) => void;
  empty: string;
  children?: ReactNode;
}): ReactElement {
  const list = useRef<HTMLDivElement | null>(null);
  const virtual = useRef({ getBoundingClientRect: (): DOMRect => new DOMRect() });
  // Radix reads this public virtual anchor on its animation-frame positioning
  // path, so query edits and pane scrolls both use live ProseMirror geometry.
  virtual.current.getBoundingClientRect = () => {
    if (anchor?.current) return anchor.current.getBoundingClientRect();
    try {
      const caret = editor.view.coordsAtPos(editor.state.selection.from);
      return new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top);
    } catch {
      // A headless DOM has no text geometry.
      return new DOMRect();
    }
  };

  useEffect(() => {
    // Keyboard choices reveal an option; a pointer never moves the list beneath it.
    if (!reveal) return;
    const box = list.current;
    const option = box?.querySelectorAll<HTMLElement>('[role="option"]')[active];
    if (!box || !option) return;
    const view = box.getBoundingClientRect();
    const rect = option.getBoundingClientRect();
    if (rect.top < view.top) box.scrollTop -= view.top - rect.top;
    else if (rect.bottom > view.bottom) box.scrollTop += rect.bottom - view.bottom;
  }, [active, reveal]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => { if (!next) onDismiss(); }}
    >
      <PopoverAnchor virtualRef={virtual} />
      <PopoverContent
        variant="caret-menu"
        role="presentation"
        align="start"
        collisionBoundary={host.current?.closest<HTMLElement>(".ub-pane") ?? null}
        collisionPadding={6}
        sticky="always"
        updatePositionStrategy="always"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        // Prose focus is deliberately outside the portalled card.
        onFocusOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          // Radix owns the document's capture listener. Suppress its default
          // dismissal, then send prose Escape through the public PM prop chain
          // too. A prevented native event alone would never reach PM's input.
          event.preventDefault();
          if (event.isComposing || event.keyCode === 229 || editor.view.composing) return;
          if (anchor) onFieldEscape?.();
          else editor.view.someProp("handleKeyDown", (handler) => handler(editor.view, event));
        }}
      >
        {children}
        {options.length === 0 ? (
          <p className="m-0 p-[0.4rem] text-(--muted-foreground)">{empty}</p>
        ) : (
          <div
            key={listKey}
            ref={list}
            id={listId}
            role="listbox"
            aria-label={label}
            className="min-h-0 max-h-[17rem] overflow-y-auto"
          >
            {options.map((option, index) => (
              <Fragment key={option.id}>
                {option.group && options[index - 1]?.group !== option.group && (
                  <p role="presentation" className="mt-[0.35rem] mb-[0.15rem] px-[0.4rem] font-(family-name:--font-mono) text-[0.65rem] tracking-[0.06em] text-(--muted-foreground) uppercase">
                    {option.group}
                  </p>
                )}
                <button
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-label={option.label}
                  aria-selected={index === active}
                  className={`flex min-h-6 w-full cursor-pointer items-center gap-2 rounded-(--radius-sm) border px-[0.4rem] py-[0.3rem] text-left text-[0.9rem] [font-family:inherit] [@media(pointer:coarse)]:min-h-11 ${index === active ? "border-(--border) bg-(--card-accent) text-(--accent-foreground)" : "border-transparent bg-transparent text-card-foreground"}`}
                  // A pick must run against the prose selection, before focus
                  // can leave it. Touch clicks still reach the same command.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => highlightAt(index)}
                  onClick={() => choose(index)}
                >
                  <span className="min-w-0 flex-1">{option.label}</span>
                  {option.hint && <span className="font-(family-name:--font-mono) text-xs text-(--muted-foreground)">{option.hint}</span>}
                </button>
              </Fragment>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
