/**
 * Bind only the schema-owned blocks fragment; a default prosemirror fragment
 * would create an unread root. Put ySync before cursor and undo plugins because
 * both read its state.
 */

import { Extension } from "@tiptap/core";
import type { Plugin } from "@tiptap/pm/state";
import {
  redo,
  undo,
  yCursorPlugin,
  ySyncPlugin,
  yUndoPlugin,
} from "y-prosemirror";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { AGENT_CLIENT } from "../collab/identity.js";

/**
 * Retain a departed agent cursor and title avatar for 30 seconds from departure.
 * The connected cursor TTL starts at its last write, so these clocks can add.
 * Retained avatars are muted and marked left; live connection/presence counts
 * continue to use real awareness.
 */
export const AGENT_CURSOR_GRACE_MS = 30_000;

/** Local presentation metadata; never an awareness field published on the wire. */
export type AgentCursorAwareness = Awareness & {
  isDeparted(clientId: number): boolean;
};

const documentViews = new WeakMap<Awareness, AgentCursorAwareness>();

/**
 * One retention decision per provider's document room. The shell's subscription
 * keeps it alive across editor rebinds; the last reader leaving clears it.
 */
export function agentCursorAwareness(awareness: Awareness): AgentCursorAwareness {
  let view = documentViews.get(awareness);
  if (view === undefined) {
    view = withDepartedAgentCursors(awareness, AGENT_CURSOR_GRACE_MS);
    documentViews.set(awareness, view);
  }
  return view;
}

/** An awareness state as it arrives on the wire — see `collab/identity.ts`. */
type AwarenessState = Record<string, unknown> & {
  user?: { name?: unknown };
  cursor?: unknown;
  client?: unknown;
};

/**
 * Retain only positively marked agent sessions with a cursor and nonempty name.
 * An omitted client marker must not retain a departing person's cursor.
 */
function isAttributedAgentCursor(
  state: AwarenessState | undefined,
): state is AwarenessState {
  if (state === undefined || state.client !== AGENT_CLIENT) return false;
  if (state.cursor === null || state.cursor === undefined) return false;
  const name = state.user?.name;
  return typeof name === "string" && name.trim() !== "";
}

/**
 * Retain departed agent cursors locally; never publish retained state, hold a
 * transport open or write it to the document. Reload starts empty. The title
 * cluster shares this view; connection counts and Present now use real states.
 * Expiry emits change; other events pass through. Implement only the members
 * used by the cursor plugin and title presence reader.
 */
export function withDepartedAgentCursors(
  awareness: Awareness,
  graceMs: number,
): AgentCursorAwareness {
  type Listener = (...args: unknown[]) => void;
  interface Change {
    added: number[];
    updated: number[];
    removed: number[];
  }

  const listeners = new Set<Listener>();
  /** The last attributed cursor seen from each live agent session. */
  const lastSeen = new Map<number, AwarenessState>();
  /** Departed sessions still being drawn, and the timer that ends each. */
  const retained = new Map<
    number,
    { state: AwarenessState; timer: ReturnType<typeof setTimeout> }
  >();

  const announce = (change: Change): void => {
    for (const listener of [...listeners]) listener(change);
  };

  const forget = (clientId: number): void => {
    const held = retained.get(clientId);
    if (held === undefined) return;
    clearTimeout(held.timer);
    retained.delete(clientId);
  };

  /**
   * Read all live states, including agents present before subscription, so their
   * departure has an attributed cursor to retain.
   */
  const remember = (): void => {
    const states = awareness.getStates() as Map<number, AwarenessState>;
    for (const [clientId, state] of states) {
      // Live states replace retained cursors immediately.
      forget(clientId);
      if (isAttributedAgentCursor(state)) lastSeen.set(clientId, state);
      else lastSeen.delete(clientId);
    }
  };

  const onChange = (change: Change): void => {
    remember();
    for (const clientId of change.removed) {
      const departed = lastSeen.get(clientId);
      lastSeen.delete(clientId);
      if (departed === undefined) continue;
      const timer = setTimeout(() => {
        retained.delete(clientId);
        announce({ added: [], updated: [], removed: [clientId] });
      }, graceMs);
      retained.set(clientId, { state: departed, timer });
    }
    announce(change);
  };

  return {
    clientID: awareness.clientID,
    isDeparted: (clientId: number) => retained.has(clientId),
    getStates(): Map<number, AwarenessState> {
      const live = awareness.getStates() as Map<number, AwarenessState>;
      if (retained.size === 0) return live;
      const merged = new Map(live);
      for (const [clientId, held] of retained) {
        if (!merged.has(clientId)) merged.set(clientId, held.state);
      }
      return merged;
    },
    getLocalState: () => awareness.getLocalState(),
    setLocalStateField: (field: string, value: unknown) => {
      awareness.setLocalStateField(field, value);
    },
    on(event: string, listener: Listener) {
      if (event !== "change") {
        awareness.on(event, listener);
        return;
      }
      // Editor rebinds share the title's lifetime; the last reader clears timers.
      if (listeners.size === 0) {
        remember();
        awareness.on("change", onChange);
      }
      listeners.add(listener);
    },
    off(event: string, listener: Listener) {
      if (event !== "change") {
        awareness.off(event, listener);
        return;
      }
      listeners.delete(listener);
      if (listeners.size > 0) return;
      awareness.off("change", onChange);
      for (const clientId of [...retained.keys()]) forget(clientId);
      lastSeen.clear();
    },
  } as unknown as AgentCursorAwareness;
}

export interface CollaborationOptions {
  /** The `blocks` fragment of the document's Y.Doc. */
  fragment: Y.XmlFragment | null;
  /** Provider awareness. `null` disables remote cursors (tests, read-only views). */
  awareness: Awareness | null;
}

export const Collaboration = Extension.create<CollaborationOptions>({
  name: "uberblickCollaboration",

  addOptions() {
    return { fragment: null, awareness: null };
  },

  addProseMirrorPlugins() {
    const { fragment, awareness } = this.options;
    if (fragment === null) return [];
    const plugins: Plugin[] = [ySyncPlugin(fragment) as unknown as Plugin];
    if (awareness !== null) {
      plugins.push(
        yCursorPlugin(
          agentCursorAwareness(awareness),
        ) as unknown as Plugin,
      );
    }
    plugins.push(yUndoPlugin() as unknown as Plugin);
    return plugins;
  },

  addKeyboardShortcuts() {
    // The Yjs UndoManager replaces ProseMirror history entirely: undoing a
    // ProseMirror step would revert remote changes interleaved with local ones.
    return {
      "Mod-z": () => undo(this.editor.state),
      "Mod-y": () => redo(this.editor.state),
      "Shift-Mod-z": () => redo(this.editor.state),
    };
  },
});
