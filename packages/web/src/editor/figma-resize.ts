import { Accessibility, DragDropManager, Draggable, Feedback, PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import { FIGMA_MAX_HEIGHT, FIGMA_MIN_HEIGHT } from "@uberblick/schema";

export function figmaResize(handle: HTMLElement, height: () => number, show: (height: number) => void, commit: (height: number) => void): {
  setDisabled: (disabled: boolean) => void; destroy: () => void;
} {
  const clamp = (value: number): number => Math.min(FIGMA_MAX_HEIGHT, Math.max(FIGMA_MIN_HEIGHT, Math.round(value)));
  let start = height();
  const manager = new DragDropManager({
    plugins: (defaults) => defaults.filter((plugin) => plugin !== Feedback && plugin !== Accessibility),
    sensors: [PointerSensor.configure({ activationConstraints: [new PointerActivationConstraints.Distance({ value: 2 })] })],
  });
  const draggable = new Draggable({ id: "figma-height", element: handle }, manager);
  manager.monitor.addEventListener("dragstart", () => { start = height(); });
  manager.monitor.addEventListener("dragmove", (_event, current) => show(clamp(start + current.dragOperation.transform.y)));
  manager.monitor.addEventListener("dragend", (event, current) => {
    if (!event.canceled) commit(clamp(start + current.dragOperation.transform.y));
    show(height());
  });
  return {
    setDisabled(disabled) { draggable.disabled = disabled; },
    destroy() { draggable.destroy(); manager.destroy(); },
  };
}
