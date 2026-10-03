/** One Floating UI placement path and one list for all editor menus. */
import { Fragment, useEffect, useId, useRef } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import type { Editor } from "@tiptap/core";

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
  listKey,
}: {
  editor: Editor;
  host: RefObject<HTMLElement | null>;
  /** Without an element, anchor at the live caret; gutter mode supplies its +. */
  anchor?: RefObject<HTMLElement | null> | undefined;
  open: boolean;
  onDismiss: () => void;
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
}): ReactElement | null {
  const list = useRef<HTMLDivElement | null>(null);
  const card = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = card.current;
    if (!open || !element) return;
    const boundary = host.current?.closest<HTMLElement>(".ub-pane") ?? undefined;
    const reference = {
      contextElement: anchor?.current ?? editor.view.dom,
      getBoundingClientRect: (): DOMRect => {
        if (anchor?.current) return anchor.current.getBoundingClientRect();
        try {
          const caret = editor.view.coordsAtPos(editor.state.selection.from);
          return new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top);
        } catch {
          // A headless DOM has no text geometry.
          return new DOMRect();
        }
      },
    };
    const collision = { boundary, padding: 6 };
    let disposed = false;
    const update = async (): Promise<void> => {
      const position = await computePosition(reference, element, {
        strategy: "fixed",
        placement: "bottom-start",
        middleware: [
          offset(6), flip(collision), shift(collision),
          size({
            ...collision,
            apply: ({ availableWidth, availableHeight }) => {
              if (disposed) return;
              Object.assign(element.style, {
                maxWidth: `${Math.max(0, availableWidth)}px`,
                maxHeight: `${Math.max(0, availableHeight)}px`,
              });
            },
          }),
        ],
      });
      if (disposed) return;
      Object.assign(element.style, { left: `${position.x}px`, top: `${position.y}px` });
      element.dataset.side = position.placement.split("-")[0];
    };
    // Animation frames observe live caret/gutter geometry even when it moves
    // without a transaction. Floating UI owns collision and resize handling.
    const stop = autoUpdate(reference, element, update, { animationFrame: true });
    return () => { disposed = true; stop(); };
  }, [open, editor, host, anchor]);

  useEffect(() => {
    if (!open) return;
    const ownerDocument = editor.view.dom.ownerDocument;
    const outside = (event: MouseEvent): void => {
      const path = event.composedPath();
      if (card.current && path.includes(card.current)) return;
      if (anchor?.current && path.includes(anchor.current)) return;
      onDismiss();
    };
    // The owner-confirmed exception uses only native clicks: a tap clicks,
    // while a touch scroll does not. Keys stay with PM or the gutter input,
    // so native composing Escape is never intercepted by this card.
    ownerDocument.addEventListener("click", outside);
    return () => ownerDocument.removeEventListener("click", outside);
  }, [open, editor, anchor, onDismiss]);

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

  if (!open) return null;
  return createPortal(
    <div
      ref={card}
      data-slot="caret-menu-content"
      role="presentation"
      className="fixed top-0 left-0 z-50 flex w-[17rem] flex-col overflow-hidden rounded-(--radius) border border-(--border) bg-card p-[0.3rem] text-card-foreground shadow-(--shadow-float)"
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
    </div>,
    editor.view.dom.ownerDocument.body,
  );
}
