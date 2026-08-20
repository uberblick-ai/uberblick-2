/**
 * @uberblick/web package entry.
 *
 * This is an app, not a library — the browser entry point is ./main.tsx, loaded
 * by index.html. What is exported here is the editor layer, so tests (and, one
 * day, an embedder) can build the same ProseMirror schema and binding the app
 * uses without pulling in React or a Y.Doc.
 */

export {
  BLOCK_NODE_NAMES,
  MARK_NAMES,
  describeForeignBlocks,
  findForeignBlocks,
} from "./editor/palette.js";
export type { ForeignBlock } from "./editor/palette.js";

export {
  CodeBlock,
  CommentMark,
  Doc,
  Heading,
  Mermaid,
  Paragraph,
  Text,
  paletteExtensions,
  renderableHeadingLevel,
} from "./editor/nodes.js";

export { BlockIds, blockIdPlugin, blockIdPluginKey } from "./editor/block-ids.js";
export type { BlockIdOptions } from "./editor/block-ids.js";

export { Collaboration } from "./editor/collaboration.js";
export type { CollaborationOptions } from "./editor/collaboration.js";

export {
  createUberblickEditor,
  paletteOnlyExtensions,
  uberblickSchema,
} from "./editor/create-editor.js";
export type { CreateEditorOptions } from "./editor/create-editor.js";

export { bindGuardedEditor } from "./editor/guarded-binding.js";
export type {
  GuardedBinding,
  GuardedBindingOptions,
} from "./editor/guarded-binding.js";

export { retypeSelectedBlock, selectedBlock } from "./editor/retype.js";
export type { RetypeAttrs } from "./editor/retype.js";

export { blockText, plainText } from "./editor/ytext.js";

export { mintToken } from "./collab/token.js";
export type { TokenClaims, TokenScope } from "./collab/token.js";

export { AWARENESS_COLORS, randomIdentity } from "./collab/identity.js";
export type { AwarenessUser } from "./collab/identity.js";

export { acquireRoom } from "./collab/rooms.js";
export type { RoomConnection, RoomStatus } from "./collab/rooms.js";

export { HUB_URL, WORKSPACE } from "./config.js";
