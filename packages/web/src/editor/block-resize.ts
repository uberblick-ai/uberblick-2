import { Accessibility, DragDropManager, Draggable, Feedback, PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";

export function blockResize(handle: HTMLElement, { min, max, height, show, commit, restore, rows = () => 1 }: {
  min: number; max: number;
  height: () => number;
  show: (height: number) => void;
  commit: (height: number) => void;
  restore: () => void;
  rows?: () => number;
}): {
  isDragging: () => boolean; setDisabled: (disabled: boolean) => void; destroy: () => void;
} {
  const clamp = (value: number): number => Math.min(max, Math.max(min, Math.round(value)));
  let start = height();
  let rowCount = 1;
  let dragging = false;
  const manager = new DragDropManager({
    plugins: (defaults) => defaults.filter((plugin) => plugin !== Feedback && plugin !== Accessibility),
    sensors: [PointerSensor.configure({ activationConstraints: [new PointerActivationConstraints.Distance({ value: 2 })] })],
  });
  const draggable = new Draggable({ id: "block-height", element: handle }, manager);
  manager.monitor.addEventListener("dragstart", () => { start = height(); rowCount = Math.max(1, rows()); dragging = true; });
  // Every row grows when panel plots share a height. Divide the pointer travel
  // so the bottom edge, rather than each individual row, follows the gesture.
  manager.monitor.addEventListener("dragmove", (event, current) => {
    // dragmove runs before dnd-kit applies `to` to the operation's position.
    const position = current.dragOperation.position;
    const delta = event.to === undefined ? position.delta.y + (event.by?.y ?? 0) : event.to.y - position.initial.y;
    show(clamp(start + delta / rowCount));
  });
  manager.monitor.addEventListener("dragend", (event, current) => {
    dragging = false;
    if (!event.canceled) commit(clamp(start + current.dragOperation.transform.y / rowCount));
    restore();
  });
  return {
    isDragging: () => dragging,
    setDisabled(disabled) {
      if (disabled && !manager.dragOperation.status.idle) manager.actions.stop({ canceled: true });
      draggable.disabled = disabled;
    },
    destroy() { draggable.destroy(); manager.destroy(); },
  };
}
