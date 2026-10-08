/** Disposable, deterministic temporal evidence. Never resolves a workspace or starts a server. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as Y from "../../../packages/mcp-server/node_modules/yjs/dist/yjs.mjs";
import { HubDatabase } from "../../../packages/hub/src/persistence.ts";
import { MirrorStore } from "../../../packages/mcp-server/src/store.ts";
import { collectionNames, generate, readData, variants, writeInitial } from "./representations.mjs";

const scratch = process.argv[2];
assert(scratch && path.isAbsolute(scratch), "Pass the absolute private run scratch directory");
const runId = "f6532a96c0274c069626c2452994d451";
const exportDirectory = path.join(scratch, `temporal-browser-${runId}`);
mkdirSync(exportDirectory, { recursive: true, mode: 0o700 });
const resultPath = fileURLToPath(new URL("./temporal-results.json", import.meta.url));
const writesDirectory = fileURLToPath(new URL("./temporal-writes/", import.meta.url));
mkdirSync(writesDirectory, { recursive: true });
const started = performance.now();
const deadlineMs = 15 * 60 * 1000;
const templates = generate(3000);
const clone = (value) => structuredClone(value);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function newDoc(clientId = 1398) {
  const doc = new Y.Doc();
  doc.clientID = clientId;
  return doc;
}

function date(day) {
  return new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
}

function row(name, index, day, source, noteCharacters = 0) {
  const result = clone(templates.collections[name].records[index % 1000]);
  result.id = `${name}-${String(index).padStart(6, "0")}`;
  result.ordinal = index;
  result.day = date(day);
  result.source = source;
  result.title = `${source} ${index}`;
  result.note = noteCharacters > 0
    ? "Synthetic compact aggregate explanation. ".repeat(Math.ceil(noteCharacters / 40)).slice(0, noteCharacters)
    : `Synthetic ${source} observation ${index}.`;
  assert.equal(Object.keys(result).length, 25);
  return result;
}

function emptyData() {
  return generate(0);
}

function corrected(record, revision) {
  return { ...clone(record), value: 200 + revision, score: (revision % 100) / 100 };
}

/** Events retain proposed input rows; unchanged comparison is performed independently for every shape. */
function annualWorkload(name) {
  const data = emptyData();
  const events = [];
  const humanRecords = [];
  const initial = emptyData();
  const add = (collection, day, source, count, noteCharacters = 0) => {
    const rows = [];
    for (let i = 0; i < count; i++) {
      const next = row(collection, data.collections[collection].records.length, day, source, noteCharacters);
      data.collections[collection].records.push(next);
      rows.push(clone(next));
    }
    return rows;
  };
  const replace = (collection, indexes, day) => indexes.map((index, offset) => {
    const next = corrected(data.collections[collection].records[index], day * 100 + offset);
    data.collections[collection].records[index] = next;
    return clone(next);
  });
  const event = (day, kind, rows, producerScopeRecords, rewriteAll = false) => {
    events.push({ day, date: date(day), kind, rows: clone(rows), producerScopeRecords, rewriteAll });
  };
  const isCode = name.startsWith("code-health-");
  if (isCode) {
    add("endpoints", 0, "code-package-current", 60);
    initial.collections.endpoints.records = clone(data.collections.endpoints.records);
  }
  const producerFindingIndexes = [];
  for (let day = 1; day <= 365; day++) {
    if (name === "delivery") {
      event(day, "daily-summary-append", add("summaries", day, "delivery-daily", 1), data.collections.summaries.records.length);
      event(day, "daily-issue-observations-append", add("issues", day, "delivery-issue-observation", 6), data.collections.issues.records.length);
      if (day % 7 === 0) {
        const priorCount = data.collections.issues.records.length - 6;
        const indexes = Array.from({ length: 5 }, (_, i) => (day * 13 + i * 17) % priorCount);
        event(day, "weekly-historical-correction", replace("issues", indexes, day), data.collections.issues.records.length);
      }
    } else if (isCode) {
      event(day, "daily-summary-append", add("summaries", day, "code-health-daily", 1), data.collections.summaries.records.length);
      const indexes = Array.from({ length: 6 }, (_, i) => (day * 7 + i) % 60);
      replace("endpoints", indexes, day);
      event(day, "daily-package-producer-refresh", data.collections.endpoints.records, 60, name.endsWith("rewrite-all"));
      if (day % 7 === 0) {
        const indexes = [Math.floor((day - 1) / 3), Math.floor((day - 1) / 2)];
        event(day, "weekly-historical-summary-recomputation", replace("summaries", indexes, day), data.collections.summaries.records.length);
      }
    } else if (name === "model-evaluation") {
      if (day % 14 === 0) {
        const rows = [...add("summaries", day, "evaluation-run-summary", 1, 2048), ...add("issues", day, "evaluation-aggregate-group", 5, 256)];
        event(day, "fortnightly-run-append", rows, data.collections.summaries.records.length + data.collections.issues.records.length);
      }
      if (day >= 21 && day % 14 === 7) {
        const run = data.collections.summaries.records.length - 1;
        const rows = [...replace("summaries", [run], day), ...replace("issues", [run * 5 + day % 5], day)];
        event(day, "seven-day-later-run-correction", rows, data.collections.summaries.records.length + data.collections.issues.records.length);
      }
    } else if (name === "api-health") {
      const endpoints = add("endpoints", day, "api-endpoint-day", 10);
      endpoints.forEach((record, index) => { record.endpoint = `/synthetic/endpoint-${index}`; });
      data.collections.endpoints.records.splice(-10, 10, ...clone(endpoints));
      event(day, "daily-ten-endpoint-day-append", endpoints, data.collections.endpoints.records.length);
      const overview = add("summaries", day, "api-daily-overview", 1);
      const findings = add("issues", day, "api-producer-finding", 1);
      producerFindingIndexes.push(findings[0].ordinal);
      event(day, "daily-overview-and-finding-append", [...overview, ...findings], day * 2);
      if (day % 7 === 0) {
        const end = data.collections.endpoints.records.length;
        const indexes = Array.from({ length: 7 }, (_, i) => end - 70 + i * 10 + day % 10);
        const rows = [
          ...replace("endpoints", indexes, day),
          ...replace("summaries", [day - 7], day),
          ...replace("issues", [producerFindingIndexes[day - 7]], day),
        ];
        event(day, "weekly-change-aware-producer-recomputation", rows, 70 + 7 + 7);
        const human = add("issues", day, "api-human-disposition", 1);
        human[0].status = "accepted";
        human[0].owner = "synthetic-human";
        data.collections.issues.records[human[0].ordinal] = clone(human[0]);
        humanRecords.push(clone(human[0]));
        event(day, "weekly-human-disposition-append", human, humanRecords.length);
      }
    } else {
      throw new Error(`Unknown annual workload: ${name}`);
    }
  }
  return {
    name, durationDays: 365, initial, events, finalExpected: data, humanRecords,
    description: {
      delivery: "Daily 1 summary and 6 per-issue observations in two producer writes; weekly 5 rotating existing/historical observations corrected in one later write. Append dominated, no full refresh.",
      "code-health-change-aware": "Initial 60 current package rows; daily append one summary, then producer recomputes 60 packages with exactly 6 changed values (10%) and skips 54 identical rows; weekly correct 2 historical summaries. No schema rewrite.",
      "code-health-rewrite-all": "Same logical stream as change-aware code health; plausible naive daily package snapshot producer rewrites all 60 package rows though only 6 values changed. Daily summaries and weekly historical corrections unchanged; descriptors are reused.",
      "model-evaluation": "One run every 14 days: one aggregate summary with 2048 ASCII-character note and 5 compact group aggregates with 256-character notes. Correct summary plus one group 7 days later. Raw external evaluation data remains external; final run has no correction inside year.",
      "api-health": "Daily 10 new endpoint-day rows, then one overview and one producer finding. Weekly recompute 7 of trailing 70 endpoint-days plus one old overview and one old producer finding; append a separate human disposition. Producer refresh never touches human-owned dispositions.",
    }[name],
  };
}

function sensitivityWorkload(name) {
  const initial = generate(1500);
  const data = clone(initial);
  const events = [];
  for (let round = 1; round <= 30; round++) {
    const flattened = collectionNames.flatMap((collection) => data.collections[collection].records);
    const changedIndexes = name.endsWith("all-values-changed")
      ? Array.from({ length: 1500 }, (_, i) => i)
      : Array.from({ length: 150 }, (_, i) => ((round - 1) * 150 + i) % 1500);
    const changedIds = new Set(changedIndexes.map((index) => flattened[index].id));
    const rows = [];
    for (const collection of collectionNames) {
      data.collections[collection].records = data.collections[collection].records.map((record) => changedIds.has(record.id) ? corrected(record, round * 100) : record);
      rows.push(...data.collections[collection].records);
    }
    events.push({
      day: round, date: null, kind: "bounded-distinct-key-sensitivity", rows: clone(rows),
      producerScopeRecords: 1500, rewriteAll: name.endsWith("rewrite-all"),
    });
  }
  return {
    name, durationDays: null, rounds: 30, initial, events, finalExpected: data, humanRecords: [],
    description: name.endsWith("all-values-changed")
      ? "Bounded sensitivity, not a temporal forecast: initial 1500 records; all 1500 values change in each of 30 unpaced rounds. Independently tests the reviewer's every-distinct-key history observation without targeting its numbers."
      : `Bounded sensitivity, not a temporal forecast: initial 1500 records; 150 values (10%) change each of 30 unpaced rounds, rotating cursor by 150 modulo 1500. ${name.endsWith("rewrite-all") ? "Producer rewrites all 1500 rows." : "Producer compares all 1500 and skips the 1350 identical rows."}`,
  };
}

function capture(doc, operation) {
  const updates = [];
  const listener = (update) => updates.push(update);
  doc.on("update", listener);
  const start = performance.now();
  try { operation(); } finally { doc.off("update", listener); }
  return { updates, mutationAndEncodingMs: performance.now() - start };
}

function applyEvent(doc, variant, data, byId, event) {
  const logicallyChanged = event.rows.filter((record) => JSON.stringify(byId.get(record.id)) !== JSON.stringify(record));
  const rewritten = event.rewriteAll ? event.rows : logicallyChanged;
  for (const record of logicallyChanged) {
    const name = record.id.slice(0, record.id.indexOf("-"));
    const records = data.collections[name].records;
    if (byId.has(record.id)) records[record.ordinal] = clone(record);
    else {
      assert.equal(record.ordinal, records.length);
      records.push(clone(record));
    }
    byId.set(record.id, clone(record));
  }
  const touchedCollections = [...new Set(rewritten.map((record) => record.id.slice(0, record.id.indexOf("-"))))];
  const captured = capture(doc, () => {
    if (rewritten.length === 0) return;
    const root = doc.getMap("spikeData");
    doc.transact(() => {
      if (variant === "document-envelope") root.set("envelope", clone(data));
      else if (variant === "collection-envelopes") {
        for (const name of touchedCollections) root.set(`collection:${name}`, clone(data.collections[name]));
      } else {
        for (const record of rewritten) root.set(`record:${record.id}`, clone(record));
      }
    }, "spike-temporal-producer");
  });
  assert.equal(captured.updates.length, rewritten.length > 0 ? 1 : 0);
  return {
    ...captured, logicallyChanged, rewritten,
    touchedCollections,
    unchangedCandidateRecords: event.rows.length - logicallyChanged.length,
    unchangedRecordsSkipped: event.rewriteAll ? 0 : event.rows.length - logicallyChanged.length,
  };
}

function sample(operation) {
  const samplesMs = [];
  for (let i = 0; i < 13; i++) {
    const duration = operation();
    if (i >= 3) samplesMs.push(duration);
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    samplesMs, warmups: 3, samples: 10,
    medianMs: (sorted[4] + sorted[5]) / 2, p95Ms: sorted[9],
    minMs: sorted[0], maxMs: sorted[9],
  };
}

function coldApply(state) {
  return sample(() => {
    const target = newDoc(2398);
    const start = performance.now();
    Y.applyUpdate(target, state);
    const elapsed = performance.now() - start;
    target.destroy();
    return elapsed;
  });
}

function fullProjection(doc, variant) {
  return sample(() => {
    const start = performance.now();
    const projection = readData(doc, variant);
    // Same full-area clone/scan as the initial prototype, then summaries-to-line-series.
    const series = projection.collections.summaries.records.map((record) => ({ x: record.ordinal, y: record.value }));
    assert.equal(series.length, projection.collections.summaries.records.length);
    return performance.now() - start;
  });
}

function stateFacts(state) {
  const decoded = Y.decodeUpdate(state);
  let deletedMarkerRanges = 0;
  let deletedClockLength = 0;
  for (const ranges of decoded.ds.clients.values()) {
    deletedMarkerRanges += ranges.length;
    for (const range of ranges) deletedClockLength += range.len;
  }
  return {
    encodedStateBytes: state.byteLength,
    encodedStructCount: decoded.structs.length,
    deletedMarkerRanges,
    deletedClockLength,
  };
}

function fileBytes(file) {
  try { return statSync(file).size; } catch { return 0; }
}

function storageFacts(reader, localFile, hub, hubFile, room) {
  const log = reader.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(length(payload)), 0) AS bytes FROM updates WHERE room = ?").get(room);
  const snapshot = reader.prepare("SELECT length(state) AS bytes, through_seq AS throughSeq FROM snapshots WHERE room = ?").get(room);
  const hubSnapshot = hub.connection.prepare("SELECT length(data) AS bytes FROM documents WHERE name = ?").get(room);
  return {
    localLogRows: Number(log.count), localLogBlobBytes: Number(log.bytes),
    localSnapshotBlobBytes: snapshot ? Number(snapshot.bytes) : 0,
    localSnapshotThroughSeq: snapshot ? Number(snapshot.throughSeq) : 0,
    hubSnapshotBlobBytes: hubSnapshot ? Number(hubSnapshot.bytes) : 0,
    localDatabaseFileBytes: fileBytes(localFile), localWalFileBytes: fileBytes(`${localFile}-wal`),
    hubDatabaseFileBytes: fileBytes(hubFile),
  };
}

async function measure(workload, variant) {
  const directory = mkdtempSync(path.join(scratch, `${runId}-temporal-`));
  const localFile = path.join(directory, "local.sqlite");
  const hubFile = path.join(directory, "hub.sqlite");
  const room = "spike-temporal-disposable";
  const store = new MirrorStore(localFile, "13980000-0000-4000-8000-000000000002");
  const reader = new DatabaseSync(localFile, { readOnly: true });
  const hub = new HubDatabase(hubFile, (error) => { throw error; });
  hub.open();
  const doc = newDoc();
  const data = clone(workload.initial);
  const byId = new Map(collectionNames.flatMap((name) => data.collections[name].records.map((record) => [record.id, clone(record)])));
  const output = {
    workload: workload.name, variant, description: workload.description, durationDays: workload.durationDays,
    rounds: workload.rounds ?? null, initialLiveRecordCount: byId.size,
    writes: [], checkpoints: [], compactions: [],
    cumulativePayloadBytes: 0, cumulativeHubSnapshotBlobBytesWritten: 0,
    cumulativeLocalSnapshotBlobBytesWritten: 0,
    peakLocalLogRows: 0, peakLocalLogBlobBytes: 0,
    schemaWrites: "Schema content/version never change; envelope replacements reserialize descriptors inside affected values, while keyed descriptor keys are written only during initial write.",
  };
  let sequence = 0;
  let logRows = 0;
  let logBytes = 0;
  const persist = async (update, info) => {
    const appendStart = performance.now();
    sequence = store.appendUpdate(room, update, "local");
    const localAppendMs = performance.now() - appendStart;
    logRows++;
    logBytes += update.byteLength;
    output.cumulativePayloadBytes += update.byteLength;
    output.peakLocalLogRows = Math.max(output.peakLocalLogRows, logRows);
    output.peakLocalLogBlobBytes = Math.max(output.peakLocalLogBlobBytes, logBytes);
    const hubStart = performance.now();
    await hub.onStoreDocument({ document: doc, documentName: room });
    const hubEncodeAndStoreMs = performance.now() - hubStart;
    const hubBytes = Number(hub.connection.prepare("SELECT length(data) AS bytes FROM documents WHERE name = ?").get(room).bytes);
    output.cumulativeHubSnapshotBlobBytesWritten += hubBytes;
    output.writes.push({ ...info, updateBytes: update.byteLength, localAppendMs, hubEncodeAndStoreMs, hubSnapshotBlobBytes: hubBytes });
    if (store.updateCount(room) >= 500) {
      const before = storageFacts(reader, localFile, hub, hubFile, room);
      assert.equal(before.localLogRows, logRows);
      assert.equal(before.localLogBlobBytes, logBytes);
      const compactStart = performance.now();
      const state = Y.encodeStateAsUpdate(doc);
      assert.equal(store.compact(room, state, sequence), true);
      output.cumulativeLocalSnapshotBlobBytesWritten += state.byteLength;
      logRows = 0;
      logBytes = 0;
      output.compactions.push({
        day: info.day, sequence, before, after: storageFacts(reader, localFile, hub, hubFile, room),
        encodeAndCompactMs: performance.now() - compactStart,
      });
    }
  };
  const checkpoint = async (day) => {
    const actual = readData(doc, variant);
    assert.deepEqual(actual, data);
    const state = Y.encodeStateAsUpdate(doc);
    const fresh = newDoc();
    try {
      writeInitial(fresh, variant, data);
      const freshState = Y.encodeStateAsUpdate(fresh);
      assert.equal(hash(readData(fresh, variant)), hash(actual));
      const logicalRows = collectionNames.flatMap((name) => data.collections[name].records);
      const rowBytes = logicalRows.map((record) => Buffer.byteLength(JSON.stringify(record))).sort((a, b) => a - b);
      const facts = storageFacts(reader, localFile, hub, hubFile, room);
      assert.equal(facts.localLogRows, logRows);
      assert.equal(facts.localLogBlobBytes, logBytes);
      assert.equal(facts.hubSnapshotBlobBytes, state.byteLength);
      const historical = stateFacts(state);
      const freshFacts = stateFacts(freshState);
      output.checkpoints.push({
        day, liveRecordCount: byId.size,
        collectionCounts: Object.fromEntries(collectionNames.map((name) => [name, data.collections[name].records.length])),
        logicalJsonUtf8Bytes: Buffer.byteLength(JSON.stringify(data)),
        recordJsonUtf8Bytes: { min: rowBytes[0] ?? null, median: rowBytes[Math.floor(rowBytes.length / 2)] ?? null, max: rowBytes.at(-1) ?? null },
        noteCharacterSizes: [...new Set(logicalRows.map((record) => record.note.length))].sort((a, b) => a - b),
        logicalSha256: hash(actual), history: historical, freshEquivalent: freshFacts,
        historicalOverheadBytes: state.byteLength - freshState.byteLength,
        coldApplyHistory: coldApply(state), coldApplyFresh: coldApply(freshState),
        fullProjectionAndLineSeriesHistory: fullProjection(doc, variant),
        fullProjectionAndLineSeriesFresh: fullProjection(fresh, variant),
        cumulativePayloadBytes: output.cumulativePayloadBytes,
        cumulativeHubSnapshotBlobBytesWritten: output.cumulativeHubSnapshotBlobBytesWritten,
        ...facts,
      });
      if (day === 365) {
        const stem = `${workload.name}-${variant}`;
        const historyFile = `${stem}-history.bin`;
        const freshFile = `${stem}-fresh.bin`;
        writeFileSync(path.join(exportDirectory, historyFile), state);
        writeFileSync(path.join(exportDirectory, freshFile), freshState);
        exports.push({ workload: workload.name, variant, historyFile, freshFile, logicalSha256: hash(actual), liveRecordCount: byId.size, historyBytes: state.byteLength, freshBytes: freshState.byteLength });
        writeFileSync(path.join(exportDirectory, "manifest.json"), `${JSON.stringify({ hashMethod: "sha256(JSON.stringify(readData(doc, variant))); collection order and ordinal/id record order from representations.mjs", entries: exports }, null, 2)}\n`);
      }
    } finally { fresh.destroy(); }
    await setImmediate();
  };
  try {
    const initialCapture = capture(doc, () => writeInitial(doc, variant, data));
    assert.equal(initialCapture.updates.length, 1);
    await persist(initialCapture.updates[0], {
      day: 0, date: date(0), kind: "initial-schema-and-records", liveRecordsBefore: 0,
      liveRecordsAfter: byId.size, logicallyChangedRecords: byId.size, recordsRewritten: byId.size,
      producerScopeRecords: byId.size, candidateRecords: byId.size, unchangedCandidateRecords: 0, unchangedRecordsSkipped: 0,
      logicallyTouchedFractionOfLive: byId.size === 0 ? 0 : 1, rewrittenFractionOfLive: byId.size === 0 ? 0 : 1,
      logicallyTouchedFractionOfProducerScope: byId.size === 0 ? 0 : 1,
      rewrittenFractionOfProducerScope: byId.size === 0 ? 0 : 1,
      changedIds: [...byId.keys()], rewriteAll: false,
      mutationAndEncodingMs: initialCapture.mutationAndEncodingMs,
    });
    await checkpoint(0);
    for (let day = 1; day <= (workload.durationDays ?? workload.rounds); day++) {
      for (const event of workload.events.filter((candidate) => candidate.day === day)) {
        const before = byId.size;
        const applied = applyEvent(doc, variant, data, byId, event);
        const after = byId.size;
        const info = {
          day, date: event.date, kind: event.kind, liveRecordsBefore: before, liveRecordsAfter: after,
          producerScopeRecords: event.producerScopeRecords, candidateRecords: event.rows.length,
          logicallyChangedRecords: applied.logicallyChanged.length, recordsRewritten: applied.rewritten.length,
          unchangedCandidateRecords: applied.unchangedCandidateRecords, unchangedRecordsSkipped: applied.unchangedRecordsSkipped,
          logicallyTouchedFractionOfLive: after === 0 ? 0 : applied.logicallyChanged.length / after,
          rewrittenFractionOfLive: after === 0 ? 0 : applied.rewritten.length / after,
          logicallyTouchedFractionOfProducerScope: event.producerScopeRecords === 0 ? 0 : applied.logicallyChanged.length / event.producerScopeRecords,
          rewrittenFractionOfProducerScope: event.producerScopeRecords === 0 ? 0 : applied.rewritten.length / event.producerScopeRecords,
          changedIds: applied.logicallyChanged.map((record) => record.id),
          rewrittenIds: applied.rewritten.map((record) => record.id), touchedCollections: applied.touchedCollections,
          candidateRecordJsonUtf8Bytes: event.rows.map((record) => Buffer.byteLength(JSON.stringify(record))),
          rewriteAll: event.rewriteAll, mutationAndEncodingMs: applied.mutationAndEncodingMs,
        };
        if (applied.updates.length === 1) await persist(applied.updates[0], info);
        else output.writes.push({ ...info, updateBytes: 0, localAppendMs: 0, hubEncodeAndStoreMs: 0, hubSnapshotBlobBytes: null });
      }
      if ([30, 90, 180, 365].includes(day)) await checkpoint(day);
      if (performance.now() - started > deadlineMs) throw new Error("Temporal evidence exceeded its 15-minute deadline");
      if (day % 7 === 0) await setImmediate();
    }
    assert.deepEqual(data, workload.finalExpected);
    assert.deepEqual(readData(doc, variant), workload.finalExpected);
    for (const human of workload.humanRecords) assert.deepEqual(byId.get(human.id), human);
    const recovered = newDoc(3398);
    const fromStore = store.readSince(room, 0);
    if (fromStore.snapshot) Y.applyUpdate(recovered, fromStore.snapshot.state);
    for (const update of fromStore.updates) Y.applyUpdate(recovered, update.payload);
    assert.equal(hash(readData(recovered, variant)), hash(workload.finalExpected));
    const fromHub = newDoc(4398);
    await hub.onLoadDocument({ document: fromHub, documentName: room });
    assert.equal(hash(readData(fromHub, variant)), hash(workload.finalExpected));
    recovered.destroy();
    fromHub.destroy();
    output.finalLiveRecordCount = byId.size;
    output.finalLogicalSha256 = hash(workload.finalExpected);
    output.recoveryAssertions = "Existing MirrorStore snapshot plus log tail and actual hub snapshot both reconstruct final expected data; API human disposition records retain exact original values.";
    const sortedPayloads = output.writes.map((write) => write.updateBytes).sort((a, b) => a - b);
    output.perWritePayloadSummaryBytes = {
      writes: sortedPayloads.length, min: sortedPayloads[0], median: sortedPayloads[Math.floor(sortedPayloads.length / 2)],
      p95: sortedPayloads[Math.ceil(sortedPayloads.length * 0.95) - 1], max: sortedPayloads.at(-1),
    };
    return output;
  } finally {
    doc.destroy(); reader.close(); store.close(); hub.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const version = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")).version;
const exports = [];
const results = {
  measuredAt: new Date().toISOString(),
  environment: {
    platform: os.platform(), release: os.release(), architecture: os.arch(), cpuModel: os.cpus()[0].model,
    logicalCpuCount: os.cpus().length, memoryBytes: os.totalmem(), node: process.version, v8: process.versions.v8, sqlite: process.versions.sqlite,
    yjs: version("../../../packages/mcp-server/node_modules/yjs/package.json"),
    hocuspocusServer: version("../../../packages/hub/node_modules/@hocuspocus/server/package.json"),
    tsx: version("../../../packages/mcp-server/node_modules/tsx/package.json"),
  },
  method: {
    classification: "Deterministic synthetic scenarios mapped to parent examples; assumptions, not observations of real producers. Simulated 2026-01-01 through 2026-12-31 run sequentially without waiting a year. Sensitivity rounds are separate from annual workloads.",
    values: "25 top-level fields, same existing schema/template generator. Each temporal row uses template index modulo 1000, actual monotonically increasing collection ordinal/id, UTC day, synthetic source/title/notes. Short notes identify the synthetic source and ordinal; evaluation notes are exactly 2048 or 256 ASCII characters. Raw row UTF8 sizes and note lengths retained at checkpoints/per proposed write.",
    cadence: "Each scheduled producer batch is one local Yjs transaction. Historical corrections and human dispositions are separate scheduled writes. Schema content/version never change; envelopes reserialize descriptors as part of changed values, while separate keyed descriptors are not rewritten. Change-aware JSON equality skips unchanged records; envelope variants skip an entire write if no logical records change, and collection envelopes replace only affected collections. Naive refresh explicitly rewrites all producer package records. Per-write recordsRewritten and rewrittenIds count offered row replacements, not all rows physically serialized inside an affected envelope; document-envelope serializes all current collections, collection-envelopes serialize all rows of affected collections, keyed-records serialize offered rows.",
    fairness: "Same logical event stream, identifiers, schemas, 1398 producer clientID, default gc=true and Yjs V1 encoding across shapes; projections and hashes asserted at every checkpoint and final local/hub recovery. Code-health refresh pair has identical logical hashes. Existing readData sorts keyed projections by ordinal/id.",
    transfer: "All emitted update.byteLength values and cumulative totals measured exactly, uncompressed; these exclude protocol framing, state-vector/reconnect traffic and network delivery. Per-write changed and rewritten IDs and fractions are retained.",
    historicalOverhead: "At each checkpoint encode actual history and a new single-initial-write document containing precisely the same current live data. History-minus-fresh byte delta separates CRDT history from legitimate append growth. This delta includes clock/delete/struct metadata, not retained old JSON payloads; compacting SQLite log does not recreate a fresh Yjs generation.",
    storage: "Actual private MirrorStore appendUpdate and HubDatabase onStoreDocument after every emitted update; 500-row MirrorStore.compact called directly, mirroring production threshold but excluding ReplicaEngine scheduling/indexing and hub debounce. SQLite BLOB bytes, peak pre-compaction log, remaining log/snapshot and allocated files separately retained. No VACUUM. Hub cumulative sum is logical snapshot BLOB bytes submitted to upserts, not measured SQLite page-write bytes or network traffic.",
    timings: "Checkpoint cold Y.applyUpdate into fresh documents and detached full readData plus summary line-series projection use performance.now, 3 warmups then 10 retained raw samples, average-of-middle median and nearest-rank p95. Setup/destruction excluded. Per-write mutationAndEncodingMs times Yjs mutation, target-value cloning and update encoding after JSON equality comparison and logical-data preparation; it excludes those producer preparation phases and storage. Hub encode/store and local append are separately timed. Node projection is a CPU microbenchmark, not browser drawing.",
    rawWrites: "Every original per-write measurement, including exact changed/offered IDs, proposed row UTF8 byte lengths, update bytes and phase timings, is retained as one compact JSON object per line in the per-case writesFile. Main JSON retains checkpoints and summaries only.",
    limits: "No server, normal ub open serving-replica path, production editor/MCP tools, WAN, indexing, access guards or concurrent producers measured. Synthetic one-year histories and bounded 30-round sensitivities do not establish production limits. Private day365 history/fresh binary exports support a separately retained browser probe, and are not a prerequisite for reproduction.",
  },
  measurements: [],
};

const names = ["delivery", "code-health-change-aware", "code-health-rewrite-all", "model-evaluation", "api-health"];
const sensitivityNames = ["distinct-key-10pct-change-aware", "distinct-key-10pct-rewrite-all", "distinct-key-all-values-changed"];
for (const name of [...names, ...sensitivityNames]) {
  const workload = names.includes(name) ? annualWorkload(name) : sensitivityWorkload(name);
  for (const variant of variants) {
    const measured = await measure(workload, variant);
    const sameWorkload = results.measurements.find((candidate) => candidate.workload === name);
    if (sameWorkload) {
      assert.equal(measured.finalLogicalSha256, sameWorkload.finalLogicalSha256);
      assert.deepEqual(measured.checkpoints.map((checkpoint) => checkpoint.logicalSha256), sameWorkload.checkpoints.map((checkpoint) => checkpoint.logicalSha256));
    }
    if (name === "code-health-rewrite-all" || name === "distinct-key-10pct-rewrite-all") {
      const pair = results.measurements.find((candidate) => candidate.workload === name.replace("rewrite-all", "change-aware") && candidate.variant === variant);
      assert.equal(measured.finalLogicalSha256, pair.finalLogicalSha256);
      assert.deepEqual(measured.checkpoints.map((checkpoint) => checkpoint.logicalSha256), pair.checkpoints.map((checkpoint) => checkpoint.logicalSha256));
    }
    const writesFile = `temporal-writes/${name}-${variant}.jsonl`;
    writeFileSync(path.join(writesDirectory, `${name}-${variant}.jsonl`), `${measured.writes.map((write) => JSON.stringify(write)).join("\n")}\n`);
    measured.writesFile = writesFile;
    measured.writesCount = measured.writes.length;
    delete measured.writes;
    results.measurements.push(measured);
    writeFileSync(resultPath, `${JSON.stringify(results, null, 2)}\n`);
    const last = measured.checkpoints.at(-1);
    console.log(JSON.stringify({ workload: name, variant, writes: measured.writesCount, records: measured.finalLiveRecordCount, cumulativePayloadBytes: measured.cumulativePayloadBytes, historyBytes: last.history.encodedStateBytes, freshBytes: last.freshEquivalent.encodedStateBytes, overheadBytes: last.historicalOverheadBytes, status: "complete" }));
    await setImmediate();
  }
}
console.log("All temporal cross-shape, refresh-pair, unchanged-skipping, disposition-preservation and real-store recovery assertions passed.");
