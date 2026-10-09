/** One observer, validated snapshot and animation frame for a document's views. */
import { DATA_KEY, readDocData } from "@uberblick/schema";
import type { DocData } from "@uberblick/schema";
import type * as Y from "yjs";

type Render = (data: DocData | null, error?: unknown) => void;
interface Binding {
  renderers: Set<Render>;
  pending: Set<Render>;
  snapshot: DocData | null;
  dirty: boolean;
  error: unknown;
  frame: number | null;
  schedule: () => void;
  stop: () => void;
}
const bindings = new WeakMap<Y.Doc, Binding>();

export function bindDocView(doc: Y.Doc | null, render: Render): { schedule: () => void; destroy: () => void } {
  // Standalone editor nodes have no document data, but retain frame coalescing.
  if (doc === null) {
    let frame: number | null = null;
    return {
      schedule: () => {
        if (frame === null) frame = requestAnimationFrame(() => { frame = null; render(null); });
      },
      destroy: () => { if (frame !== null) cancelAnimationFrame(frame); },
    };
  }
  let binding = bindings.get(doc);
  if (binding === undefined) {
    const data = doc.getMap(DATA_KEY);
    const shared: Binding = {
      renderers: new Set(), pending: new Set(), snapshot: null, dirty: true, error: undefined, frame: null,
      schedule: () => {
        if (shared.frame !== null) return;
        shared.frame = requestAnimationFrame(() => {
          shared.frame = null;
          // Read after the burst, before any view projects. Mapping and chrome
          // changes enqueue only their view and leave the snapshot intact.
          if (shared.dirty) {
            try {
              shared.snapshot = readDocData(doc);
              shared.error = undefined;
            } catch (error) {
              shared.snapshot = null;
              shared.error = error;
            }
            shared.dirty = false;
          }
          const pending = [...shared.pending];
          shared.pending.clear();
          for (const callback of pending) {
            if (shared.renderers.has(callback)) callback(shared.snapshot, shared.error);
          }
        });
      },
      stop: () => {
        data.unobserve(changed);
        if (shared.frame !== null) cancelAnimationFrame(shared.frame);
        // Dropping the binding drops its snapshot. A remount always reads the
        // current area, including changes while no observer was attached.
        bindings.delete(doc);
      },
    };
    const changed = (): void => {
      shared.dirty = true;
      for (const callback of shared.renderers) shared.pending.add(callback);
      shared.schedule();
    };
    data.observe(changed);
    bindings.set(doc, shared);
    binding = shared;
  }
  const shared = binding;
  shared.renderers.add(render);
  return {
    schedule: () => { shared.pending.add(render); shared.schedule(); },
    destroy: () => {
      shared.pending.delete(render);
      shared.renderers.delete(render);
      if (shared.renderers.size === 0) shared.stop();
    },
  };
}
