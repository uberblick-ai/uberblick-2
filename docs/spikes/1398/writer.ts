/** Throwaway writer using the same Replicas/MirrorStore and hub sync as MCP. */
import { performance } from "node:perf_hooks";
import { Replicas, type Replica } from "../../../packages/mcp-server/src/replica.js";
import { MirrorStore } from "../../../packages/mcp-server/src/store.js";
import { initDoc } from "../../../packages/schema/src/doc.js";
import { appendBlock } from "../../../packages/schema/src/blocks.js";
import { generate, writeInitial, append, correct, readData } from "./representations.mjs";

let replicas: Replicas | undefined;
let store: MirrorStore | undefined;
let doc: Replica["doc"];
let variant: string;
let lastCrdtApplyMs = 0;
let transactionStart = 0;
const epochNow = () => performance.timeOrigin + performance.now();
const deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)); }, 90_000);

async function cleanup() {
  clearTimeout(deadline);
  replicas?.destroy();
  await replicas?.sync.waitForDeviceWork();
  store?.close();
}

process.on("SIGTERM", () => { void cleanup().finally(() => process.exit(1)); });
type WriterCommand =
  | { command: "start"; variant: string; databasePath: string; workspaceId: string; hubUrl: string; authSecret: string; docId: string }
  | { command: "correct"; value: number }
  | { command: "append" | "stop" };

process.on("message", async (raw: unknown) => {
  const message = raw as WriterCommand;
  try {
    if (message.command === "start") {
      variant = message.variant;
      store = new MirrorStore(message.databasePath, message.workspaceId);
      replicas = new Replicas({
        workspaceId: message.workspaceId,
        hubUrl: message.hubUrl,
        authSecret: message.authSecret,
        databasePath: message.databasePath,
        sessionId: "synthetic-spike-writer",
        color: "#2563eb",
        connectTimeoutMs: 5_000,
        syncTimeoutMs: 5_000,
        reconnectMaxDelayMs: 500,
        cursorTtlMs: 500,
        compactAfter: 500,
        reconcileRetryMs: 100,
        updatedAtCoarsenessMs: 1000,
      }, store, { publishOwnPresence: false });
      doc = replicas.replica(message.docId).doc;
      doc.on("beforeTransaction", () => { transactionStart = performance.now(); });
      doc.on("afterTransaction", () => { lastCrdtApplyMs = performance.now() - transactionStart; });
      await replicas.settle({ requireHealthy: true });
      // Existing prose and metadata are separate from the optional data root.
      doc.transact(() => {
        initDoc(doc, { uuid: message.docId, title: "Synthetic chart feasibility document" });
        appendBlock(doc, { type: "paragraph", text: "This is an existing document with prose and optional structured data." });
      }, "existing-document");
      const startEpochMs = epochNow();
      writeInitial(doc, variant, generate(1500, false));
      const transactionEndedEpochMs = epochNow();
      const writerCrdtApplyMs = lastCrdtApplyMs;
      await replicas.settle({ requireHealthy: true });
      process.send?.({ command: "seeded", initial: { startEpochMs, transactionEndedEpochMs, writerCrdtApplyMs, writerTransactionMs: transactionEndedEpochMs - startEpochMs }, read: readData(doc, variant) });
    } else if (message.command === "correct") {
      const startEpochMs = epochNow();
      correct(doc, variant, "summaries-000000", message.value);
      const transactionEndedEpochMs = epochNow();
      process.send?.({ command: "corrected", value: message.value, startEpochMs, transactionEndedEpochMs, writerCrdtApplyMs: lastCrdtApplyMs, writerTransactionMs: transactionEndedEpochMs - startEpochMs });
    } else if (message.command === "append") {
      const sample = generate(1500, false).collections.summaries.records[0];
      const row = { ...sample, id: "summaries-000500", ordinal: 500, value: 55 };
      const startEpochMs = epochNow();
      append(doc, variant, row);
      const transactionEndedEpochMs = epochNow();
      process.send?.({ command: "appended", startEpochMs, transactionEndedEpochMs, writerCrdtApplyMs: lastCrdtApplyMs, writerTransactionMs: transactionEndedEpochMs - startEpochMs });
    } else if (message.command === "stop") {
      await replicas?.settle({ requireHealthy: true });
      const read = readData(doc, variant);
      await cleanup();
      await new Promise<void>((done, fail) => {
        process.send?.({ command: "stopped", read }, (error) => { if (error) fail(error); else done(); });
      });
      process.exit(0);
    }
  } catch (error) {
    // Only the parent consumes this diagnostic; durable evidence stores no
    // local path, token, environment value, or machine identifier.
    await cleanup();
    await new Promise<void>((done) => { process.send?.({ command: "error", message: String(error) }, () => done()); });
    process.exit(1);
  }
});
