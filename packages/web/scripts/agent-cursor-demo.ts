/**
 * Agent-cursor compatibility spike.
 *
 * A Node process joins a document's room, publishes awareness, and parks a
 * cursor inside the first block — using exactly the encoding `yCursorPlugin`
 * reads, so it renders in the web editor with a name label like any human peer.
 * The MCP server will reuse this format for agent attribution.
 *
 * Entry point: `mise run agent-cursor`. It takes an optional `<docUuid>`
 * (`mise run agent-cursor -- <docUuid>`); with no uuid the script picks the
 * first entry from the directory doc. HUB_AUTH_TOKEN has to come from
 * `fnox exec`, which the task wraps.
 *
 * ============================================================================
 * THE AWARENESS CURSOR FORMAT — read out of y-prosemirror 1.3.7, not guessed
 * ============================================================================
 *
 * Source: node_modules/y-prosemirror/src/plugins/cursor-plugin.js
 *
 * Field name
 *   `cursor`, at the top level of the awareness state. It is the default value
 *   of `yCursorPlugin`'s third parameter, `cursorStateField = 'cursor'`. The
 *   accompanying identity lives in the sibling field `user`, read as
 *   `{ name, color }`; `color` MUST match /^#[0-9a-fA-F]{6}$/ (the plugin warns
 *   and keeps going otherwise) and both fields have fallbacks
 *   (`#ffa500`, `User: <clientId>`).
 *
 * Value
 *   `{ anchor, head }` — two Yjs *relative positions* in JSON form. A caret is
 *   anchor === head; anchor !== head draws a selection highlight as well.
 *   Setting `cursor` to `null` removes the remote cursor (that is what the
 *   plugin does on blur and on destroy).
 *
 * Encoding — the part worth being precise about
 *   The read side is `Y.createRelativePositionFromJSON(aw.cursor.anchor)`, so
 *   each endpoint is the JSON form of a RelativePosition:
 *
 *       { type?: {client, clock}, tname?: string, item?: {client, clock}, assoc: number }
 *
 *   Two ways to produce it, and both are wire-identical:
 *     - `Y.relativePositionToJSON(rpos)` — the explicit conversion, used here.
 *     - passing the `Y.RelativePosition` object itself, which is what
 *       y-prosemirror does. `RelativePosition` has no `toJSON` method, and
 *       awareness states are serialised with `JSON.stringify`
 *       (y-protocols/awareness.js), so its plain fields are what goes on the
 *       wire — the same object shape, minus the null-valued keys that
 *       `relativePositionToJSON` omits. `createRelativePositionFromJSON`
 *       treats missing and null identically (`json.type == null`).
 *
 *   The relative position is built with
 *   `Y.createRelativePositionFromTypeIndex(type, index)` where `type` is the
 *   Y.XmlText **inside a block element** and `index` is a character offset in
 *   that text. NOT `absolutePositionToRelativePosition` — that one needs
 *   y-prosemirror's live node↔nodeSize mapping, which only exists inside a
 *   bound editor. A Node process has no mapping and does not need one: the
 *   reader resolves the position back through its own mapping, and its only
 *   requirement (`relativePositionToAbsolutePosition` in y-prosemirror/lib.js)
 *   is that the resolved type is the bound fragment or a descendant of it —
 *   which a block's Y.XmlText is.
 *
 * Consequences for the MCP server
 *   - Anchor to the block's Y.XmlText, never to the `blocks` fragment: a
 *     position on the fragment resolves, but positions inside text are what
 *     survive concurrent edits meaningfully.
 *   - Re-publish after edits if you want the caret to follow; a relative
 *     position is stable across other clients' edits on its own, so
 *     re-publishing is about *moving*, not about staying valid.
 *   - Awareness is ephemeral. It needs a live connection, and it disappears
 *     when the process exits — which is the desired behaviour for a session.
 * ============================================================================
 */

import { HocuspocusProvider } from "@hocuspocus/provider";
import { wrapToken } from "@uberblick/hub/protocol";
import * as Y from "yjs";
import {
  directoryRoom,
  getBlocksFragment,
  listDirectory,
  parseWorkspaceId,
  roomForDoc,
} from "@uberblick/schema";
import {
  MAX_TOKEN_LIFETIME_SECONDS,
  importRootSecret,
  mintToken,
} from "../src/collab/token.js";

const HUB_URL = process.env.HUB_URL ?? "ws://localhost:1234";
const HUB_AUTH_TOKEN = process.env.HUB_AUTH_TOKEN ?? "";
/**
 * The workspace to park a cursor in. Required: there is no default workspace,
 * and a demo that guessed one would connect to a corpus nobody chose. `mise run
 * agent-cursor` inherits it from the same mise `[env]` every other task reads.
 */
const WORKSPACE = ((): string => {
  const configured = process.env.WORKSPACE_ID?.trim();
  if (configured === undefined || configured === "") {
    console.error(
      "agent-cursor: WORKSPACE_ID is not set — run `ub init`, or `ub status` " +
        "to see the workspace in force",
    );
    process.exit(1);
  }
  // Decorated or bare, only the uuid names a room or signs a claim.
  return parseWorkspaceId(configured).uuid;
})();

const AGENT_NAME = "Claude · demo agent";
/** 6-digit hex only — y-prosemirror rejects every other colour notation. */
const AGENT_COLOR = "#7b5ec7";

const STEP_MS = 2000;
const WALK_LENGTH = 12;

let signingKey: Promise<CryptoKey> | null = null;

async function token(): Promise<string> {
  signingKey ??= importRootSecret(HUB_AUTH_TOKEN);
  // Wrapped like every real client: a bare token is refused as a protocol
  // mismatch, which is exactly what a not-yet-updated client looks like.
  return wrapToken(
    await mintToken(await signingKey, {
      typ: "room",
      sub: AGENT_NAME,
      workspace: WORKSPACE,
      scope: "read-write",
      kid: null,
      lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    }),
  );
}

function connect(room: string): { provider: HocuspocusProvider; ydoc: Y.Doc } {
  const ydoc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: HUB_URL,
    name: room,
    document: ydoc,
    token,
  });
  return { provider, ydoc };
}

function whenSynced(provider: HocuspocusProvider): Promise<void> {
  if (provider.isSynced) return Promise.resolve();
  return new Promise((resolve) => {
    provider.on("synced", () => resolve());
  });
}

/** The first block's Y.XmlText, waiting for it to show up if the doc is empty. */
async function firstBlockText(ydoc: Y.Doc): Promise<Y.XmlText> {
  const fragment = getBlocksFragment(ydoc);
  const read = (): Y.XmlText | null => {
    const first = fragment.get(0);
    if (!(first instanceof Y.XmlElement)) return null;
    const text = first.firstChild;
    return text instanceof Y.XmlText ? text : null;
  };
  const immediate = read();
  if (immediate !== null) return immediate;
  return new Promise((resolve) => {
    const listener = (): void => {
      const found = read();
      if (found === null) return;
      fragment.unobserveDeep(listener);
      resolve(found);
    };
    fragment.observeDeep(listener);
  });
}

async function resolveUuid(argv: string[]): Promise<string> {
  const explicit = argv[2];
  if (explicit !== undefined && explicit !== "") return explicit;

  const { provider, ydoc } = connect(directoryRoom(WORKSPACE));
  await whenSynced(provider);
  const entries = listDirectory(ydoc);
  provider.destroy();
  const first = entries[0];
  if (first === undefined) {
    throw new Error(
      "no documents in the directory — create one in the web UI first, or pass a uuid",
    );
  }
  return first.uuid;
}

async function main(): Promise<void> {
  if (HUB_AUTH_TOKEN === "") {
    throw new Error(
      "HUB_AUTH_TOKEN is unset — run this under `fnox exec` (see mise.toml)",
    );
  }

  const uuid = await resolveUuid(process.argv);
  const room = roomForDoc(WORKSPACE, uuid);
  const { provider, ydoc } = connect(room);

  const awareness = provider.awareness;
  if (awareness === null) throw new Error("provider has no awareness");

  // Identity first, so the cursor has a label the moment it appears.
  awareness.setLocalStateField("user", { name: AGENT_NAME, color: AGENT_COLOR });

  await whenSynced(provider);
  const ytext = await firstBlockText(ydoc);
  process.stderr.write(
    `agent-cursor-demo: ${room} — walking a caret through the first block\n`,
  );

  let step = 0;
  const publish = (): void => {
    const limit = Math.min(ytext.length, WALK_LENGTH);
    const index = limit === 0 ? 0 : step % (limit + 1);
    const position = Y.createRelativePositionFromTypeIndex(ytext, index);
    const json = Y.relativePositionToJSON(position);
    // THE format: awareness field `cursor` = { anchor, head }, each the JSON
    // form of a Y.RelativePosition. Caret when anchor === head.
    awareness.setLocalStateField("cursor", { anchor: json, head: json });
    process.stderr.write(
      `  cursor -> index ${index} of ${ytext.length}: ${JSON.stringify(json)}\n`,
    );
    step += 1;
  };

  publish();
  const timer = setInterval(publish, STEP_MS);

  const shutdown = (): void => {
    clearInterval(timer);
    // Clearing the field removes the remote caret immediately, rather than
    // waiting for the awareness timeout.
    awareness.setLocalStateField("cursor", null);
    provider.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`agent-cursor-demo failed: ${String(error)}\n`);
  process.exit(1);
});
