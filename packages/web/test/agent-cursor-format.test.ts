/**
 * The awareness cursor format the agent spike publishes, verified against the
 * code that reads it — no network, no hub.
 *
 * This is the contract the MCP server will reuse, so it is pinned here rather
 * than only documented in scripts/agent-cursor-demo.ts.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  createDecorations,
  defaultAwarenessStateFilter,
  defaultCursorBuilder,
  defaultSelectionBuilder,
} from "y-prosemirror";
import { appendBlock, getBlocksFragment, initDoc } from "@uberblick/schema";
import { mountEditor } from "./helpers.js";

function docWithOneBlock(): { ydoc: Y.Doc; blockId: string } {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "cursor-doc", title: "Cursors" });
  const blockId = appendBlock(ydoc, {
    type: "paragraph",
    text: "an agent was here",
  });
  return { ydoc, blockId };
}

/** The Y.XmlText of the first block — what an agent anchors to. */
function firstBlockText(ydoc: Y.Doc): Y.XmlText {
  const first = getBlocksFragment(ydoc).get(0);
  if (!(first instanceof Y.XmlElement)) throw new Error("no first block");
  const text = first.firstChild;
  if (!(text instanceof Y.XmlText)) throw new Error("first block has no text");
  return text;
}

describe("agent awareness cursor format", () => {
  it("is { anchor, head } of relative-position JSON under the `cursor` field", () => {
    const { ydoc } = docWithOneBlock();
    const ytext = firstBlockText(ydoc);
    const position = Y.createRelativePositionFromTypeIndex(ytext, 3);
    const json = Y.relativePositionToJSON(position);

    // The shape a Node process puts on the wire.
    expect(Object.keys(json).sort()).toEqual(["assoc", "item", "type"]);
    expect(json.type).toMatchObject({
      client: expect.any(Number),
      clock: expect.any(Number),
    });

    // Survives the awareness encoding, which is plain JSON.stringify.
    const roundTripped = JSON.parse(JSON.stringify({ anchor: json, head: json }));
    const decoded = Y.createRelativePositionFromJSON(roundTripped.anchor);
    const absolute = Y.createAbsolutePositionFromRelativePosition(decoded, ydoc);
    expect(absolute?.type).toBe(ytext);
    expect(absolute?.index).toBe(3);
  });

  it("encodes identically whether or not relativePositionToJSON is used", () => {
    // y-prosemirror passes the RelativePosition object itself; the demo script
    // calls relativePositionToJSON. Both must land on the same wire bytes.
    const { ydoc } = docWithOneBlock();
    const ytext = firstBlockText(ydoc);
    const position = Y.createRelativePositionFromTypeIndex(ytext, 5);

    const raw = JSON.parse(JSON.stringify(position));
    const explicit = JSON.parse(
      JSON.stringify(Y.relativePositionToJSON(position)),
    );
    // relativePositionToJSON omits null-valued keys; the decoder treats missing
    // and null identically (`json.type == null`).
    expect(explicit).toEqual({ ...raw, tname: undefined, item: raw.item });
    expect(Y.compareRelativePositions(
      Y.createRelativePositionFromJSON(raw),
      Y.createRelativePositionFromJSON(explicit),
    )).toBe(true);
  });

  it("renders a remote caret with a name label from a foreign awareness state", () => {
    const { ydoc } = docWithOneBlock();
    const { editor } = mountEditor(ydoc);
    try {
      const ytext = firstBlockText(ydoc);
      const json = Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(ytext, 3),
      );

      // A second Y.Doc's awareness stands in for the agent process: a different
      // clientID is required, otherwise the plugin filters the state out as
      // "self".
      const agentDoc = new Y.Doc();
      const agentAwareness = new Awareness(agentDoc);
      agentAwareness.setLocalStateField("user", {
        name: "Claude · demo agent",
        color: "#7b5ec7",
      });
      agentAwareness.setLocalStateField("cursor", { anchor: json, head: json });

      // Replay the agent's state into an awareness instance the local editor
      // reads, exactly as the provider would after a network round trip.
      const localAwareness = new Awareness(ydoc);
      const encoded = JSON.parse(
        JSON.stringify(agentAwareness.getLocalState()),
      ) as Record<string, unknown>;
      localAwareness.states.set(agentDoc.clientID, encoded);

      const decorations = createDecorations(
        editor.state,
        localAwareness,
        defaultAwarenessStateFilter,
        defaultCursorBuilder,
        defaultSelectionBuilder,
      );
      // A cursor exists for that client — where it lands is y-prosemirror's
      // business, not this contract's.
      const keys = decorations
        .find()
        .map((decoration: { spec?: { key?: unknown } }) => decoration.spec?.key);
      expect(keys).toContain(String(agentDoc.clientID));

      // The default cursor builder is the DOM the app styles with plain CSS.
      const element = defaultCursorBuilder({
        name: "Claude · demo agent",
        color: "#7b5ec7",
      });
      expect(element.classList.contains("ProseMirror-yjs-cursor")).toBe(true);
      expect(element.textContent).toContain("Claude · demo agent");
    } finally {
      editor.destroy();
    }
  });
});
