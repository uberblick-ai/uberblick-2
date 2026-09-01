/**
 * The collaboration binding: y-prosemirror plugins over a schema-owned fragment.
 *
 * The fragment is passed in, and it is always `getBlocksFragment(ydoc)` — the
 * `blocks` Y.XmlFragment, **not** the Y.Doc's default fragment. y-prosemirror's
 * examples bind `ydoc.getXmlFragment('prosemirror')`; binding that here would
 * create a fifth root type the schema package knows nothing about, and the
 * document would look empty to every other client.
 *
 * Plugin order matters and is not arbitrary: `yCursorPlugin` and `yUndoPlugin`
 * both read `ySyncPluginKey`'s state, so the sync plugin must come first.
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
 * How long a departed agent's caret stays on screen after its session left the
 * room (ms).
 *
 * An MCP client that writes one block and exits is gone from awareness within
 * milliseconds of the tool response, so the caret that says *who* wrote is on
 * screen for less time than it takes to look at it (#304). The five seconds
 * that first bought was still gone before the owner had looked at it, so this
 * is the thirty the MCP server already gives a *connected* agent's cursor
 * (`cursorTtlMs`, #407): one lifetime to learn, whichever way the session ends.
 *
 * The two clocks compose rather than coincide — the server's runs from the last
 * write while a session is connected, this one from the moment it leaves — so
 * an agent that writes, lingers and then exits is drawn for up to the sum.
 * Mistaking it for presence is ruled out elsewhere, not by the number: the
 * retention is a decoration inside this one editor, and every count and
 * presence list reads the real awareness states.
 */
export const AGENT_CURSOR_GRACE_MS = 30_000;

/** An awareness state as it arrives on the wire — see `collab/identity.ts`. */
type AwarenessState = Record<string, unknown> & {
  user?: { name?: unknown };
  cursor?: unknown;
  client?: unknown;
};

/**
 * Whether this state is an agent caret worth holding onto: the agent marker, a
 * cursor, and a name to write beside it.
 *
 * The name is part of the test, not an afterthought: a caret retained without
 * one would draw a bare line over the prose saying nothing about who left it,
 * which is the opposite of what the grace period exists for. The marker is
 * required *positively* (#564): the grace exists for agents, and a session that
 * merely omits `client` — a browser tab on a bundle from before #267, or any
 * future non-agent client — is not one. Held on omission, a person who closed
 * their tab kept a caret over the prose under their own name for the full
 * grace, which is the opposite of the rule that a reader who leaves is *gone*.
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
 * A read-only view of `awareness` that keeps a departed agent's last cursor for
 * {@link AGENT_CURSOR_GRACE_MS}, so the caret and its label survive the session
 * that drew them.
 *
 * A *view*, deliberately: the retained state is never written back into the
 * awareness instance the rest of the app reads. Presence chips, the agent
 * count and the sync panel all read the real states, so a session that left
 * stops being present the instant it leaves — the grace is a decoration in one
 * editor and nothing else. Nothing is republished, no transport is held open,
 * and nothing reaches the Y.Doc; a reload starts with an empty map.
 *
 * Only the handful of members `yCursorPlugin` uses are implemented, hence the
 * cast at the end. Its `change` listener is the one the expiry has to reach, so
 * that subscription is ours; every other event is passed straight through.
 *
 * Exported so the grace can be driven on fake timers without an editor and a
 * hub in the way; the one caller in the extension below is the production
 * wiring, and passes {@link AGENT_CURSOR_GRACE_MS}.
 */
export function withDepartedAgentCursors(
  awareness: Awareness,
  graceMs: number,
): Awareness {
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
   * Re-read every live state, so a departure has something to hold onto.
   *
   * Every state, not only the ones a change names: an agent already in the room
   * when this editor opened is in no `added` list, and that is the ordinary
   * case — a reader opening a document an agent is writing.
   */
  const remember = (): void => {
    const states = awareness.getStates() as Map<number, AwarenessState>;
    for (const [clientId, state] of states) {
      // A live state always wins: this peer is here, and whatever it is
      // pointing at now is the truth — a retained caret must never overwrite
      // it, nor come back once the peer has spoken again.
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
      // Subscribed for exactly as long as somebody is watching: the plugin's
      // own `destroy` is what takes the last listener away, so this view leaves
      // nothing behind on an awareness instance shared by every open room.
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
  } as unknown as Awareness;
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
          withDepartedAgentCursors(awareness, AGENT_CURSOR_GRACE_MS),
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
