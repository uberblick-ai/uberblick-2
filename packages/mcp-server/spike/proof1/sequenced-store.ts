/**
 * Proof 1, case 3 — a prototype of v3 §5.2's `indexed_through_seq`.
 *
 * Today `MirrorStore.indexDoc` is a wholesale replace with no notion of which
 * log cut the rows were derived from, so a slow indexer can commit an older
 * derivation over a newer one. This wraps it: the derivation's cut is captured
 * when the write is *offered* (before any delay), and the rows and the cut are
 * written in ONE transaction that refuses to go backwards.
 *
 * Two things make this a prototype and not a patch:
 *  - it reaches the store's private `DatabaseSync` handle, because the gate and
 *    the row writes must share one transaction and `super.indexDoc` opens its
 *    own;
 *  - it restates the store's index SQL rather than sharing it.
 * Neither changes what is being measured: the same statements, plus one indexed
 * SELECT and one upsert, inside the same single transaction.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Replicas } from "../../src/replica.js";
import type { IndexedDoc, UpdateOrigin } from "../../src/store.js";
import { TimedStore, blockingSleep, now } from "./common.js";

const SEQ_SCHEMA = `
CREATE TABLE IF NOT EXISTS doc_index_seq (
  uuid TEXT PRIMARY KEY,
  seq  INTEGER NOT NULL
);
`;

export class SequencedStore extends TimedStore {
  /** Set once the engine exists, so a derivation can be dated by its replica. */
  replicas: Replicas | null = null;

  skipped = 0;

  written = 0;

  /** Milliseconds spent inside the gated index write, per call. */
  readonly gatedMs: number[] = [];

  private gatePrepared: {
    readSeq: ReturnType<DatabaseSync["prepare"]>;
    putSeq: ReturnType<DatabaseSync["prepare"]>;
    putDoc: ReturnType<DatabaseSync["prepare"]>;
    dropTags: ReturnType<DatabaseSync["prepare"]>;
    putTag: ReturnType<DatabaseSync["prepare"]>;
    dropLinks: ReturnType<DatabaseSync["prepare"]>;
    putLink: ReturnType<DatabaseSync["prepare"]>;
    dropFts: ReturnType<DatabaseSync["prepare"]>;
    putFts: ReturnType<DatabaseSync["prepare"]>;
  } | null = null;

  private handle(): DatabaseSync {
    return (this as unknown as { db: DatabaseSync }).db;
  }

  // NOT `statements`: MirrorStore assigns an own property of that name in its
  // constructor, which would shadow a method here.
  private gate(): NonNullable<SequencedStore["gatePrepared"]> {
    if (this.gatePrepared !== null) return this.gatePrepared;
    const db = this.handle();
    db.exec(SEQ_SCHEMA);
    this.gatePrepared = {
      readSeq: db.prepare("SELECT seq FROM doc_index_seq WHERE uuid = ?"),
      putSeq: db.prepare(
        "INSERT INTO doc_index_seq (uuid, seq) VALUES (?, ?) " +
          "ON CONFLICT (uuid) DO UPDATE SET seq = excluded.seq",
      ),
      putDoc: db.prepare(
        "INSERT INTO doc_index (uuid, title, description) VALUES (?, ?, ?) " +
          "ON CONFLICT (uuid) DO UPDATE SET title = excluded.title, description = excluded.description",
      ),
      dropTags: db.prepare("DELETE FROM doc_tags WHERE uuid = ?"),
      putTag: db.prepare(
        "INSERT INTO doc_tags (uuid, tag) VALUES (?, ?) ON CONFLICT DO NOTHING",
      ),
      dropLinks: db.prepare("DELETE FROM doc_links WHERE source = ?"),
      putLink: db.prepare(
        "INSERT INTO doc_links (source, target) VALUES (?, ?) ON CONFLICT DO NOTHING",
      ),
      dropFts: db.prepare("DELETE FROM docs_fts WHERE uuid = ?"),
      putFts: db.prepare(
        "INSERT INTO docs_fts (uuid, title, body) VALUES (?, ?, ?)",
      ),
    };
    return this.gatePrepared;
  }

  /**
   * The highest sequence this process has appended for each room.
   *
   * `Replica.lastSeq` only advances on *replay*, so a process that has just
   * written is deriving from a cut its own `lastSeq` does not yet name. Taking
   * the maximum of the two is what makes the cut monotone per process; without
   * it a process gates its own newer derivation out. See the report.
   */
  private readonly appended = new Map<string, number>();

  override appendUpdate(
    room: string,
    payload: Uint8Array,
    origin: UpdateOrigin,
  ): number {
    const seq = super.appendUpdate(room, payload, origin);
    this.appended.set(room, seq);
    return seq;
  }

  /** The log cut this derivation came from. */
  private cut(uuid: string): number {
    const replica = this.replicas
      ?.attachedReplicas()
      .find((candidate) => candidate.id === uuid);
    if (replica === undefined) return 0;
    return Math.max(replica.lastSeq, this.appended.get(replica.room) ?? 0);
  }

  override indexDoc(doc: IndexedDoc): void {
    // Captured before the stall, exactly as a real caller would pass the cut it
    // derived from rather than the cut current at commit time.
    const seq = this.cut(doc.uuid);
    if (this.indexDelayMs > 0) blockingSleep(this.indexDelayMs);

    const started = now();
    const db = this.handle();
    const statements = this.gate();
    // IMMEDIATE, not deferred: the gate reads before it writes, and a deferred
    // transaction that upgrades cannot be retried by the busy handler.
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = statements.readSeq.get(doc.uuid) as { seq: number } | undefined;
      if (row !== undefined && row.seq >= seq) {
        db.exec("COMMIT");
        this.skipped += 1;
        this.gatedMs.push(now() - started);
        return;
      }
      statements.putDoc.run(doc.uuid, doc.title, doc.description);
      statements.dropTags.run(doc.uuid);
      for (const tag of new Set(doc.tags)) statements.putTag.run(doc.uuid, tag);
      statements.dropLinks.run(doc.uuid);
      for (const target of new Set(doc.links)) {
        if (target !== doc.uuid) statements.putLink.run(doc.uuid, target);
      }
      statements.dropFts.run(doc.uuid);
      statements.putFts.run(
        doc.uuid,
        doc.title,
        doc.description === "" ? doc.body : `${doc.description}\n${doc.body}`,
      );
      statements.putSeq.run(doc.uuid, seq);
      db.exec("COMMIT");
      this.written += 1;
      this.gatedMs.push(now() - started);
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      this.errors.push({ op: "indexSequenced", error: String(error), at: started });
      throw error;
    }
  }
}
