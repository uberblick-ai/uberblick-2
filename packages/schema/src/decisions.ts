/** Decision answers derive entirely from directory stubs, never record rooms. */
import type * as Y from "yjs";
import { getMeta } from "./doc.js";
import { listDirectory } from "./directory.js";
import type { DecisionTopicResolution, DirectoryEntry } from "./types.js";

function compareAge(left: DirectoryEntry, right: DirectoryEntry): number {
  const age = (left.createdAt ?? Number.POSITIVE_INFINITY) -
    (right.createdAt ?? Number.POSITIVE_INFINITY);
  if (Number.isFinite(age) && age !== 0) return age;
  if (left.createdAt !== undefined && right.createdAt === undefined) return -1;
  if (left.createdAt === undefined && right.createdAt !== undefined) return 1;
  return left.uuid < right.uuid ? -1 : left.uuid > right.uuid ? 1 : 0;
}

function entries(source: Y.Doc | readonly DirectoryEntry[]): readonly DirectoryEntry[] {
  return Array.isArray(source)
    ? source : listDirectory(source as Y.Doc, { includeDeleted: true });
}

/** Walk a whole topic graph, including rejected and withdrawn intermediates. */
function ancestors(record: DirectoryEntry, byId: Map<string, DirectoryEntry>): Set<string> {
  const visited = new Set<string>([record.uuid]);
  const out = new Set<string>();
  let next = record.supersedes;
  while (next !== undefined && !visited.has(next)) {
    visited.add(next);
    const predecessor = byId.get(next);
    // A foreign cross-topic link must not join otherwise independent topics.
    if (predecessor === undefined) break;
    out.add(predecessor.uuid);
    next = predecessor.supersedes;
  }
  return out;
}

/** One answer per topic, with all pending and conflict branches preserved. */
export function resolveDecisionTopics(
  source: Y.Doc | readonly DirectoryEntry[],
): DecisionTopicResolution[] {
  const all = entries(source);
  const allById = new Map(all.map((entry) => [entry.uuid, entry]));
  const groups = new Map<string, DirectoryEntry[]>();
  for (const entry of all) {
    if (entry.kind !== "decision") continue;
    const topic = entry.topic ?? entry.uuid;
    const records = groups.get(topic) ?? [];
    records.push(entry);
    groups.set(topic, records);
  }
  const out: DecisionTopicResolution[] = [];
  for (const [topic, unsorted] of groups) {
    const records = [...unsorted].sort(compareAge);
    const oldest = records[0];
    if (oldest === undefined) continue;
    const byId = new Map(records.map((record) => [record.uuid, record]));
    const first = allById.get(topic) ?? null;
    const live = records.filter((record) => record.status !== "rejected" && record.status !== "withdrawn");
    const supersededByLive = new Set<string>();
    const supersededByDecided = new Set<string>();
    for (const record of live) {
      for (const ancestor of ancestors(record, byId)) {
        supersededByLive.add(ancestor);
        if (record.status === "decided") supersededByDecided.add(ancestor);
      }
    }
    const maximalDecided = live.filter((record) => record.status === "decided" && !supersededByDecided.has(record.uuid));
    const inForce = maximalDecided.length === 1 ? (maximalDecided[0] ?? null) : null;
    const pending = live.filter((record) => record.status === "open" && !supersededByLive.has(record.uuid));
    out.push({
      topic,
      first,
      representative: inForce ?? pending[0] ?? first ?? oldest,
      inForce,
      pending,
      conflicts: maximalDecided.length > 1 ? maximalDecided : [],
      superseded: live.filter((record) => record.status === "decided" && supersededByDecided.has(record.uuid)),
      rejected: records.filter((record) => record.status === "rejected"),
      withdrawn: records.filter((record) => record.status === "withdrawn"),
      records,
      archived: first?.deleted === true,
    });
  }
  return out.sort((left, right) => compareAge(left.first ?? left.representative, right.first ?? right.representative));
}

/** Requirement log, oldest topic first. Membership may be on any history record. */
export function readDecisions(doc: Y.Doc, directory?: Y.Doc): DecisionTopicResolution[] {
  if (directory === undefined) return [];
  const meta = getMeta(doc);
  if (meta.kind !== "requirement") return [];
  return resolveDecisionTopics(directory).filter((topic) => !topic.archived && topic.records.some((record) => record.governs === meta.uuid));
}

/** All predecessors and direct successors, each carrying its own cached status. */
export function decisionRelations(directory: Y.Doc, uuid: string): {
  predecessors: DirectoryEntry[];
  successors: DirectoryEntry[];
  resolution: DecisionTopicResolution | null;
} {
  const all = listDirectory(directory, { includeDeleted: true });
  const record = all.find((entry) => entry.uuid === uuid && entry.kind === "decision");
  if (record === undefined) return { predecessors: [], successors: [], resolution: null };
  const resolution = resolveDecisionTopics(all).find((topic) => topic.topic === (record.topic ?? record.uuid)) ?? null;
  const byId = new Map((resolution?.records ?? []).map((entry) => [entry.uuid, entry]));
  const predecessorIds = ancestors(record, byId);
  return {
    predecessors: [...predecessorIds].flatMap((id) => {
      const predecessor = byId.get(id);
      return predecessor === undefined ? [] : [predecessor];
    }),
    successors: all.filter((entry) => entry.kind === "decision" && entry.supersedes === uuid).sort(compareAge),
    resolution,
  };
}
