/** Throwaway spike only. The caller supplies its own Yjs document. */
export const variants = [
  "document-envelope",
  "collection-envelopes",
  "keyed-records",
];

export const collectionNames = ["summaries", "issues", "endpoints"];

const properties = {
  id: { type: "string" },
  ordinal: { type: "integer" },
  day: { type: "string" },
  value: { type: "number" },
  note: { type: "string" },
  title: { type: "string" },
  status: { type: "string" },
  owner: { type: "string" },
  category: { type: "string" },
  source: { type: "string" },
  region: { type: "string" },
  count: { type: "integer" },
  durationMs: { type: "number" },
  score: { type: "number" },
  active: { type: "boolean" },
  labels: { type: "array", items: { type: "string" } },
  metrics: {
    type: "object",
    properties: { min: { type: "number" }, max: { type: "number" } },
    required: ["min", "max"],
    additionalProperties: false,
  },
  url: { type: "string" },
  endpoint: { type: "string" },
  severity: { type: "integer" },
  retries: { type: "integer" },
  currency: { type: "string" },
  cost: { type: "number" },
  parent: { type: ["string", "null"] },
  extra: {
    type: "object",
    properties: { synthetic: { type: "boolean" }, group: { type: "integer" } },
    required: ["synthetic", "group"],
    additionalProperties: false,
  },
};

const clone = (value) => structuredClone(value);

/** Deterministic synthetic records: 25 fields, no owner or workspace data. */
export function generate(totalRecords, longValues = false) {
  if (!Number.isSafeInteger(totalRecords) || totalRecords < 0) {
    throw new Error("totalRecords must be a non-negative safe integer");
  }
  const collections = {};
  for (let c = 0; c < collectionNames.length; c++) {
    const name = collectionNames[c];
    const count = Math.floor(totalRecords / 3) + (c < totalRecords % 3 ? 1 : 0);
    const records = [];
    for (let i = 0; i < count; i++) {
      records.push({
        id: `${name}-${String(i).padStart(6, "0")}`,
        ordinal: i,
        day: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
        value: 50 + ((i * 17 + c * 11) % 101),
        note: longValues
          ? "synthetic-long-value-".repeat(205).slice(0, 4096)
          : `Synthetic record ${i} in ${name}.`,
        title: `${name} record ${i}`,
        status: ["open", "done", "waiting"][i % 3],
        owner: `synthetic-person-${i % 7}`,
        category: `category-${i % 5}`,
        source: "synthetic-fixture",
        region: ["region-a", "region-b"][i % 2],
        count: i % 31,
        durationMs: 10 + (i % 100) / 10,
        score: (i % 100) / 100,
        active: i % 2 === 0,
        labels: ["synthetic", `group-${i % 4}`],
        metrics: { min: i % 10, max: 100 + (i % 10) },
        url: `https://example.invalid/record/${name}/${i}`,
        endpoint: `/synthetic/${i % 8}`,
        severity: i % 4,
        retries: i % 3,
        currency: "EUR",
        cost: (i % 1000) / 100,
        parent: i === 0 ? null : `${name}-000000`,
        extra: { synthetic: true, group: i % 9 },
      });
    }
    collections[name] = {
      schemaVersion: 1,
      schema: {
        type: "object",
        properties: clone(properties),
        required: Object.keys(properties),
        additionalProperties: false,
      },
      records,
    };
  }
  return { formatVersion: 1, collections };
}

function checkVariant(variant) {
  if (!variants.includes(variant)) throw new Error(`Unknown variant: ${variant}`);
}

function collectionFor(id) {
  const name = collectionNames.find((candidate) => id.startsWith(`${candidate}-`));
  if (!name) throw new Error(`Unknown record id: ${id}`);
  return name;
}

export function writeInitial(doc, variant, data) {
  checkVariant(variant);
  const root = doc.getMap("spikeData");
  if (root.size !== 0) throw new Error("Initial write requires an empty data area");
  doc.transact(() => {
    if (variant === "document-envelope") {
      root.set("envelope", clone(data));
      return;
    }
    root.set("formatVersion", data.formatVersion);
    for (const name of collectionNames) {
      const collection = data.collections[name];
      if (variant === "collection-envelopes") {
        root.set(`collection:${name}`, clone(collection));
      } else {
        const { records, ...descriptor } = collection;
        root.set(`collection:${name}`, clone(descriptor));
        for (const record of records) root.set(`record:${record.id}`, clone(record));
      }
    }
  }, "spike-writer");
}

/** Returns a detached projection; observers cannot write through this value. */
export function readData(doc, variant) {
  checkVariant(variant);
  const root = doc.getMap("spikeData");
  if (variant === "document-envelope") {
    const envelope = root.get("envelope");
    return envelope === undefined ? null : clone(envelope);
  }
  if (root.get("formatVersion") === undefined) return null;
  const collections = {};
  for (const name of collectionNames) {
    const descriptor = root.get(`collection:${name}`);
    if (descriptor === undefined) throw new Error(`Missing collection: ${name}`);
    if (variant === "collection-envelopes") {
      collections[name] = clone(descriptor);
    } else {
      const records = [];
      for (const [key, value] of root.entries()) {
        if (key.startsWith(`record:${name}-`)) records.push(clone(value));
      }
      records.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
      collections[name] = { ...clone(descriptor), records };
    }
  }
  return { formatVersion: root.get("formatVersion"), collections };
}

export function append(doc, variant, row) {
  checkVariant(variant);
  const name = collectionFor(row.id);
  const root = doc.getMap("spikeData");
  doc.transact(() => {
    if (variant === "keyed-records") {
      if (root.has(`record:${row.id}`)) throw new Error(`Duplicate id: ${row.id}`);
      root.set(`record:${row.id}`, clone(row));
    } else if (variant === "collection-envelopes") {
      const collection = clone(root.get(`collection:${name}`));
      if (collection.records.some((record) => record.id === row.id)) {
        throw new Error(`Duplicate id: ${row.id}`);
      }
      collection.records.push(clone(row));
      root.set(`collection:${name}`, collection);
    } else {
      const data = clone(root.get("envelope"));
      if (data.collections[name].records.some((record) => record.id === row.id)) {
        throw new Error(`Duplicate id: ${row.id}`);
      }
      data.collections[name].records.push(clone(row));
      root.set("envelope", data);
    }
  }, "spike-writer");
}

export function correct(doc, variant, id, value) {
  checkVariant(variant);
  const name = collectionFor(id);
  const root = doc.getMap("spikeData");
  doc.transact(() => {
    if (variant === "keyed-records") {
      const record = root.get(`record:${id}`);
      if (record === undefined) throw new Error(`Missing record: ${id}`);
      root.set(`record:${id}`, { ...clone(record), value });
    } else if (variant === "collection-envelopes") {
      const collection = clone(root.get(`collection:${name}`));
      const record = collection.records.find((candidate) => candidate.id === id);
      if (!record) throw new Error(`Missing record: ${id}`);
      record.value = value;
      root.set(`collection:${name}`, collection);
    } else {
      const data = clone(root.get("envelope"));
      const record = data.collections[name].records.find((candidate) => candidate.id === id);
      if (!record) throw new Error(`Missing record: ${id}`);
      record.value = value;
      root.set("envelope", data);
    }
  }, "spike-writer");
}
