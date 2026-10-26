/** One Floating UI placement path and one list for all editor menus. */
import { useEffect, useId, useRef } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import type { Editor } from "@tiptap/core";
import { CaretMenuList } from "./CaretMenuList.js";
import type { CaretMenuOption } from "./CaretMenuList.js";
export type { CaretMenuOption } from "./CaretMenuList.js";
import { useEditorControlsHost } from "./EditorControlsHost.js";

export function useCaretMenuIds(active: number): {
  listId: string;
  activeId: string | undefined;
} {
  const listId = useId();
  return { listId, activeId: active < 0 ? undefined : `${listId}-${active}` };
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
  const card = useRef<HTMLDivElement | null>(null);
  const controlsHost = useEditorControlsHost();

  useEffect(() => {
    const element = card.current;
    if (!open || !element) return;
    const boundary = controlsHost?.boundary ?? host.current?.closest<HTMLElement>(".ub-pane") ?? undefined;
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
  }, [open, editor, host, anchor, controlsHost?.boundary]);

  useEffect(() => {
    if (!open) return;
    const ownerDocument = editor.view.dom.ownerDocument;
    const outside = (event: MouseEvent): void => {
      const path = event.composedPath();
      if (card.current && path.includes(card.current)) return;
      if (anchor?.current && path.includes(anchor.current)) return;
      onDismiss();
    };
    // Native click dismisses on tap without treating touch scroll as dismissal.
    // Keep keys with ProseMirror or the gutter input so composing Escape stays
    // native. Reconsider when a primitive preserves both interaction guarantees.
    ownerDocument.addEventListener("click", outside);
    return () => ownerDocument.removeEventListener("click", outside);
  }, [open, editor, anchor, onDismiss]);

  if (!open) return null;
  return createPortal(
    <div
      ref={card}
      data-slot="caret-menu-content"
      role="presentation"
      className="fixed top-0 left-0 z-50 flex w-[17rem] flex-col overflow-hidden rounded-(--radius) border border-(--border) bg-card p-[0.3rem] text-card-foreground shadow-(--shadow-float)"
    >
      {children}
      <CaretMenuList listId={listId} listKey={listKey} label={label} options={options}
        active={active} reveal={reveal} highlightAt={highlightAt} choose={choose} empty={empty} />
    </div>,
    controlsHost?.portalContainer ?? editor.view.dom.ownerDocument.body,
  );
}
