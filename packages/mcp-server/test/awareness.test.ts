/**
 * The awareness payload an agent puts on the wire.
 *
 * The format is pinned by `packages/web/test/agent-cursor-format.test.ts`,
 * which verifies it against the code that renders it (y-prosemirror's
 * `createDecorations`). This suite pins the same contract from the writing end,
 * so a change here fails next to the code that made it rather than in another
 * package: `user` is `{name, color}`, and `cursor` is `{anchor, head}` of
 * `Y.relativePositionToJSON` output anchored to the block's Y.XmlText.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { blockText } from "../src/replica.js";
import { removeTempDirs, startServer, testConfig, waitUntil } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];

async function rigWith(cursorTtlMs?: number): Promise<Rig> {
  const rig = await startServer(
    testConfig(cursorTtlMs === undefined ? {} : { cursorTtlMs }),
  );
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.close();
  }
});

afterAll(() => {
  removeTempDirs();
});

/** The local awareness state of the replica holding `uuid`. */
function awarenessOf(rig: Rig, uuid: string) {
  const replica = rig.instance.replicas
    .attachedReplicas()
    .find((candidate) => candidate.id === uuid);
  if (replica === undefined) {
    throw new Error(`no replica for ${uuid}`);
  }
  // What the provider serialises: plain JSON, nothing else.
  return {
    replica,
    state: JSON.parse(
      JSON.stringify(replica.awareness.getLocalState()),
    ) as Record<string, any>,
  };
}

describe("agent awareness", () => {
  it("publishes the pinned cursor wire format after an edit", async () => {
    const rig = await rigWith();
    const doc = await rig.ok("create_doc", {
      title: "Cursors",
      blocks: [{ type: "paragraph", text: "an agent" }],
    });
    const block = doc.blocks[0];

    await rig.ok("edit_block", {
      uuid: doc.uuid,
      block_id: block.id,
      old_text: "an agent",
      new_text: "an agent was here",
      rev: block.rev,
    });

    const { replica, state } = awarenessOf(rig, doc.uuid);

    expect(state.user).toEqual({
      name: "Claude · uberblick-tests",
      color: rig.config.color,
    });

    expect(Object.keys(state.cursor).sort()).toEqual(["anchor", "head"]);
    for (const position of [state.cursor.anchor, state.cursor.head]) {
      // `Y.relativePositionToJSON`'s shape: `type` (the anchor type's id) and
      // `assoc` always, `item` only when a character follows the caret. An
      // agent's caret sits at the end of what it just wrote, so `item` is
      // absent here — and the decoder treats missing and null identically.
      expect(Object.keys(position).sort()).toEqual(
        expect.arrayContaining(["assoc", "type"]),
      );
      for (const key of Object.keys(position)) {
        expect(["assoc", "item", "type", "tname"]).toContain(key);
      }
      expect(position.type).toMatchObject({
        client: expect.any(Number),
        clock: expect.any(Number),
      });
    }

    // It decodes to the end of what the agent wrote, in that block's text.
    const text = blockText(replica.doc, block.id);
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(state.cursor.anchor),
      replica.doc,
    );
    expect(absolute?.type).toBe(text);
    expect(absolute?.index).toBe("an agent was here".length);
  });

  it("anchors the cursor in a freshly inserted block", async () => {
    const rig = await rigWith();
    const doc = await rig.ok("create_doc", { title: "Insertions" });
    const inserted = await rig.ok("insert_block", {
      uuid: doc.uuid,
      type: "paragraph",
      text: "brand new",
    });

    const { replica, state } = awarenessOf(rig, doc.uuid);
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(state.cursor.head),
      replica.doc,
    );
    expect(absolute?.type).toBe(blockText(replica.doc, inserted.block.id));
    expect(absolute?.index).toBe("brand new".length);
  });

  it("withdraws the cursor when its TTL expires", async () => {
    const rig = await rigWith(120);
    const doc = await rig.ok("create_doc", {
      title: "Transient",
      blocks: [{ type: "paragraph", text: "here" }],
    });
    await rig.ok("edit_block", {
      uuid: doc.uuid,
      block_id: doc.blocks[0].id,
      old_text: "here",
      new_text: "here and gone",
    });
    expect(awarenessOf(rig, doc.uuid).state.cursor).not.toBeNull();

    await waitUntil(
      "the agent cursor to be withdrawn",
      () => awarenessOf(rig, doc.uuid).state.cursor === null,
    );
    // The identity stays: the agent is still in the room, just not pointing.
    expect(awarenessOf(rig, doc.uuid).state.user).toBeTruthy();
  });
});
