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

import { DIRECTORY_SUFFIX } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { AGENT_CLIENT, blockText } from "../src/replica.js";
import { agentDisplayName } from "../src/server.js";
import {
  removeTempDirs,
  sleep,
  startServer,
  testConfig,
  waitUntil,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];

interface RigOptions {
  cursorTtlMs?: number;
  /** An existing log to boot over, so a second server holds another's rooms. */
  databasePath?: string;
  /** What the MCP client calls itself at `initialize`. */
  clientInfo?: { name: string; title?: string; version: string };
}

async function rigWith(options: RigOptions = {}): Promise<Rig> {
  const { cursorTtlMs, databasePath, clientInfo } = options;
  const rig = await startServer(
    testConfig({
      ...(cursorTtlMs === undefined ? {} : { cursorTtlMs }),
      ...(databasePath === undefined ? {} : { databasePath }),
    }),
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

/** The attached replica for a room id — a document uuid, or `_directory`. */
function replicaOf(rig: Rig, id: string) {
  const replica = rig.instance.replicas
    .attachedReplicas()
    .find((candidate) => candidate.id === id);
  if (replica === undefined) {
    throw new Error(`no replica for ${id}`);
  }
  return replica;
}

/** Whether a room is attached at all — attaching and publishing are separate. */
function isAttached(rig: Rig, id: string): boolean {
  return rig.instance.replicas
    .attachedReplicas()
    .some((candidate) => candidate.id === id);
}

/**
 * What a remote observer decodes from a room's local awareness state.
 *
 * The JSON round trip is the point: it is what the provider puts on the wire,
 * so a key held locally as `undefined` is absent here exactly as it is there.
 * `null` where the room publishes nothing at all.
 */
function publishedState(rig: Rig, id: string): Record<string, any> | null {
  return JSON.parse(
    JSON.stringify(replicaOf(rig, id).awareness.getLocalState() ?? null),
  );
}

/** The local awareness state of the replica holding `uuid`. */
function awarenessOf(rig: Rig, uuid: string) {
  return {
    replica: replicaOf(rig, uuid),
    state: (publishedState(rig, uuid) ?? {}) as Record<string, any>,
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

    // And it anchors after what was WRITTEN, which is not `text` when `inline`
    // replaced it: the caret would otherwise sit at 0 for every formatted
    // block an agent inserts.
    const formatted = await rig.ok("insert_block", {
      uuid: doc.uuid,
      type: "paragraph",
      inline: [
        { text: "a formatted ", marks: {} },
        { text: "insert", marks: { bold: true } },
      ],
    });
    const afterFormatted = awarenessOf(rig, doc.uuid);
    expect(
      Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(afterFormatted.state.cursor.head),
        afterFormatted.replica.doc,
      )?.index,
    ).toBe("a formatted insert".length);
    expect(formatted.block.text).toBe("a formatted insert");
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

    // Every state this room puts on the wire from here on. The two withdrawals
    // land in the same millisecond, so what a peer sees between them is not
    // observable by reading the state afterwards — only by watching each update
    // as it is published.
    const published: Array<Record<string, unknown>> = [];
    const awareness = replicaOf(rig, doc.uuid).awareness;
    const record = (): void => {
      published.push(
        JSON.parse(JSON.stringify(awareness.getLocalState() ?? {})) as Record<
          string,
          unknown
        >,
      );
    };
    awareness.on("update", record);

    await waitUntil(
      "the agent cursor to be withdrawn",
      () => awarenessOf(rig, doc.uuid).state.cursor === null,
    );
    await waitUntil(
      "the agent's presence to be withdrawn",
      () => awarenessOf(rig, doc.uuid).state.user === undefined,
    );
    awareness.off("update", record);

    // The identity goes with the caret, never before it: presence in a document
    // means "this session is working here", and the write that drew this caret
    // is the touch the presence clock is counting from too (#493). Both timers
    // run for the same TTL, so the only thing keeping the presence alive at
    // least as long as the caret is that `publishCursor` arms the cursor's timer
    // *before* it re-arms presence — an anonymous caret is the one order that
    // must not happen (#304), and nothing else in this suite fails if that
    // ordering is inverted.
    expect(published.length).toBeGreaterThan(0);
    const anonymous = published.filter(
      (state) => state.cursor != null && state.user === undefined,
    );
    expect(anonymous).toEqual([]);
  });

  /**
   * Presence in a document says "this session is working here" (#493).
   *
   * The server attaches a replica for every live document in the directory, so
   * publishing on attach made one agent a peer bubble in every document at
   * once. These pin the two halves of the fix on a *second* server booted from
   * the first one's log — the shape that produced the bug, since that is how a
   * server comes to hold rooms nobody asked it about.
   */
  describe("document presence follows the work, not the connection", () => {
    /** A server that boots holding every document another one wrote. */
    async function secondServerOver(cursorTtlMs?: number) {
      const first = await rigWith();
      const doc = await first.ok("create_doc", {
        title: "Shared",
        description: "A test document.",
        blocks: [{ type: "paragraph", text: "written elsewhere" }],
      });
      await first.close();
      rigs.splice(rigs.indexOf(first), 1);

      const second = await rigWith({
        ...(cursorTtlMs === undefined ? {} : { cursorTtlMs }),
        databasePath: first.config.databasePath,
      });
      return { rig: second, uuid: doc.uuid };
    }

    it("publishes nothing in a room it merely attached", async () => {
      const { rig, uuid } = await secondServerOver();

      // The three tools that answer from the derived index or the directory
      // stub. Each settles first, and settling is what attaches the room — so
      // the room is here, with its existing answers, and nobody is in it.
      expect((await rig.ok("list_docs")).docs).toContainEqual(
        expect.objectContaining({ uuid, title: "Shared" }),
      );
      expect((await rig.ok("search", { query: "elsewhere" })).hits).toContainEqual(
        expect.objectContaining({ uuid }),
      );
      expect((await rig.ok("backlinks", { uuid })).backlinks).toEqual([]);

      expect(isAttached(rig, uuid)).toBe(true);
      expect(publishedState(rig, uuid)).toBeNull();
      // Workspace-level presence is what the user menu's "MCP connections"
      // count reads, and it is unaffected: every session joins the directory.
      expect(publishedState(rig, DIRECTORY_SUFFIX)?.user).toEqual({
        name: rig.clientName,
        color: rig.config.color,
      });
    });

    it("publishes on a read, keeps it alive, then withdraws the key", async () => {
      // 500 ms leaves each touch 150 ms of slack inside the TTL on a loaded machine.
      const ttl = 500;
      const { rig, uuid } = await secondServerOver(ttl);

      await rig.ok("get_doc", { uuid });
      const touched = awarenessOf(rig, uuid).state;
      expect(touched.user).toEqual({
        name: rig.clientName,
        color: rig.config.color,
      });
      // A read publishes presence and draws no caret: the clocks are separate.
      expect(touched.cursor).toBeUndefined();

      // A fresh touch supersedes the pending withdrawal rather than queueing a
      // second one: at 1.4 × ttl the first deadline has passed and the second
      // has not, so a session still working keeps its bubble.
      await sleep(ttl * 0.7);
      await rig.ok("get_doc", { uuid });
      await sleep(ttl * 0.7);
      expect(awarenessOf(rig, uuid).state.user).toBeTruthy();

      await waitUntil(
        "the agent's presence to be withdrawn",
        () => awarenessOf(rig, uuid).state.user === undefined,
      );
      // Absent, never `user: null` — all three web readers test for absence, so
      // a null would still count as a session. And the state itself stays:
      // dropping it would never reach a peer, leaving every one of them holding
      // this session's last presence — `Replicas.touch` has the mechanism.
      const withdrawn = publishedState(rig, uuid);
      expect(withdrawn).not.toBeNull();
      expect(withdrawn).not.toHaveProperty("user");
      expect(publishedState(rig, DIRECTORY_SUFFIX)?.user).toBeTruthy();
    });
  });

  /**
   * The positive marker and the session id (#494).
   *
   * They are what the web classifies and labels a session by, so what matters
   * is not that they are published but that they are published *with* the
   * presence they describe and withdrawn with it. A marker outliving its `user`
   * would keep counting a session that stopped working here.
   */
  describe("the marker and the session id are part of the presence", () => {
    it("rides beside `user` wherever presence is published", async () => {
      const rig = await rigWith();
      const doc = await rig.ok("create_doc", {
        title: "Marked",
        description: "A test document.",
        blocks: [{ type: "paragraph", text: "who is this" }],
      });

      // A document room: presence published because a tool touched it.
      expect(awarenessOf(rig, doc.uuid).state).toMatchObject({
        user: { name: rig.clientName, color: rig.config.color },
        client: AGENT_CLIENT,
        session: rig.config.sessionId,
      });
      // The id is the one `sync_status` reports, so a hover in the web client
      // and a tool's own answer name the same session.
      expect((await rig.ok("sync_status")).session).toBe(rig.config.sessionId);

      // And the workspace room, where presence starts at attach — this is what
      // the user menu's "MCP connections" count reads.
      expect(publishedState(rig, DIRECTORY_SUFFIX)).toMatchObject({
        client: AGENT_CLIENT,
        session: rig.config.sessionId,
      });
    });

    it("is absent wherever the presence is", async () => {
      const ttl = 120;
      const first = await rigWith();
      const doc = await first.ok("create_doc", {
        title: "Passive",
        description: "A test document.",
        blocks: [{ type: "paragraph", text: "written elsewhere" }],
      });
      await first.close();
      rigs.splice(rigs.indexOf(first), 1);

      // A second server booted over the first one's log holds the room without
      // ever having worked in it.
      const rig = await rigWith({ cursorTtlMs: ttl, databasePath: first.config.databasePath });
      await rig.ok("list_docs");
      expect(publishedState(rig, doc.uuid)).toBeNull();

      // Touch it, then let the presence expire: the marker and the id go with
      // the `user`, in one write. The state itself survives, because dropping
      // it would never reach a peer — see `Replicas.touch`.
      await rig.ok("get_doc", { uuid: doc.uuid });
      expect(awarenessOf(rig, doc.uuid).state.client).toBe(AGENT_CLIENT);
      await waitUntil(
        "the agent's presence to be withdrawn",
        () => awarenessOf(rig, doc.uuid).state.user === undefined,
      );
      const withdrawn = publishedState(rig, doc.uuid);
      expect(withdrawn).not.toBeNull();
      expect(withdrawn).not.toHaveProperty("client");
      expect(withdrawn).not.toHaveProperty("session");
    });
  });
});
