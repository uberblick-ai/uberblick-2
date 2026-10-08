/** Reproducible, sequential microbenchmarks; no shared workspace is opened. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as Y from "../../../packages/mcp-server/node_modules/yjs/dist/yjs.mjs";
import { HubDatabase } from "../../../packages/hub/src/persistence.ts";
import { MirrorStore } from "../../../packages/mcp-server/src/store.ts";
import { append, correct, generate, readData, variants, writeInitial } from "./representations.mjs";

const scratch = process.argv[2];
assert(scratch && path.isAbsolute(scratch), "Pass an absolute private scratch directory");
const runId = "f113f7929192418db18d6b630011c30d";
const cases = [
  { records: 300, longValues: false },
  { records: 1500, longValues: false },
  { records: 3000, longValues: false },
  { records: 1500, longValues: true },
];
const resultPath = fileURLToPath(new URL("./results.json", import.meta.url));
const deadline = setTimeout(() => {
  throw new Error("Spike benchmark exceeded its 20-minute deadline");
}, 20 * 60 * 1000);
deadline.unref();

function newDoc(clientId = 1398) {
  const doc = new Y.Doc();
  doc.clientID = clientId;
  return doc;
}

function capture(doc, operation) {
  const updates = [];
  const listener = (update) => updates.push(update);
  doc.on("update", listener);
  try {
    operation();
  } finally {
    doc.off("update", listener);
  }
  assert.equal(updates.length, 1, "One local transaction must emit one update");
  return updates[0];
}

function timings(operation) {
  const samples = [];
  for (let i = 0; i < 35; i++) {
    const duration = operation();
    if (i >= 5) samples.push(duration);
  }
  samples.sort((a, b) => a - b);
  return {
    medianMs: samples[14],
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
    minMs: samples[0],
    maxMs: samples[29],
    samples: 30,
    warmups: 5,
  };
}

function applyTimings(base, update) {
  return timings(() => {
    const target = newDoc(2398);
    if (base) Y.applyUpdate(target, base);
    const start = performance.now();
    Y.applyUpdate(target, update);
    const duration = performance.now() - start;
    target.destroy();
    return duration;
  });
}

function fileBytes(file) {
  try { return statSync(file).size; } catch { return 0; }
}

function sqliteFacts(reader, localFile, hub, hubFile, room) {
  const log = reader.prepare(
    "SELECT COUNT(*) AS count, COALESCE(SUM(length(payload)), 0) AS bytes FROM updates WHERE room = ?",
  ).get(room);
  const snapshot = reader.prepare(
    "SELECT length(state) AS bytes, through_seq AS throughSeq FROM snapshots WHERE room = ?",
  ).get(room);
  const stored = hub.connection.prepare(
    "SELECT COUNT(*) AS count, COALESCE(SUM(length(data)), 0) AS bytes FROM documents WHERE name = ?",
  ).get(room);
  return {
    localLogRows: Number(log.count),
    localLogBlobBytes: Number(log.bytes),
    localSnapshotBlobBytes: snapshot ? Number(snapshot.bytes) : 0,
    localSnapshotThroughSeq: snapshot ? Number(snapshot.throughSeq) : 0,
    hubSnapshotRows: Number(stored.count),
    hubSnapshotBlobBytes: Number(stored.bytes),
    localDatabaseFileBytes: fileBytes(localFile),
    localWalFileBytes: fileBytes(`${localFile}-wal`),
    hubDatabaseFileBytes: fileBytes(hubFile),
  };
}

async function storageGrowth(variant, data, caseInfo) {
  const correctionsToRun = caseInfo.records === 1500 && !caseInfo.longValues ? 501 : 10;
  const directory = mkdtempSync(path.join(scratch, `${runId}-measure-`));
  const localFile = path.join(directory, "local.sqlite");
  const hubFile = path.join(directory, "hub.sqlite");
  const room = "spike-disposable-document";
  const store = new MirrorStore(localFile, "13980000-0000-4000-8000-000000000001");
  const reader = new DatabaseSync(localFile, { readOnly: true });
  const hub = new HubDatabase(hubFile, (error) => { throw error; });
  hub.open();
  const doc = newDoc();
  let sequence = 0;
  const appendDurations = [];
  const storeDurations = [];
  const listener = (update) => {
    const start = performance.now();
    sequence = store.appendUpdate(room, update, "local");
    appendDurations.push(performance.now() - start);
  };
  doc.on("update", listener);
  const storeHub = async () => {
    const start = performance.now();
    await hub.onStoreDocument({ document: doc, documentName: room });
    storeDurations.push(performance.now() - start);
  };
  const checkpoints = [];
  const checkpoint = (corrections, phase, compactionMs = null) => {
    checkpoints.push({ corrections, phase, compactionMs, ...sqliteFacts(reader, localFile, hub, hubFile, room) });
  };
  try {
    writeInitial(doc, variant, data);
    await storeHub();
    checkpoint(0, "initial");
    for (let i = 1; i <= correctionsToRun; i++) {
      correct(doc, variant, "summaries-000000", 10000 + i);
      await storeHub();
      if ([1, 10, 100, 498].includes(i)) checkpoint(i, "before-compaction");
      if (store.updateCount(room) >= 500) {
        checkpoint(i, "threshold-before-compaction");
        const start = performance.now();
        assert.equal(store.compact(room, Y.encodeStateAsUpdate(doc), sequence), true);
        checkpoint(i, "after-compaction", performance.now() - start);
      }
      if ([500, 501].includes(i)) checkpoint(i, "after-later-correction");
      // Let deadlines and process signals run; never retain the log in JS arrays.
      if (i % 10 === 0) await setImmediate();
    }
    const recovered = newDoc(3398);
    const slice = store.readSince(room, 0);
    if (slice.snapshot) Y.applyUpdate(recovered, slice.snapshot.state);
    for (const update of slice.updates) Y.applyUpdate(recovered, update.payload);
    assert.deepEqual(readData(recovered, variant), readData(doc, variant));
    const hubRecovered = newDoc(4398);
    await hub.onLoadDocument({ document: hubRecovered, documentName: room });
    assert.deepEqual(readData(hubRecovered, variant), readData(doc, variant));
    recovered.destroy();
    hubRecovered.destroy();
    const stats = (values) => {
      const sorted = values.slice(5).sort((a, b) => a - b);
      return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
    };
    return {
      variant,
      ...caseInfo,
      cadence: `Unpaced sequential initial write then ${correctionsToRun} corrections; one transaction per correction; hub snapshot upsert awaited after every update`,
      correctionsMeasured: correctionsToRun,
      compaction: "Harness calls existing MirrorStore.compact at 500 logged rows, mirroring default threshold, rather than waiting for ReplicaEngine scheduling",
      checkpoints,
      appendUpdateTimings: { ...stats(appendDurations), samples: appendDurations.length - 5, warmups: 5 },
      hubSnapshotStoreTimings: { ...stats(storeDurations), samples: storeDurations.length - 5, warmups: 5 },
      recoveryAssertions: "Local snapshot + log tail and hub snapshot both reconstruct the final logical dataset",
    };
  } finally {
    doc.off("update", listener);
    doc.destroy();
    reader.close();
    store.close();
    hub.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function convergenceProbe() {
  // Each branch changes different rows and one shared schema key in ONE transaction.
  const base = newDoc(1);
  base.getMap("spikeData").set("schema", { version: 0 });
  const state = Y.encodeStateAsUpdate(base);
  const left = newDoc(2);
  const right = newDoc(3);
  Y.applyUpdate(left, state);
  Y.applyUpdate(right, state);
  const a = capture(left, () => left.transact(() => {
    left.getMap("spikeData").set("schema", { version: 1 });
    left.getMap("spikeData").set("row:a", { schemaVersion: 1, id: "a" });
  }));
  const b = capture(right, () => right.transact(() => {
    right.getMap("spikeData").set("schema", { version: 2 });
    right.getMap("spikeData").set("row:b", { schemaVersion: 2, id: "b" });
  }));
  Y.applyUpdate(left, b);
  Y.applyUpdate(right, a);
  assert.deepEqual(left.getMap("spikeData").toJSON(), right.getMap("spikeData").toJSON());
  const crossKeyResult = left.getMap("spikeData").toJSON();
  assert.equal(crossKeyResult.schema.version, 2);
  assert.equal(crossKeyResult["row:a"].schemaVersion, 1);
  assert.equal(crossKeyResult["row:b"].schemaVersion, 2);

  const eBase = newDoc(1);
  eBase.getMap("spikeData").set("envelope", { schemaVersion: 0, records: [] });
  const eState = Y.encodeStateAsUpdate(eBase);
  const eLeft = newDoc(2);
  const eRight = newDoc(3);
  Y.applyUpdate(eLeft, eState);
  Y.applyUpdate(eRight, eState);
  const eA = capture(eLeft, () => eLeft.getMap("spikeData").set("envelope", {
    schemaVersion: 1, records: [{ id: "a", schemaVersion: 1 }],
  }));
  const eB = capture(eRight, () => eRight.getMap("spikeData").set("envelope", {
    schemaVersion: 2, records: [{ id: "b", schemaVersion: 2 }],
  }));
  Y.applyUpdate(eLeft, eB);
  Y.applyUpdate(eRight, eA);
  const envelopeResult = eLeft.getMap("spikeData").toJSON();
  assert.deepEqual(envelopeResult, eRight.getMap("spikeData").toJSON());
  assert.equal(envelopeResult.envelope.schemaVersion, envelopeResult.envelope.records[0].schemaVersion);
  for (const doc of [base, left, right, eBase, eLeft, eRight]) doc.destroy();
  return {
    clientIds: { base: 1, left: 2, right: 3 },
    crossKeyResult,
    envelopeResult,
    conclusion: "Transactions batch local events; concurrent conflict resolution happens per key, so different-key rows survive under one winning schema. A whole envelope keeps its own schema/rows together by losing the competing envelope, including its row.",
  };
}

const version = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")).version;
const results = {
  measuredAt: new Date().toISOString(),
  environment: {
    platform: os.platform(), release: os.release(), architecture: os.arch(),
    cpuModel: os.cpus()[0].model, logicalCpuCount: os.cpus().length, memoryBytes: os.totalmem(),
    node: process.version, v8: process.versions.v8, sqlite: process.versions.sqlite,
    yjs: version("../../../packages/mcp-server/node_modules/yjs/package.json"),
    hocuspocusServer: version("../../../packages/hub/node_modules/@hocuspocus/server/package.json"),
    tsx: version("../../../packages/mcp-server/node_modules/tsx/package.json"),
  },
  method: {
    encoding: "Yjs v1; default gc=true; fixed producer clientID=1398; no compression; byteLength exact",
    data: "Deterministic generator, 3 equally distributed collections (remainder assigned summaries then issues), 25 top-level fields, nested labels/metrics/extra, short synthetic notes or 4096 ASCII-character notes",
    updates: "Initial write to empty document; append one generated summaries record with next ordinal; correct summaries-000000.value to 9999 after append; one local transaction each",
    apply: "Y.applyUpdate only timed with performance.now; initial applies to fresh doc, append to fresh doc preloaded with initial state, correction to fresh doc preloaded with post-append state; setup excluded; 5 warmups plus 30 measured samples, median lower middle (sample 15), p95 nearest rank (sample 29)",
    scope: "Microbenchmarks and direct storage APIs, not network or end-to-end latency; no production index work, scheduler, hub debounce, authentication, compression or competing workload",
    storage: "Fresh actual MirrorStore and HubDatabase files for each case; inspect SQLite BLOB lengths; filenames/files/wal sizes separate; no vacuum; stores and readers closed then disposable directory removed",
  },
  measurements: [],
  convergence: convergenceProbe(),
};

try {
  for (const caseInfo of cases) {
    const data = generate(caseInfo.records, caseInfo.longValues);
    assert.equal(Object.values(data.collections).flatMap((collection) => collection.records).length, caseInfo.records);
    assert.equal(Object.keys(data.collections.summaries.records[0]).length, 25);
    const next = generate(caseInfo.records + 3, caseInfo.longValues).collections.summaries.records.at(-1);
    for (const variant of variants) {
      const doc = newDoc();
      const initial = capture(doc, () => writeInitial(doc, variant, data));
      assert.deepEqual(readData(doc, variant), data);
      const initialState = Y.encodeStateAsUpdate(doc);
      const appended = capture(doc, () => append(doc, variant, next));
      const appendedState = Y.encodeStateAsUpdate(doc);
      const corrected = capture(doc, () => correct(doc, variant, "summaries-000000", 9999));
      const correctedState = Y.encodeStateAsUpdate(doc);
      const expected = structuredClone(data);
      expected.collections.summaries.records.push(structuredClone(next));
      expected.collections.summaries.records[0].value = 9999;
      assert.deepEqual(readData(doc, variant), expected);
      const replay = newDoc(5398);
      for (const update of [initial, appended, corrected]) Y.applyUpdate(replay, update);
      assert.deepEqual(readData(replay, variant), expected);
      const measurement = {
        ...caseInfo, variant,
        logicalJsonUtf8Bytes: Buffer.byteLength(JSON.stringify(data)),
        updateBytes: { initial: initial.byteLength, append: appended.byteLength, correction: corrected.byteLength },
        fullStateBytes: { initial: initialState.byteLength, append: appendedState.byteLength, correction: correctedState.byteLength },
        apply: { initial: applyTimings(null, initial), append: applyTimings(initialState, appended), correction: applyTimings(appendedState, corrected) },
        storageGrowth: await storageGrowth(variant, data, caseInfo),
      };
      results.measurements.push(measurement);
      writeFileSync(resultPath, `${JSON.stringify(results, null, 2)}\n`);
      console.log(JSON.stringify({ ...caseInfo, variant, updateBytes: measurement.updateBytes, fullStateBytes: measurement.fullStateBytes, status: "complete" }));
      doc.destroy();
      replay.destroy();
      await setImmediate();
    }
  }
  console.log("All roundtrip, replay, storage-recovery and convergence assertions passed.");
} finally {
  clearTimeout(deadline);
}
