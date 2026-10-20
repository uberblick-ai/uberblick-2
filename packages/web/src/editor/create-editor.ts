/**
 * Share this factory with round-trip tests so they exercise the browser schema.
 */

import { Editor, getSchema } from "@tiptap/core";
import type { Extensions } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { seedNewCardParts, seedNewFigmaCaptions, seedNewTableCells } from "@uberblick/schema";
import { BlockIds } from "./block-ids.js";
import type { BlockMenuEntry } from "./block-menu.js";
import { CaretMenuKeys } from "./caret-menu.js";
import { Collaboration } from "./collaboration.js";
import { CommentAnchors } from "./comment-anchors.js";
import { DocLinks } from "./doc-links.js";
import type { DocLinkContext } from "./doc-links.js";
import { ExternalLinks } from "./external-links.js";
import { GitHubLinks } from "./github-links.js";
import { InlineIcons } from "./inline-icons.js";
import { BlockInputRules } from "./input-rules.js";
import { ListBlocks } from "./list-keys.js";
import { ChartBlock, paletteExtensions } from "./nodes.js";
import { ChartBlocks } from "./chart.js";
import { WireframeBlocks } from "./wireframe.js";
import { AblaufBlocks } from "./ablauf.js";
import { CodeHighlighting } from "./syntax-highlighting.js";
import { TableBlocks } from "./table.js";
import { TerminalBlocks } from "./terminal.js";
import { CardBlocks } from "./card.js";
import { FigmaBlocks } from "./figma.js";
import { FigmaCreation } from "./figma-creation.js";

/** The palette without collaboration — the schema, and nothing that needs a Y.Doc. */
export const paletteOnlyExtensions: Extensions = [...paletteExtensions];

/**
 * Share one schema; context-dependent behavior belongs to each editor.
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
   * Per-editor directory and routing context. Null still permits references but
   * leaves them inert because there is no workspace address to navigate.
   */
  docLinks?: DocLinkContext | null;
  /** Shared settings drive presentation without changing the document. */
  workspaceSettings?: Y.Doc | null;
  /** Limit authored block choices and Markdown shortcuts without narrowing the stored schema. */
  blockMenuEntries?: readonly BlockMenuEntry[];
}

export function createUberblickEditor(options: CreateEditorOptions): Editor {
  // Structured nodes construct empty paragraphs without text children. Insert their
  // shared text before observers/transport publish the creating transaction,
  // so replicas' first keystrokes target one existing CRDT type.
  const ydoc = options.fragment.doc;
  const seedCells = (transaction: Y.Transaction): void => {
    if (options.canWrite?.() !== false) {
      seedNewTableCells(transaction);
      seedNewCardParts(transaction);
      seedNewFigmaCaptions(transaction);
    }
  };
  const extensions: Extensions = [
    ...paletteExtensions.map((extension) => extension.name === "chart"
      ? ChartBlock.configure({ ydoc: options.fragment.doc }) : extension),
    BlockIds.configure({
      ...(options.newBlockId === undefined ? {} : { newId: options.newBlockId }),
      ...(options.canWrite === undefined ? {} : { canWrite: options.canWrite }),
    }),
    // Keep behavior outside the shared schema. BlockIds runs before rules so
    // conversions can address the block it identifies.
    options.blockMenuEntries === undefined
      ? BlockInputRules
      : BlockInputRules.configure({ entries: options.blockMenuEntries }),
    // Installed once: reconfiguring plugins on menu mount destroys collaboration
    // views (including its UndoManager). The UI only registers live handlers.
    CaretMenuKeys,
    // Syntax colors are derived decorations, never stored marks.
    CodeHighlighting,
    // List keys fall through outside items; numbering remains a decoration.
    ListBlocks,
    // TableKit supplies cell editing and navigation; the integration limits
    // cell content and keeps the typed and pasted GFM doors.
    TableBlocks,
    CardBlocks,
    FigmaBlocks,
    FigmaCreation,
    // Opening transcript source also pauses its derived playback.
    TerminalBlocks,
    ChartBlocks,
    WireframeBlocks,
    AblaufBlocks,
    // Directory and routing behavior is per editor; the docLink mark is shared schema.
    DocLinks.configure({ context: options.docLinks ?? null }),
    ExternalLinks,
    GitHubLinks.configure({ settings: options.workspaceSettings ?? null }),
    InlineIcons,
    // Read resolved state from annotations rather than duplicating it in marks.
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
    // Omit content: ySync supplies it on the first view update. Reject unknown
    // inserted types so the content parser cannot silently drop them.
    enableContentCheck: true,
    injectCSS: false,
  });
  ydoc?.on("beforeObserverCalls", seedCells);
  editor.on("destroy", () => ydoc?.off("beforeObserverCalls", seedCells));
  return editor;
}
