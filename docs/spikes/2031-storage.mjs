// Run with the repository's tsx; see 2031-document-revisions.md.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";

const [input] = process.argv.slice(2);
if (!input || (input !== "--recorded" && !isAbsolute(input)) || process.argv.length !== 3) {
  throw new Error("Usage: tsx docs/spikes/2031-storage.mjs ABSOLUTE_PRIVATE_SNAPSHOT_DIRECTORY | --recorded");
}

// Measurements only: no document content or Yjs state is committed. This mode
// preserves the original arithmetic after private captures have been removed.
const recorded = {
  capturedAt: "2026-10-21T16:54:12.209Z",
  source: "hub read-only room sync into empty gc:true Y.Doc",
  scope: "live regular documents",
  documents: 48,
  fullStateBytes: 1246335,
  rows: [
    { uuid: "6067a08e-abd5-4467-8e8e-58da3a83fc5d", title: "UB Agent Delivery Report",
      sha256: "45337e84a32f5ff897b29a295c3f684e16c6ade0e888973ff49ae8f6baff4ac7", fullStateBytes: 318746 },
    { uuid: "40e1ed96-97c3-4d4f-8a2e-8304c1e2bb80", title: "CLI: ub workspace intents and examples",
      sha256: "97cc61072ffb51180fd8b13390456c18ff4b943c25b112f73c06a90d751119c0", fullStateBytes: 62327 },
    { uuid: "390b1f09-ee80-4a91-9cab-41aa2cf0dfe1", title: "CI Health Report",
      sha256: "b72d839dec6f74c270c520f3f366bd7bf8bde8633cf18b4c1df55821a548ca52", fullStateBytes: 46818 },
  ],
};

async function measure(directory) {
  const require = createRequire(new URL("../../packages/mcp-server/package.json", import.meta.url));
  const Y = await import(require.resolve("yjs").replace("yjs.cjs", "yjs.mjs"));
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (manifest.source !== recorded.source || manifest.scope !== recorded.scope || manifest.rows.length < 3) {
    throw new Error("Expected at least three real hub captures from 2031-capture.mjs");
  }
  const uuids = new Set();
  const rows = manifest.rows.map(row => {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(row.uuid) || uuids.has(row.uuid)) {
      throw new Error("Invalid or duplicate document UUID in manifest");
    }
    uuids.add(row.uuid);
    const state = readFileSync(join(directory, `${row.uuid}.yjs`));
    const sha256 = createHash("sha256").update(state).digest("hex");
    if (sha256 !== row.sha256 || state.length !== row.bytes) {
      throw new Error(`Capture integrity check failed: ${row.uuid}`);
    }
    const doc = new Y.Doc({ gc: true });
    try {
      Y.applyUpdate(doc, state);
      if (doc.store.pendingStructs || doc.store.pendingDs) {
        throw new Error(`Incomplete full state: ${row.uuid}`);
      }
      return { uuid: row.uuid, title: row.title, sha256,
        fullStateBytes: Y.encodeStateAsUpdate(doc).length };
    } finally {
      doc.destroy();
    }
  }).sort((a, b) => b.fullStateBytes - a.fullStateBytes || a.uuid.localeCompare(b.uuid));
  return { ...manifest, rows, documents: rows.length,
    fullStateBytes: rows.reduce((sum, row) => sum + row.fullStateBytes, 0) };
}
const sample = input === "--recorded" ? recorded : await measure(input);
const rows = sample.rows;

// Each author's four 15-minute windows in a one-hour editing day yields a revision.
const assumptions = { calendarDays: 30, activeDays: 22, authorsPerDocument: 2,
  editingHoursPerAuthorPerActiveDay: 1, minutesPerRevisionPerAuthor: 15 };
const revisionsPerActiveDay = assumptions.authorsPerDocument
  * assumptions.editingHoursPerAuthorPerActiveDay * 60 / assumptions.minutesPerRevisionPerAuthor;
const revisionsPerMonth = assumptions.activeDays * revisionsPerActiveDay;
const mib = bytes => Number((bytes / 2 ** 20).toFixed(4));
const storage = retainedSnapshotBytes => ({ retainedSnapshotBytes,
  retainedSnapshotMiB: mib(retainedSnapshotBytes),
  retainedSnapshotGiB: Number((retainedSnapshotBytes / 2 ** 30).toFixed(4)) });
const estimate = (documents, bytesPerRevision, revisions = revisionsPerMonth) => ({
  documents, bytesPerRevision, revisionsPerMonth: revisions,
  ...storage(documents * bytesPerRevision * revisions),
});
console.log(JSON.stringify({
  capturedAt: sample.capturedAt,
  source: sample.source,
  scope: sample.scope,
  integrity: input === "--recorded" ? "Recorded numeric metadata only; this mode recomputes estimates without validating Yjs state."
    : "All input SHA-256 digests and byte counts verified; every full state decodes without pending updates.",
  measurement: "Y.encodeStateAsUpdate after applying hub state into a fresh gc:true Y.Doc; no Markdown reconstruction.",
  assumptions: { ...assumptions, revisionsPerActiveDay, revisionsPerMonth,
    activity: "Each author edits one uninterrupted hour; author switches that close a revision can exceed this rate.",
    size: "Every retained revision stays the measured current full-state size.",
    excluded: "Current document row, revision metadata/indexes, SQLite free pages/WAL, backups and replicas; no compression assumed." },
  topThree: rows.slice(0, 3).map(row => ({ ...row, fullStateKiB: Number((row.fullStateBytes / 1024).toFixed(4)),
    monthly: estimate(1, row.fullStateBytes) })),
  measuredCorpus: { documents: sample.documents, fullStateBytes: sample.fullStateBytes,
    fullStateMiB: mib(sample.fullStateBytes), monthly: storage(sample.fullStateBytes * revisionsPerMonth) },
  sensitivities: {
    oneHundredDocumentsAtLargestMeasuredSize: estimate(100, rows[0].fullStateBytes),
    oneDataRichTenMiBDocument: estimate(1, 10 * 2 ** 20),
    oneHundredDataRichTenMiBDocuments: estimate(100, 10 * 2 ** 20),
    authorSwitchEveryEditingMinute: {
      assumption: "Same two total author-hours daily, but each minute switches author and closes a revision; illustrative policy sensitivity only.",
      revisionsPerMonth: assumptions.activeDays * assumptions.authorsPerDocument * 60,
      measuredCorpusMonthly: storage(sample.fullStateBytes * assumptions.activeDays * assumptions.authorsPerDocument * 60),
      oneHundredDocumentsAtLargestMeasuredSize: estimate(100, rows[0].fullStateBytes,
        assumptions.activeDays * assumptions.authorsPerDocument * 60),
    },
  },
}, null, 2));
