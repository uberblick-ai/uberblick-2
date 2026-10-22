import type * as Y from "yjs";
import { readDocData } from "./data.js";
import type { DataCollection } from "./data.js";
import { compareCodePoints } from "./data-schema.js";
import type { JSONValue } from "./data-schema.js";
import { getMeta } from "./doc.js";
import { compareTables, contentKey, inlineChanges, snapshotBlocks } from "./revision-blocks.js";
import type { RevisionBlock, RevisionRowComparison } from "./revision-blocks.js";
import { diffWords, matchSequence } from "./revision-sequence.js";
import type { TextSpan } from "./revision-sequence.js";

export type RevisionChangeKind = "unchanged" | "changed" | "added" | "removed";

/** Indices address the visible block lists in the two input documents. */
export interface RevisionBlockComparison {
  kind: RevisionChangeKind;
  beforeIndex?: number;
  afterIndex?: number;
  /** Authored fields whose differences cannot be represented by text spans. */
  fields: string[];
  /** Empty for unchanged text, including formatting-only changes. */
  spans: TextSpan[];
  rows?: RevisionRowComparison[];
}

export interface RevisionFieldComparison {
  field: string;
  kind: Exclude<RevisionChangeKind, "unchanged">;
  /** Absence differs from an explicitly stored null. */
  before?: JSONValue;
  after?: JSONValue;
}

export interface RevisionRecordComparison {
  id: string;
  kind: Exclude<RevisionChangeKind, "unchanged">;
  fields: RevisionFieldComparison[];
  before?: JSONValue;
  after?: JSONValue;
}

export interface RevisionCollectionComparison {
  name: string;
  kind: Exclude<RevisionChangeKind, "unchanged">;
  schemaChanged: boolean;
  beforeSchema?: JSONValue;
  afterSchema?: JSONValue;
  records: RevisionRecordComparison[];
}

export interface RevisionComparison {
  changed: boolean;
  title: { before: string; after: string; spans: TextSpan[] } | null;
  /** Reading order; removals precede additions within a gap between kept pairs. */
  blocks: RevisionBlockComparison[];
  /** Only changed collections and records, ordered by name and record ID. */
  data: RevisionCollectionComparison[];
}

function equal(before: unknown, after: unknown): boolean {
  if (before === undefined || after === undefined) return before === after;
  return contentKey(before) === contentKey(after);
}

function keys(before: object, after: object): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compareCodePoints);
}

function compareBlock(before: RevisionBlock, after: RevisionBlock, beforeIndex: number, afterIndex: number): RevisionBlockComparison {
  const result: RevisionBlockComparison = {
    kind: before.key === after.key ? "unchanged" : "changed", beforeIndex, afterIndex, fields: [], spans: [],
  };
  if (result.kind === "unchanged") return result;
  result.fields = keys(before.fields, after.fields).filter((field) => !equal(
    Object.hasOwn(before.fields, field) ? before.fields[field] : undefined,
    Object.hasOwn(after.fields, field) ? after.fields[field] : undefined,
  ));
  if (before.type !== after.type) result.fields.push("type");
  if (before.type === "chart" && after.type === "chart" && before.chartMapping !== after.chartMapping) result.fields.push("source");
  if (before.table !== undefined && after.table !== undefined) {
    const table = compareTables(before, after);
    result.fields.push(...table.fields);
    result.rows = table.rows;
  } else if (before.inline !== undefined && after.inline !== undefined) {
    const spans = diffWords(before.text, after.text);
    result.fields.push(...inlineChanges(before.inline, after.inline));
    if (before.text !== after.text) result.spans = spans;
  } else if (before.type !== after.type) {
    // Cross-container replacements have no common text address space.
    result.fields.push("content");
  }
  result.fields = [...new Set(result.fields)];
  return result;
}

function compareBlocks(before: RevisionBlock[], after: RevisionBlock[]): RevisionBlockComparison[] {
  const pairs = matchSequence(before, after);
  const result: RevisionBlockComparison[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const pair of [...pairs, { before: before.length, after: after.length }]) {
    while (oldIndex < pair.before) result.push({ kind: "removed", beforeIndex: oldIndex++, fields: [], spans: [] });
    while (newIndex < pair.after) result.push({ kind: "added", afterIndex: newIndex++, fields: [], spans: [] });
    const oldBlock = before[pair.before];
    const newBlock = after[pair.after];
    if (oldBlock !== undefined && newBlock !== undefined) {
      result.push(compareBlock(oldBlock, newBlock, pair.before, pair.after));
      oldIndex++;
      newIndex++;
    }
  }
  return result;
}

function objectFields(value: JSONValue | undefined): Record<string, JSONValue> {
  if (value === undefined) return {};
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  // Invalid merged records remain comparable without losing their raw value.
  return { "": value };
}

function compareRecord(id: string, before: JSONValue | undefined, after: JSONValue | undefined): RevisionRecordComparison | null {
  if (equal(before, after)) return null;
  const oldFields = objectFields(before);
  const newFields = objectFields(after);
  const fields: RevisionFieldComparison[] = keys(oldFields, newFields).flatMap((field) => {
    const oldValue = Object.hasOwn(oldFields, field) ? oldFields[field] : undefined;
    const newValue = Object.hasOwn(newFields, field) ? newFields[field] : undefined;
    return equal(oldValue, newValue) ? [] : [{
      field, kind: oldValue === undefined ? "added" as const : newValue === undefined ? "removed" as const : "changed" as const,
      ...(oldValue === undefined ? {} : { before: oldValue }), ...(newValue === undefined ? {} : { after: newValue }),
    }];
  });
  return {
    id, kind: before === undefined ? "added" : after === undefined ? "removed" : "changed", fields,
    ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }),
  };
}

function compareCollection(name: string, before: DataCollection | undefined, after: DataCollection | undefined): RevisionCollectionComparison | null {
  const oldRecords = new Map(before?.records.map((record) => [record.id, record.value]));
  const newRecords = new Map(after?.records.map((record) => [record.id, record.value]));
  const ids = [...new Set([...oldRecords.keys(), ...newRecords.keys()])].sort(compareCodePoints);
  const records = ids.flatMap((id) => {
    const record = compareRecord(id, oldRecords.get(id), newRecords.get(id));
    return record === null ? [] : [record];
  });
  const schemaChanged = !equal(before?.schema, after?.schema);
  if (before !== undefined && after !== undefined && !schemaChanged && records.length === 0) return null;
  return {
    name, kind: before === undefined ? "added" : after === undefined ? "removed" : "changed", schemaChanged,
    ...(before === undefined ? {} : { beforeSchema: before.schema }),
    ...(after === undefined ? {} : { afterSchema: after.schema }), records,
  };
}

/**
 * Compare two detached or live revisions without changing either document.
 * Only title, visible authored block content and structured data participate;
 * comments and other metadata do not. No stored history or attribution is needed.
 * ID matches precede exact content LCS matches; pairs outside the final LIS
 * appear as a removal and an addition. Regenerated IDs plus edited content and
 * indistinguishable duplicate blocks have no stronger identity guarantee.
 */
export function compareRevisions(before: Y.Doc, after: Y.Doc): RevisionComparison {
  const oldTitle = getMeta(before).title;
  const newTitle = getMeta(after).title;
  const title = oldTitle === newTitle ? null : { before: oldTitle, after: newTitle, spans: diffWords(oldTitle, newTitle) };
  const blocks = compareBlocks(snapshotBlocks(before), snapshotBlocks(after));
  const oldData = new Map(readDocData(before)?.collections.map((collection) => [collection.name, collection]));
  const newData = new Map(readDocData(after)?.collections.map((collection) => [collection.name, collection]));
  const names = [...new Set([...oldData.keys(), ...newData.keys()])].sort(compareCodePoints);
  const data = names.flatMap((name) => {
    const collection = compareCollection(name, oldData.get(name), newData.get(name));
    return collection === null ? [] : [collection];
  });
  return { changed: title !== null || blocks.some((block) => block.kind !== "unchanged") || data.length > 0, title, blocks, data };
}
