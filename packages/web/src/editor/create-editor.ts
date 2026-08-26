/**
 * Editor construction. One factory, used by the app and by the tests, so the
 * golden round-trip test exercises the same schema the browser does.
 */

import { Editor, getSchema } from "@tiptap/core";
import type { Extensions } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { BlockIds } from "./block-ids.js";
import { ChangedBlockMarks } from "./changed-marks.js";
import type { ChangedBlocks } from "./changed-blocks.js";
import { Collaboration } from "./collaboration.js";
import { GitHubHovercards } from "./github-hovercard.js";
import type { GitHubHovercardOptions } from "./github-hovercard.js";
import { GitHubRefs } from "./github-refs.js";
import { BlockInputRules } from "./input-rules.js";
import { ListBlocks } from "./list-keys.js";
import { paletteExtensions } from "./nodes.js";
import { TableBlocks } from "./table.js";
import { AgentTypingTheater } from "./typing-theater.js";
import type { AgentTypingOptions } from "./typing-theater.js";

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
  /**
   * The document's changed-block tracker. Omitted, the editor draws no
   * changed-block marks — which is what an editor with no reader wants.
   */
  changed?: ChangedBlocks;
  /**
   * The injectable parts of the agent typing animation — the motion
   * preference, the jitter source and the clock — so a test can make playback
   * deterministic. All default to the real thing.
   */
  typing?: Partial<
    Pick<AgentTypingOptions, "reducedMotion" | "random" | "now">
  >;
  /**
   * The GitHub hovercard's hover-intent delay, so a test need not wait it out.
   * Defaults to the real one.
   */
  hovercard?: Partial<GitHubHovercardOptions>;
}

export function createUberblickEditor(options: CreateEditorOptions): Editor {
  const extensions: Extensions = [
    ...paletteExtensions,
    BlockIds.configure(
      options.newBlockId === undefined ? {} : { newId: options.newBlockId },
    ),
    // Behaviour, not schema — which is why the markdown input rules are here
    // and not in `paletteExtensions`: `uberblickSchema` above has to stay the
    // node and mark set alone. After `BlockIds`, because a rule names the block
    // it converts by the id that plugin assigns.
    BlockInputRules,
    // Behaviour too: Tab/Shift-Tab/Enter/Backspace inside a list item — the
    // bindings refuse everywhere else, so the core keymap still owns those keys
    // in every other block — plus the numbers an ordered item is drawn with.
    ListBlocks,
    // …and the table block's own two: the class that opens a table's source
    // under the caret, and the typed and pasted doors a table comes in through.
    TableBlocks,
    Collaboration.configure({
      fragment: options.fragment,
      awareness: options.awareness ?? null,
    }),
    // Presentation over state that is already true, like the two below it: the
    // stored text of a pasted GitHub link stays the full URL.
    GitHubRefs,
    // Reads the same references the decoration draws, and nothing else: the
    // card is fetched on hover, shown in a portal, and never touches the
    // document (#175).
    GitHubHovercards.configure(options.hovercard ?? {}),
    ChangedBlockMarks.configure({ marks: options.changed ?? null }),
    // After the changed-block marker, and reading the same tracker: the gutter
    // line says *that* a block changed the moment it does, whatever the
    // animation's queue is doing about showing *what* changed (#121).
    AgentTypingTheater.configure({
      marks: options.changed ?? null,
      ...(options.typing ?? {}),
    }),
  ];

  return new Editor({
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
}
