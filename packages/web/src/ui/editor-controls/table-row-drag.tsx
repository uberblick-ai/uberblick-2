/** A row or column handle shares a pointer gesture with its standard Radix menu. */
import { useCallback, useLayoutEffect, useRef } from "react";
import type { CSSProperties, MouseEvent, ReactElement } from "react";
import { useDraggable } from "@dnd-kit/react";
import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import type { TableColumnTarget, TableRowTarget } from "../../editor/table-controls.js";
import { DropdownMenuTrigger } from "../shadcn/dropdown-menu.js";

export const tableRowSensors = [PointerSensor.configure({
  activationConstraints: (event) => event.pointerType === "touch"
    ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
    : [new PointerActivationConstraints.Distance({ value: 5 })],
})];

export type TableDragData = { kind: "row"; target: TableRowTarget } | { kind: "column"; target: TableColumnTarget };

export function TableHandle({ data, dragKey, disabled, axis, label, style, revealed, open, clickGuard, resetGuard, ...position }: {
  data: TableDragData;
  dragKey: number;
  disabled: boolean;
  axis: "row" | "column";
  label: string;
  style: CSSProperties;
  revealed: boolean;
  open: () => void;
  clickGuard: (event: MouseEvent<HTMLButtonElement>) => void;
  resetGuard: () => void;
  "data-table-row"?: number;
  "data-table-column"?: number;
}): ReactElement {
  const button = useRef<HTMLButtonElement | null>(null);
  const draggable = useDraggable({ id: dragKey, disabled, data });
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
      <button ref={attach} {...position}
        type="button" className={`ub-table-control ub-table-handle ub-table-${axis}-handle`}
        data-revealed={revealed} style={style}
        aria-label={label}
        title={disabled ? `${axis === "row" ? "Row" : "Column"} actions` : `${axis === "row" ? "Row" : "Column"} actions · drag to move`}
        onMouseDown={(event) => event.preventDefault()}
        onPointerDownCapture={resetGuard} onKeyDownCapture={resetGuard}
        onClickCapture={clickGuard} onClick={open}>
        <span aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
  );
}
