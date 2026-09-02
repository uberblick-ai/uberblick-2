/**
 * Proof 0: replay one room's update log from a MirrorStore database.
 *
 *   tsx spike/proof0-replay.ts <database> <room> [--json]
 *
 * Applies the room's snapshot (if any) and then every `updates` row in seq
 * order to a fresh Y.Doc, printing the block list after each step and naming
 * the update that removed any element that existed before it.
 */

import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import { describeUpdate, rawBlocks } from "../src/proof0-trace.js";
import type { RawBlock } from "../src/proof0-trace.js";

const [databasePath, room, ...flags] = process.argv.slice(2);
if (!databasePath || !room) {
  process.stderr.write("usage: proof0-replay <database> <room> [--json]\n");
  process.exit(2);
}
const asJson = flags.includes("--json");

const database = new DatabaseSync(databasePath, { readOnly: true });
const snapshot = database
  .prepare("SELECT state, through_seq FROM snapshots WHERE room = ?")
  .get(room) as { state: Uint8Array; through_seq: number } | undefined;
const updates = database
  .prepare(
    "SELECT seq, payload, origin, logged_at FROM updates WHERE room = ? ORDER BY seq",
  )
  .all(room) as { seq: number; payload: Uint8Array; origin: string; logged_at: number }[];
const pending = database
  .prepare("SELECT room, seq FROM pending_rooms WHERE room = ?")
  .all(room) as { room: string; seq: number }[];

const doc = new Y.Doc();
const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const fmt = (blocks: RawBlock[]): string =>
  blocks
    .map((block) => `[${block.index}] id=${block.id ?? "∅"} item=${block.item ?? "∅"} ${block.type} ${JSON.stringify(block.text)}`)
    .join(" | ");

out(`room ${room}`);
out(`snapshot: ${snapshot ? `through_seq=${snapshot.through_seq}, ${snapshot.state.byteLength} bytes` : "none"}`);
out(`updates: ${updates.length} rows; pending_rooms: ${JSON.stringify(pending)}`);
if (snapshot) {
  Y.applyUpdate(doc, snapshot.state);
  out(`after snapshot: ${fmt(rawBlocks(doc))}`);
}

const structTotals = new Map<string, number>();
let previous = rawBlocks(doc);
for (const update of updates) {
  const summary = describeUpdate(update.payload);
  for (const [client, entry] of Object.entries(summary.structs)) {
    structTotals.set(client, (structTotals.get(client) ?? 0) + entry.count);
  }
  Y.applyUpdate(doc, update.payload);
  const current = rawBlocks(doc);
  const before = new Map(previous.map((block) => [block.item, block]));
  const after = new Map(current.map((block) => [block.item, block]));
  const removed = previous.filter((block) => !after.has(block.item));
  const added = current.filter((block) => !before.has(block.item));
  const when = new Date(update.logged_at).toISOString();
  if (asJson) {
    out(
      JSON.stringify({
        seq: update.seq,
        origin: update.origin,
        loggedAt: when,
        update: summary,
        removed,
        added,
        blocks: current,
      }),
    );
  } else {
    const structs = Object.entries(summary.structs)
      .map(([client, entry]) => `${client}×${entry.count}${entry.strings.length ? `(${entry.strings.map((s) => JSON.stringify(s)).join(",")})` : ""}`)
      .join(" ");
    const deletes = Object.entries(summary.deletes)
      .map(([client, ranges]) => `${client}:${ranges.map(([clock, len]) => `${clock}+${len}`).join(",")}`)
      .join(" ");
    out(
      `seq=${update.seq} origin=${update.origin} at=${when} bytes=${summary.bytes} structs={${structs}} deletes={${deletes}}`,
    );
    for (const block of removed) {
      const coveringClient = Object.entries(summary.deletes).find(([client, ranges]) => {
        const [itemClient, itemClock] = (block.item ?? ":").split(":").map(Number);
        return (
          Number(client) === itemClient &&
          ranges.some(([clock, len]) => itemClock >= clock && itemClock < clock + len)
        );
      });
      out(
        `   *** REMOVED element id=${block.id} item=${block.item} text=${JSON.stringify(block.text)} by seq=${update.seq} origin=${update.origin}; delete-set covers it: ${coveringClient ? "yes" : "no"}; update carries structs from: ${Object.keys(summary.structs).join(",") || "none (pure delete)"}`,
      );
    }
    for (const block of added) {
      out(`   +++ ADDED element id=${block.id} item=${block.item} (created by client ${(block.item ?? "?").split(":")[0]}) text=${JSON.stringify(block.text)}`);
    }
    out(`   blocks: ${fmt(current)}`);
  }
  previous = current;
}

out(`final: ${fmt(rawBlocks(doc))}`);
out(`struct totals by creating client: ${JSON.stringify(Object.fromEntries(structTotals))}`);
const ids = new Map<string, number>();
for (const block of rawBlocks(doc)) ids.set(block.id ?? "∅", (ids.get(block.id ?? "∅") ?? 0) + 1);
const duplicates = [...ids.entries()].filter(([, count]) => count > 1);
out(`duplicate ids in final state: ${duplicates.length ? JSON.stringify(duplicates) : "none"}`);
