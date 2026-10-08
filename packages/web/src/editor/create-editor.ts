/**
 * Editor construction. One factory, used by the app and by the tests, so the
 * golden round-trip test exercises the same schema the browser does.
 */

import { Editor, getSchema } from "@tiptap/core";
import type { Extensions } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { seedNewTableCells } from "@uberblick/schema";
import { BlockIds } from "./block-ids.js";
import { CaretMenuKeys } from "./caret-menu.js";
import { Collaboration } from "./collaboration.js";
import { CommentAnchors } from "./comment-anchors.js";
import { DocLinks } from "./doc-links.js";
import type { DocLinkContext } from "./doc-links.js";
import { ExternalLinks } from "./external-links.js";
import { BlockInputRules } from "./input-rules.js";
import { ListBlocks } from "./list-keys.js";
import { paletteExtensions } from "./nodes.js";
import { CodeHighlighting } from "./syntax-highlighting.js";
import { TableBlocks } from "./table.js";
import { TerminalBlocks } from "./terminal.js";

/** The palette without collaboration — the schema, and nothing that needs a Y.Doc. */
export const paletteOnlyExtensions: Extensions = [...paletteExtensions];

/**
 * The ProseMirror schema the editor uses. Exported so callers can assert the
 * palette is what they think it is.
 */
export const uberblickSchema: Schema = getSchema(paletteOnlyExtensions);

export interface CreateEditorOptions {
  /** Mount point, or `null` for an unmounted editor. */
  element: Element | null;
  /** The document's `blocks` fragment (`getBlocksFragment(ydoc)`). */
  fragment: Y.XmlFragment;
  /** Provider awareness, for remote cursors. */
  awareness?: Awareness | null;
  editable?: boolean;
  /** Block-id source; injectable for deterministic tests. */
  newBlockId?: () => string;
  /** Gate for editor-side CRDT repairs while the room is not writable. */
  canWrite?: () => boolean;
  /**
   * The workspace half of a document reference — its address, the directory
   * that names it, and where a click goes (`doc-links.ts`). Null in an editor
   * with no workspace behind it: the input and paste rules still make
   * references, and a stored one still renders, but nothing navigates.
   */
  docLinks?: DocLinkContext | null;
}

export function createUberblickEditor(options: CreateEditorOptions): Editor {
  // TableKit constructs empty paragraphs without text children. Insert their
  // shared text before observers/transport publish the creating transaction,
  // so replicas' first keystrokes target one existing CRDT type.
  const ydoc = options.fragment.doc;
  const seedCells = (transaction: Y.Transaction): void => {
    if (options.canWrite?.() !== false) seedNewTableCells(transaction);
  };
  const extensions: Extensions = [
    ...paletteExtensions,
    BlockIds.configure({
      ...(options.newBlockId === undefined ? {} : { newId: options.newBlockId }),
      ...(options.canWrite === undefined ? {} : { canWrite: options.canWrite }),
    }),
    // Behaviour, not schema — which is why the markdown input rules are here
    // and not in `paletteExtensions`: `uberblickSchema` above has to stay the
    // node and mark set alone. After `BlockIds`, because a rule names the block
    // it converts by the id that plugin assigns.
    BlockInputRules,
    // Installed once: reconfiguring plugins on menu mount destroys collaboration
    // views (including its UndoManager). The UI only registers live handlers.
    CaretMenuKeys,
    // Code colouring is derived from source text and its language attribute as
    // inline decorations. It is behaviour, never another stored mark.
    CodeHighlighting,
    // Behaviour too: Tab/Shift-Tab/Enter/Backspace inside a list item — the
    // bindings refuse everywhere else, so the core keymap still owns those keys
    // in every other block — plus the numbers an ordered item is drawn with.
    ListBlocks,
    // TableKit supplies cell editing and navigation; the integration limits
    // cell content and keeps the typed and pasted GFM doors.
    TableBlocks,
    // …and the terminal block's one: the same class, opening a
    // demonstration's transcript under the caret — which is also what stops the
    // demonstration playing while it is being written.
    TerminalBlocks,
    // …and the document reference's: the two typed and pasted spellings, the
    // live anchor, and the address they resolve against. Behaviour again — the
    // mark itself is schema, declared once in `marks.ts`, because
    // `uberblickSchema` above is one object for the whole process.
    DocLinks.configure({ context: options.docLinks ?? null }),
    ExternalLinks,
    // The annotation mark's live half: resolved state sits beside the blocks
    // fragment in the Y.Doc, so a mark view reads it without storing it twice.
    CommentAnchors.configure({ ydoc: options.fragment.doc }),
    Collaboration.configure({
      fragment: options.fragment,
      awareness: options.awareness ?? null,
    }),
  ];

  const editor = new Editor({
    element: options.element,
    extensions,
    editable: options.editable ?? true,
    // No `content`: it comes from Yjs, never from here — ySyncPlugin renders the
    // fragment into ProseMirror on its first view update. Passing
    // `content: undefined` explicitly is not the same thing under
    // exactOptionalPropertyTypes, so the key is simply absent.
    //
    // Make foreign content loud. With this off, Tiptap's content parser drops
    // node types it does not know; with it on, `insertContent` throws instead.
    enableContentCheck: true,
    injectCSS: false,
  });
  ydoc?.on("beforeObserverCalls", seedCells);
  editor.on("destroy", () => ydoc?.off("beforeObserverCalls", seedCells));
  return editor;
}
