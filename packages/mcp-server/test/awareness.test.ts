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
import { agentDisplayName } from "../src/server.js";
import { removeTempDirs, startServer, testConfig, waitUntil } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];

interface RigOptions {
  cursorTtlMs?: number;
  /** What the MCP client calls itself at `initialize`. */
  clientInfo?: { name: string; title?: string; version: string };
}

async function rigWith(options: RigOptions = {}): Promise<Rig> {
  const { cursorTtlMs, clientInfo } = options;
  const rig = await startServer(
    testConfig(cursorTtlMs === undefined ? {} : { cursorTtlMs }),
    undefined,
    clientInfo,
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
      description: "A test document.",
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

    // The identity is whatever the connected MCP client called itself at
    // `initialize` — not a hardcoded vendor, which would misattribute every
    // other client that speaks MCP.
    expect(state.user).toEqual({
      name: rig.clientName,
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

    // An insert anchors the same way, in the block it just created — a block
    // that did not exist when the previous cursor was published.
    const inserted = await rig.ok("insert_block", {
      uuid: doc.uuid,
      type: "paragraph",
      text: "brand new",
    });
    const afterInsert = awarenessOf(rig, doc.uuid);
    const head = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(afterInsert.state.cursor.head),
      afterInsert.replica.doc,
    );
    expect(head?.type).toBe(
      blockText(afterInsert.replica.doc, inserted.block.id),
    );
    expect(head?.index).toBe("brand new".length);
  });

  // Who wrote is half of what a caret says, and the web editor renders whatever
  // is in `user.name` verbatim (#304). These pin the resolution and the wiring;
  // the wiring is what a `??` chain would get subtly wrong, because an empty
  // title is a value.
  it("names the caret after the session title, the client, then `agent`", () => {
    expect(
      agentDisplayName({ name: "Codex", title: "Uberblick Coordinator Agent" }),
    ).toBe("Uberblick Coordinator Agent");
    expect(agentDisplayName({ name: "Codex" })).toBe("Codex");
    // Blank is not an answer: falling through is what keeps the caret labelled.
    expect(agentDisplayName({ name: "Codex", title: "" })).toBe("Codex");
    expect(agentDisplayName({ name: "Codex", title: "   " })).toBe("Codex");
    expect(agentDisplayName({ name: " Codex " })).toBe("Codex");
    expect(agentDisplayName({ name: " ", title: " " })).toBe("agent");
    expect(agentDisplayName(undefined)).toBe("agent");
  });

  it("publishes the session title as the awareness name, with the cursor", async () => {
    const rig = await rigWith({
      clientInfo: {
        name: "Codex",
        title: "Uberblick Coordinator Agent",
        version: "0.0.0",
      },
    });
    const doc = await rig.ok("create_doc", {
      title: "Attribution",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "who" }],
    });
    await rig.ok("edit_block", {
      uuid: doc.uuid,
      block_id: doc.blocks[0].id,
      old_text: "who",
      new_text: "who wrote this",
    });

    const { state } = awarenessOf(rig, doc.uuid);
    // Atomic: a caret is on the wire and it carries a name and a colour, so a
    // reader never sees an anonymous line.
    expect(state.user).toEqual({
      name: "Uberblick Coordinator Agent",
      color: rig.config.color,
    });
    expect(state.cursor).not.toBeNull();
  });

  it("withdraws the cursor when its TTL expires", async () => {
    const rig = await rigWith({ cursorTtlMs: 120 });
    const doc = await rig.ok("create_doc", {
      title: "Transient",
      description: "A test document.",
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
