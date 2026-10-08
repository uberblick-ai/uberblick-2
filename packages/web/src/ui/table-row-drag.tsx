/** A row handle shares a pointer gesture with its standard Radix menu. */
import { useCallback, useLayoutEffect, useRef } from "react";
import type { MouseEvent, ReactElement } from "react";
import { useDraggable } from "@dnd-kit/react";
import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import type { TableRowTarget } from "../editor/table-controls.js";
import { DropdownMenuTrigger } from "./shadcn/dropdown-menu.js";

export const tableRowSensors = [PointerSensor.configure({
  activationConstraints: (event) => event.pointerType === "touch"
    ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
    : [new PointerActivationConstraints.Distance({ value: 5 })],
})];

export function TableRowHandle({ target, index, rowKey, bottom, size, revealed, open, clickGuard, resetGuard }: {
  target: TableRowTarget;
  index: number;
  rowKey: number;
  bottom: number;
  size: number;
  revealed: boolean;
  open: () => void;
  clickGuard: (event: MouseEvent<HTMLButtonElement>) => void;
  resetGuard: () => void;
}): ReactElement {
  const button = useRef<HTMLButtonElement | null>(null);
  const draggable = useDraggable({
    id: rowKey, disabled: index === 0, data: { target },
  });
  // Geometry refreshes must not detach the sensor while a press is pending.
  const dragRef = draggable.ref;
  const attach = useCallback((element: HTMLButtonElement | null): void => {
    button.current = element;
    dragRef(element);
  }, [dragRef]);
  useLayoutEffect(() => {
    const handle = button.current;
    if (handle === null) return;
    // Let dnd-kit's native target listener see the unprevented press. Radix's
    // delegated pointerdown must wait for a click, or it takes over the drag;
    // preventDefault here would also veto the delayed touch pickup.
    const press = (event: PointerEvent): void => { event.stopPropagation(); };
    handle.addEventListener("pointerdown", press);
    return () => handle.removeEventListener("pointerdown", press);
  }, []);
  return (
    <DropdownMenuTrigger asChild>
      <button ref={attach}
        type="button" className="ub-table-control ub-table-row-handle"
        data-table-row={index} data-revealed={revealed}
        style={{ right: size / 2, top: bottom - size / 2, width: size, height: size }}
        aria-label={`Row ${index + 1} actions`} aria-keyshortcuts="Control+Alt+R Shift+F10"
        title="Row actions · drag to move; Control+Alt+R or Shift+F10"
        onMouseDown={(event) => event.preventDefault()}
        onPointerDownCapture={resetGuard} onKeyDownCapture={resetGuard}
        onClickCapture={clickGuard} onClick={open}>
        <span aria-hidden="true">⋮</span>
      </button>
    </DropdownMenuTrigger>
  );
}
