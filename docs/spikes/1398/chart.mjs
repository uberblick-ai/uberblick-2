import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import Chart from "chart.js/auto";
import { readData } from "./representations.mjs";

const config = await fetch("/spike-config.json").then((response) => response.json());
const doc = new Y.Doc();
const root = doc.getMap("spikeData");
const events = [];
const transactionStarts = new WeakMap();
const transactionMeasures = new WeakMap();
let scheduled = false;
let pendingMeasure;
let chart;
let localDocumentUpdates = 0;
let remoteDocumentUpdates = 0;
let observerCalls = 0;
const epochNow = () => performance.timeOrigin + performance.now();

doc.on("beforeTransaction", (transaction) => {
  if (!transaction.local) transactionStarts.set(transaction, epochNow());
});
doc.on("afterTransaction", (transaction) => {
  const start = transactionStarts.get(transaction);
  if (start !== undefined) {
    transactionMeasures.set(transaction, {
      receivedEpochMs: start,
      browserApplyMs: epochNow() - start,
    });
  }
});
doc.on("update", (_update, _origin, _doc, transaction) => {
  if (transaction.local) localDocumentUpdates += 1;
  else remoteDocumentUpdates += 1;
});

// A subscription projects state into a view. It never mutates its source.
root.observeDeep((_changes, transaction) => {
  observerCalls += 1;
  pendingMeasure = transaction;
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const apply = transactionMeasures.get(pendingMeasure);
    const projectionStart = epochNow();
    const data = readData(doc, config.variant);
    if (!data) return;
    const rows = data.collections.summaries.records;
    const labels = rows.map((_row, index) => index);
    const values = rows.map((row) => row.value);
    const projectedEpochMs = epochNow();
    const datasets = [{ label: "Synthetic summaries: value", data: values, borderColor: "#2563eb", pointRadius: 0, borderWidth: 2 }];
    if (chart) {
      chart.data.labels = labels;
      chart.data.datasets = datasets;
      chart.update("none");
    } else {
      chart = new Chart(document.getElementById("chart"), {
        type: "line",
        data: { labels, datasets },
        options: {
          animation: false,
          responsive: false,
          plugins: { legend: { display: true } },
          scales: { x: { title: { display: true, text: "Stable order within summaries" } }, y: { title: { display: true, text: "Value" }, min: 0, max: 180 } },
        },
      });
      chart.resize(940, 430);
    }
    const renderedEpochMs = epochNow();
    const event = {
      sequence: events.length,
      firstValue: values[0],
      summaryRecords: rows.length,
      totalRecords: Object.values(data.collections).reduce((sum, collection) => sum + collection.records.length, 0),
      ...apply,
      projectionMs: projectedEpochMs - projectionStart,
      chartDrawMs: renderedEpochMs - projectedEpochMs,
      renderedEpochMs,
    };
    events.push(event);
    document.getElementById("status").textContent = `${config.variant} · ${event.totalRecords} records · observer redraw ${event.sequence} · first value ${event.firstValue}`;
    document.getElementById("events").textContent = events.slice(-5).map((entry) => `redraw ${entry.sequence}: first value ${entry.firstValue}; records ${entry.totalRecords}`).join("\n");
    requestAnimationFrame(() => {
      // This is a next-frame callback, a paint opportunity proxy, not proof
      // of GPU presentation or a measurement of user-visible completion.
      event.nextAnimationFrameMs = epochNow() - renderedEpochMs;
    });
  });
});

window.spike = {
  events,
  get localDocumentUpdates() { return localDocumentUpdates; },
  get remoteDocumentUpdates() { return remoteDocumentUpdates; },
  get observerCalls() { return observerCalls; },
  read: () => readData(doc, config.variant),
};
const provider = new HocuspocusProvider({
  url: config.hubUrl,
  name: config.room,
  token: config.token,
  document: doc,
});
provider.on("authenticationFailed", ({ reason }) => {
  document.getElementById("status").textContent = `Authentication failed: ${reason}`;
});
window.addEventListener("pagehide", () => { provider.destroy(); doc.destroy(); }, { once: true });
