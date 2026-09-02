#!/usr/bin/env python3
"""Proof 0b instrumentation: anchored, idempotent edits to the throwaway worktree.

Targets:
  1. y-prosemirror 1.3.7  src/plugins/sync-plugin.js  (node_modules, ESM src used by Vite)
  2. packages/web/src/editor/guarded-binding.ts
  3. packages/web/src/collab/rooms.ts

Every edit is an exact-anchor replacement that must match exactly once; a
missing anchor aborts. Originals are kept beside the file as *.p0orig so the
node_modules change can be diffed afterwards.
"""
import os
import shutil
import sys

W = sys.argv[1]
YP = os.path.join(W, "packages/web/node_modules/y-prosemirror/src/plugins/sync-plugin.js")
GB = os.path.join(W, "packages/web/src/editor/guarded-binding.ts")
RO = os.path.join(W, "packages/web/src/collab/rooms.ts")


def patch(path, edits):
    real = os.path.realpath(path)
    orig = real + ".p0orig"
    if not os.path.exists(orig):
        shutil.copyfile(real, orig)
    src = open(orig).read()
    for anchor, replacement in edits:
        count = src.count(anchor)
        if count != 1:
            raise SystemExit(f"{path}: anchor matched {count} times:\n{anchor}")
        src = src.replace(anchor, replacement)
    open(real, "w").write(src)
    print(f"patched {real} ({len(edits)} edits)")


# ---------------------------------------------------------------- 1. y-prosemirror
YP_HELPERS = """import * as utils from '../utils.js'

// ---- Proof 0b instrumentation (throwaway; see scratchpad/proof0b) ----
const p0seq = () => (globalThis.__p0seq = (globalThis.__p0seq || 0) + 1)
const p0 = (step, data = {}) => {
  try {
    const line = JSON.stringify({ bt: Date.now(), bseq: p0seq(), trace: 'yprosemirror', step, ...data })
    console.log('P0B ' + line)
  } catch (e) {
    console.log('P0B ' + JSON.stringify({ trace: 'yprosemirror', step: 'log-failed', error: String(e) }))
  }
}
const p0Text = (ytext) => {
  try {
    return ytext.toDelta().map((d) => (typeof d.insert === 'string' ? d.insert : '\\u0000')).join('')
  } catch (e) {
    return '<err ' + String(e) + '>'
  }
}
const p0YBlocks = (fragment) => {
  try {
    return fragment.toArray().map((el) =>
      el instanceof Y.XmlElement
        ? { id: el.getAttribute('id') ?? null, type: el.nodeName, text: el.toArray().map((c) => (c instanceof Y.XmlText ? p0Text(c) : '<' + c.constructor.name + '>')).join('') }
        : { id: null, type: String(el.constructor.name), text: '' })
  } catch (e) {
    return String(e)
  }
}
const p0PmBlocks = (doc) => {
  try {
    const out = []
    doc.forEach((n) => out.push({ id: n.attrs.id ?? null, type: n.type.name, text: n.textContent }))
    return out
  } catch (e) {
    return String(e)
  }
}
const p0Origin = (o) => (o === null || o === undefined ? null : typeof o === 'object' ? (o.constructor && o.constructor.name) || 'object' : String(o))
const p0Stack = () => (new Error().stack || '').split('\\n').slice(2, 14).map((l) => l.trim()).join(' | ')
// ---- end instrumentation helpers ----
"""

YP_EDITS = [
    ("import * as utils from '../utils.js'\n", YP_HELPERS),
    # update(): record whether the mux was entered and the PM/Y state it wrote from
    ("""              binding.mux(() => {
                /** @type {Y.Doc} */ (pluginState.doc).transact((tr) => {
                  tr.meta.set('addToHistory', pluginState.addToHistory)
                  binding._prosemirrorChanged(view.state.doc)
                }, ySyncPluginKey)
              })
            }
          }
        },""",
     """              let p0entered = false
              binding.mux(() => {
                p0entered = true; // semicolon: the next line starts with "(" (ASI hazard)
                /** @type {Y.Doc} */ (pluginState.doc).transact((tr) => {
                  tr.meta.set('addToHistory', pluginState.addToHistory)
                  binding._prosemirrorChanged(view.state.doc)
                }, ySyncPluginKey)
              })
              p0('sync.update', { entered: p0entered, isChangeOrigin: pluginState.isChangeOrigin, addToHistory: pluginState.addToHistory, pm: p0PmBlocks(view.state.doc), y: p0YBlocks(binding.type) })
            } else {
              p0('sync.update.initialUnchanged', { pm: p0PmBlocks(view.state.doc) })
            }
          }
        },"""),
    # view(): log creation
    ("""    view: (view) => {
      binding.initView(view)
      if (mapping == null) {
        // force rerender to update the bindings mapping
        binding._forceRerender()
      }
      onFirstRender()""",
     """    view: (view) => {
      p0('sync.view.create', { pmInitial: p0PmBlocks(view.state.doc), y: p0YBlocks(binding.type), stack: p0Stack() })
      binding.initView(view)
      if (mapping == null) {
        // force rerender to update the bindings mapping
        binding._forceRerender()
      }
      p0('sync.view.created', { pm: p0PmBlocks(view.state.doc) })
      onFirstRender()"""),
    # _forceRerender
    ("""  _forceRerender () {
    this.mapping.clear()
    this.mux(() => {""",
     """  _forceRerender () {
    p0('sync.forceRerender', { pmBefore: p0PmBlocks(this.prosemirrorView.state.doc), y: p0YBlocks(this.type), stack: p0Stack() })
    this.mapping.clear()
    this.mux(() => {"""),
    # _typeChanged
    ("""  _typeChanged (events, transaction) {
    if (this.prosemirrorView == null) return
    const syncState = ySyncPluginKey.getState(this.prosemirrorView.state)
    if (
      events.length === 0 || syncState.snapshot != null ||
      syncState.prevSnapshot != null
    ) {
      // drop out if snapshot is active
      this.renderSnapshot(syncState.snapshot, syncState.prevSnapshot)
      return
    }
    this.mux(() => {""",
     """  _typeChanged (events, transaction) {
    if (this.prosemirrorView == null) { p0('sync.typeChanged.noView', { events: events.length, origin: p0Origin(transaction.origin) }); return }
    const syncState = ySyncPluginKey.getState(this.prosemirrorView.state)
    p0('sync.typeChanged', { events: events.length, origin: p0Origin(transaction.origin), local: transaction.local, changed: transaction.changed.size, deleted: transaction.deleteSet.clients.size, pmBefore: p0PmBlocks(this.prosemirrorView.state.doc), y: p0YBlocks(this.type), snapshot: syncState.snapshot != null || syncState.prevSnapshot != null })
    if (
      events.length === 0 || syncState.snapshot != null ||
      syncState.prevSnapshot != null
    ) {
      // drop out if snapshot is active
      this.renderSnapshot(syncState.snapshot, syncState.prevSnapshot)
      return
    }
    let p0entered = false
    this.mux(() => {
      p0entered = true"""),
    ("""      if (
        this.beforeTransactionSelection !== null && this._isLocalCursorInView()
      ) {
        tr.scrollIntoView()
      }
      this.prosemirrorView.dispatch(tr)
    })
  }""",
     """      if (
        this.beforeTransactionSelection !== null && this._isLocalCursorInView()
      ) {
        tr.scrollIntoView()
      }
      this.prosemirrorView.dispatch(tr)
      p0('sync.typeChanged.rendered', { pmAfter: p0PmBlocks(this.prosemirrorView.state.doc) })
    })
    if (!p0entered) p0('sync.typeChanged.muxSkipped', { events: events.length, origin: p0Origin(transaction.origin), pm: p0PmBlocks(this.prosemirrorView.state.doc), y: p0YBlocks(this.type), stack: p0Stack() })
  }"""),
    # _prosemirrorChanged
    ("""  _prosemirrorChanged (doc) {
    this.doc.transact(() => {
      updateYFragment(this.doc, this.type, doc, this)
      this.beforeTransactionSelection = getRelativeSelection(
        this,
        this.prosemirrorView.state
      )
    }, ySyncPluginKey)
  }""",
     """  _prosemirrorChanged (doc) {
    const p0before = { pm: p0PmBlocks(doc), y: p0YBlocks(this.type), sameDocAsView: doc === this.prosemirrorView.state.doc, mappingSize: this.mapping.size }
    this.doc.transact(() => {
      updateYFragment(this.doc, this.type, doc, this)
      this.beforeTransactionSelection = getRelativeSelection(
        this,
        this.prosemirrorView.state
      )
    }, ySyncPluginKey)
    p0('sync.prosemirrorChanged', { before: p0before, yAfter: p0YBlocks(this.type) })
  }"""),
    # initView / destroy
    ("""  initView (prosemirrorView) {
    if (this.prosemirrorView != null) this.destroy()
    this.prosemirrorView = prosemirrorView""",
     """  initView (prosemirrorView) {
    p0('sync.initView', { hadView: this.prosemirrorView != null, stack: p0Stack() })
    if (this.prosemirrorView != null) this.destroy()
    this.prosemirrorView = prosemirrorView"""),
    ("""  destroy () {
    if (this.prosemirrorView == null) return
    this.prosemirrorView = null""",
     """  destroy () {
    p0('sync.binding.destroy', { hadView: this.prosemirrorView != null, stack: p0Stack() })
    if (this.prosemirrorView == null) return
    this.prosemirrorView = null"""),
    # createNodeFromYElement catch
    ("""  } catch (e) {
    // an error occured while creating the node. This is probably a result of a concurrent action.
    /** @type {Y.Doc} */ (el.doc).transact((transaction) => {
      /** @type {Y.Item} */ (el._item).delete(transaction)
    }, ySyncPluginKey)
    meta.mapping.delete(el)
    return null
  }""",
     """  } catch (e) {
    p0('sync.createNodeFromYElement.catch', { nodeName: el.nodeName, error: String(e) })
    // an error occured while creating the node. This is probably a result of a concurrent action.
    /** @type {Y.Doc} */ (el.doc).transact((transaction) => {
      /** @type {Y.Item} */ (el._item).delete(transaction)
    }, ySyncPluginKey)
    meta.mapping.delete(el)
    return null
  }"""),
    # createTextNodesFromYText catch
    ("""  } catch (e) {
    // an error occured while creating the node. This is probably a result of a concurrent action.
    /** @type {Y.Doc} */ (text.doc).transact((transaction) => {
      /** @type {Y.Item} */ (text._item).delete(transaction)
    }, ySyncPluginKey)
    return null
  }""",
     """  } catch (e) {
    p0('sync.createTextNodesFromYText.catch', { error: String(e) })
    // an error occured while creating the node. This is probably a result of a concurrent action.
    /** @type {Y.Doc} */ (text.doc).transact((transaction) => {
      /** @type {Y.Item} */ (text._item).delete(transaction)
    }, ySyncPluginKey)
    return null
  }"""),
    # updateYText: the only path that can emit delete-all + insert in one transaction
    ("""  const { insert, remove, index } = simpleDiff(
    str,
    content.map((c) => c.insert).join('')
  )
  ytext.delete(index, remove)""",
     """  const { insert, remove, index } = simpleDiff(
    str,
    content.map((c) => c.insert).join('')
  )
  p0('sync.updateYText', { str, next: content.map((c) => c.insert).join(''), index, remove, insert, stack: p0Stack() })
  ytext.delete(index, remove)"""),
    # updateYFragment: element-level decision
    ("""  meta.mapping.set(yDomFragment, pNode)
  // update attributes
  if (yDomFragment instanceof Y.XmlElement) {
    const yDomAttrs = yDomFragment.getAttributes()
    const pAttrs = pNode.attrs""",
     """  meta.mapping.set(yDomFragment, pNode)
  if (yDomFragment instanceof Y.XmlElement) p0('sync.updateYFragment.el', { node: yDomFragment.nodeName, yAttrs: yDomFragment.getAttributes(), pAttrs: pNode.attrs, pText: pNode.textContent, yText: yDomFragment.toArray().map((c) => (c instanceof Y.XmlText ? p0Text(c) : '<' + c.constructor.name + '>')).join('') })
  // update attributes
  if (yDomFragment instanceof Y.XmlElement) {
    const yDomAttrs = yDomFragment.getAttributes()
    const pAttrs = pNode.attrs"""),
]

# ---------------------------------------------------------------- 2. guarded-binding.ts
GB_EDITS = [
    ("""import { findForeignBlocks } from "./palette.js";
""",
     """import { findForeignBlocks } from "./palette.js";

// ---- Proof 0b instrumentation (throwaway) -------------------------------
type P0Block = { id: string | null; type: string; text: string };
const p0seq = (): number => {
  const g = globalThis as { __p0seq?: number };
  g.__p0seq = (g.__p0seq ?? 0) + 1;
  return g.__p0seq;
};
function p0(step: string, data: Record<string, unknown> = {}): void {
  try {
    console.log(`P0B ${JSON.stringify({ bt: Date.now(), bseq: p0seq(), trace: "binding", step, ...data })}`);
  } catch (error) {
    console.log(`P0B ${JSON.stringify({ trace: "binding", step: "log-failed", error: String(error) })}`);
  }
}
const p0Stack = (): string =>
  (new Error().stack ?? "").split("\\n").slice(2, 14).map((l) => l.trim()).join(" | ");
function p0PmBlocks(doc: { forEach: (f: (n: { attrs: Record<string, unknown>; type: { name: string }; textContent: string }) => void) => void }): P0Block[] {
  const out: P0Block[] = [];
  doc.forEach((n) => out.push({ id: (n.attrs.id as string | null) ?? null, type: n.type.name, text: n.textContent }));
  return out;
}
function p0DomBlocks(dom: Element): P0Block[] {
  const out: P0Block[] = [];
  for (const block of Array.from(dom.children)) {
    const clone = block.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".ProseMirror-yjs-cursor").forEach((c) => c.remove());
    out.push({ id: block.getAttribute("id"), type: block.tagName, text: clone.textContent ?? "" });
  }
  return out;
}
const p0Editors = new Set<Editor>();
(globalThis as { __p0editors?: Set<Editor> }).__p0editors = p0Editors;
(globalThis as { __p0state?: () => unknown }).__p0state = () =>
  Array.from(p0Editors).map((editor) => {
    try {
      const view = editor.view;
      return {
        destroyed: editor.isDestroyed,
        pm: p0PmBlocks(editor.state.doc),
        dom: p0DomBlocks(view.dom),
        domAttached: view.dom.isConnected,
        hasFocus: view.hasFocus(),
        sel: { from: editor.state.selection.from, to: editor.state.selection.to },
        editable: editor.isEditable,
      };
    } catch (error) {
      return { error: String(error) };
    }
  });
type P0LastClick = { time: number; x: number; y: number; type: string } | null;
const p0LastClick = (editor: Editor): P0LastClick =>
  ((editor.view as unknown as { input?: { lastClick?: P0LastClick } }).input?.lastClick ?? null);
function p0Instrument(editor: Editor): void {
  p0Editors.add(editor);
  // ProseMirror classifies a mousedown as single/double/triple by its own
  // `input.lastClick` (<500ms, <10px), not by the event's native `detail`.
  // Capture phase runs before PM's handler (shows the previous click); the
  // bubble listener is registered after PM's and shows this click's verdict.
  editor.view.dom.addEventListener("mousedown", (event) => {
    p0("dom.mousedown.before", { detail: event.detail, x: event.clientX, y: event.clientY, lastClick: p0LastClick(editor), now: Date.now() });
  }, true);
  editor.view.dom.addEventListener("mousedown", (event) => {
    p0("dom.mousedown.after", { detail: event.detail, x: event.clientX, y: event.clientY, lastClick: p0LastClick(editor), sel: { from: editor.state.selection.from, to: editor.state.selection.to } });
  });
  editor.on("transaction", ({ editor: e, transaction }) => {
    const tr = transaction as unknown as { meta: Record<string, unknown>; steps: Array<{ toJSON: () => unknown }>; docChanged: boolean; selectionSet: boolean; getMeta: (k: string) => unknown };
    p0("pm.transaction", {
      docChanged: tr.docChanged,
      selectionSet: tr.selectionSet,
      metaKeys: Object.keys(tr.meta),
      uiEvent: tr.getMeta("uiEvent") ?? null,
      pointer: tr.getMeta("pointer") ?? null,
      lastClick: tr.getMeta("pointer") ? p0LastClick(e) : undefined,
      steps: tr.steps.map((s) => JSON.stringify(s.toJSON()).slice(0, 400)),
      pm: p0PmBlocks(e.state.doc),
      dom: p0DomBlocks(e.view.dom),
      sel: { from: e.state.selection.from, to: e.state.selection.to },
      focus: e.view.hasFocus(),
    });
  });
  editor.on("destroy", () => {
    p0Editors.delete(editor);
    p0("pm.editor.destroy", { stack: p0Stack() });
  });
}
// ---- end instrumentation ------------------------------------------------
"""),
    ("""  if (findForeignBlocks(fragment).length > 0) {
    return { editor: null, refused: true, destroy: () => {} };
  }
""",
     """  if (findForeignBlocks(fragment).length > 0) {
    p0("binding.refused", { stack: p0Stack() });
    return { editor: null, refused: true, destroy: () => {} };
  }
"""),
    ("""    const doomed = instance;
    instance = null;
    doomed.destroy();
    onUnbind?.(fragment);
  };""",
     """    const doomed = instance;
    instance = null;
    p0("binding.guardUnbind", { stack: p0Stack() });
    doomed.destroy();
    onUnbind?.(fragment);
  };"""),
    ("""  instance = createUberblickEditor({ ...rest, fragment });
""",
     """  p0("binding.bind", { editable: rest.editable ?? true, stack: p0Stack() });
  instance = createUberblickEditor({ ...rest, fragment });
  p0Instrument(instance);
"""),
    ("""    destroy: () => {
      ydoc.off("beforeObserverCalls", guard);
      const doomed = instance;
      instance = null;
      doomed?.destroy();
    },""",
     """    destroy: () => {
      p0("binding.destroy", { hadInstance: instance !== null, stack: p0Stack() });
      ydoc.off("beforeObserverCalls", guard);
      const doomed = instance;
      instance = null;
      doomed?.destroy();
    },"""),
]

# ---------------------------------------------------------------- 3. rooms.ts
RO_EDITS = [
    ("""import type { AwarenessUser } from "./identity.js";
""",
     """import type { AwarenessUser } from "./identity.js";

// ---- Proof 0b instrumentation (throwaway) -------------------------------
const p0seq = (): number => {
  const g = globalThis as { __p0seq?: number };
  g.__p0seq = (g.__p0seq ?? 0) + 1;
  return g.__p0seq;
};
function p0(step: string, data: Record<string, unknown> = {}): void {
  try {
    console.log(`P0B ${JSON.stringify({ bt: Date.now(), bseq: p0seq(), trace: "rooms", step, ...data })}`);
  } catch (error) {
    console.log(`P0B ${JSON.stringify({ trace: "rooms", step: "log-failed", error: String(error) })}`);
  }
}
const p0Origin = (o: unknown): string | null =>
  o === null || o === undefined
    ? null
    : typeof o === "object"
      ? ((o as { constructor?: { name?: string } }).constructor?.name ?? "object")
      : String(o);
function p0Update(update: Uint8Array): Record<string, unknown> {
  try {
    const decoded = Y.decodeUpdate(update);
    const structs: Record<string, string[]> = {};
    for (const struct of decoded.structs) {
      const key = String(struct.id.client);
      const content = (struct as { content?: unknown }).content;
      const label =
        content instanceof Y.ContentString
          ? JSON.stringify(content.str)
          : content instanceof Y.ContentType
            ? `<type ${content.type.constructor.name}>`
            : content instanceof Y.ContentFormat
              ? `<format ${content.key}>`
              : content instanceof Y.ContentDeleted
                ? `<deleted ${content.len}>`
                : `<${content?.constructor?.name ?? struct.constructor.name}>`;
      (structs[key] ??= []).push(`${struct.id.clock}:${label}`);
    }
    const deletes: Record<string, string[]> = {};
    decoded.ds.clients.forEach((items, client) => {
      deletes[String(client)] = items.map((item) => `${item.clock}+${item.len}`);
    });
    return { structs, deletes };
  } catch (error) {
    return { decodeError: String(error) };
  }
}
// ---- end instrumentation ------------------------------------------------
"""),
    ("""  created.on("disconnect", () => {
    if (!redialAfterDrop) return;""",
     """  created.on("status", (e: { status: string }) => p0("socket.status", { status: e.status, shouldConnect: created.shouldConnect }));
  created.on("open", () => p0("socket.open"));
  created.on("close", (e: { event?: { code?: number; reason?: string } }) => p0("socket.close", { code: e?.event?.code ?? null, reason: e?.event?.reason ?? null }));
  created.on("disconnect", () => {
    p0("socket.disconnect", { redialAfterDrop });
    if (!redialAfterDrop) return;"""),
    ("""function dropSocket(): void {
  // A page the hub has refused has nothing to repair by reconnecting, and the
  // close that refusal produces would otherwise land here and redial straight
  // back into the same refusal. See {@link protocolMismatch}.
  if (protocolMismatch !== null) return;
  const current = sharedSocket();""",
     """function dropSocket(): void {
  // A page the hub has refused has nothing to repair by reconnecting, and the
  // close that refusal produces would otherwise land here and redial straight
  // back into the same refusal. See {@link protocolMismatch}.
  if (protocolMismatch !== null) return;
  const current = sharedSocket();
  p0("dropSocket", { socketStatus: current.status, sinceLastDrop: Date.now() - lastForcedDrop, windowMs: forcedDropWindowMs, pending: pendingDrop !== null });"""),
    ("""  cancelPendingDrop();
  lastForcedDrop = Date.now();
  forcedDropWindowMs = forcedDropCooldownMs();
  redialAfterDrop = true;
  current.disconnect();
}""",
     """  cancelPendingDrop();
  lastForcedDrop = Date.now();
  forcedDropWindowMs = forcedDropCooldownMs();
  redialAfterDrop = true;
  p0("dropSocket.disconnecting", {});
  current.disconnect();
}"""),
    ("""  provider.on("status", refresh);
  provider.on("unsyncedChanges", refresh);
  provider.on("close", refresh);
""",
     """  provider.on("status", refresh);
  provider.on("unsyncedChanges", refresh);
  provider.on("close", refresh);
  // Proof 0b: every provider/document/awareness event on this room.
  provider.on("status", (e: { status: string }) => p0("provider.status", { room, status: e.status, isSynced: provider.isSynced, isAuthenticated: provider.isAuthenticated }));
  provider.on("close", (e: { event?: { code?: number; reason?: string } }) => p0("provider.close", { room, code: e?.event?.code ?? null, reason: e?.event?.reason ?? null }));
  provider.on("disconnect", () => p0("provider.disconnect", { room }));
  provider.on("open", () => p0("provider.open", { room }));
  provider.on("synced", (e: { state: boolean }) => p0("provider.synced", { room, state: e.state }));
  provider.on("authenticated", () => p0("provider.authenticated", { room }));
  provider.on("authenticationFailed", (e: { reason: string }) => p0("provider.authenticationFailed", { room, reason: e.reason }));
  provider.on("unsyncedChanges", (e: { number: number }) => p0("provider.unsyncedChanges", { room, number: e.number }));
  ydoc.on("update", (update: Uint8Array, origin: unknown, _doc: Y.Doc, tr: Y.Transaction) =>
    p0("y.update", { room, origin: p0Origin(origin), local: tr.local, ...p0Update(update) }));
  provider.awareness?.on("change", (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) =>
    p0("awareness.change", { room, added: change.added, updated: change.updated, removed: change.removed, origin: p0Origin(origin), states: Array.from(provider.awareness?.getStates().entries() ?? []).map(([id, s]) => ({ id, name: (s as { user?: { name?: string } }).user?.name ?? null, cursor: (s as { cursor?: unknown }).cursor != null })) }));
  p0("room.open", { room, clientID: ydoc.clientID, socketStatus: socket.status });
"""),
    ("""      held.persistence?.destroy().catch(() => {});
      held.connection.provider.destroy();
      held.connection.ydoc.destroy();""",
     """      p0("room.release", { room });
      held.persistence?.destroy().catch(() => {});
      held.connection.provider.destroy();
      held.connection.ydoc.destroy();"""),
]

patch(YP, YP_EDITS)
patch(GB, GB_EDITS)
patch(RO, RO_EDITS)
