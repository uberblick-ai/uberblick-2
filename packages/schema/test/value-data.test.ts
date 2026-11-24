import { describe, expect, it } from "vitest";
import { parseValueSource, prepareValue, scanValueSources } from "../src/index.js";
import type { DataCollection, DataRecord, DocData } from "../src/index.js";

const mapping = { collection: "results", filter: { system: "Whisper turbo" }, field: "wer" };
const source = (options: Record<string, unknown> = {}) => `:value${JSON.stringify({ ...mapping, ...options })}`;
const record = (id: string, value: DataRecord["value"] = { system: "Whisper turbo", wer: 10 }) => ({ id, value });
function snapshot(records: DataCollection["records"], invalidRecordIds: string[] = []): DocData {
  return { valid: true, bytes: 0, errors: [], collections: [{
    name: "results", schema: { version: 1, schema: { type: "object" } } as DataCollection["schema"],
    records, valid: invalidRecordIds.length === 0, invalidRecordIds, errors: [],
  }] };
}

describe("inline data value source", () => {
  it("recognizes adjacent complete objects without confusing string braces and escapes", () => {
    const first = source({ filter: { system: 'brace } and quote " and slash \\' } });
    const second = ":value{broken}";
    const text = `Before ${first}${second} after :value {`;
    expect(scanValueSources(text)).toEqual([
      { from: 7, to: 7 + first.length, source: first },
      { from: 7 + first.length, to: 7 + first.length + second.length, source: second },
    ]);
    expect(scanValueSources(':value{"filter":{"x":"}"}')).toEqual([]);
    const incomplete = ':value{"filter":{"x":"}"}';
    expect(scanValueSources(incomplete, { includeIncomplete: true })).toEqual([
      { from: 0, to: incomplete.length, source: incomplete },
    ]);
    const later = `:value{ unfinished then ${first}`;
    expect(scanValueSources(later)).toEqual([{ from: later.indexOf(first), to: later.length, source: first }]);
  });

  it("accepts only the required exact filter and the supported table formats and options", () => {
    expect(parseValueSource(source())).toEqual({ ok: true, config: { ...mapping, format: "text" } });
    for (const options of [
      { filter: { empty: "", number: 1, bool: false, null: null } },
      { format: "number", decimals: 0, unit: "%" }, { format: "number", decimals: 10 }, { format: "date" },
    ]) expect(parseValueSource(source(options)).ok).toBe(true);
    for (const options of [
      { filter: undefined }, { filter: {} }, { filter: null }, { filter: [] }, { filter: { x: [] } },
      { collection: "" }, { field: "" }, { format: null }, { format: "link" }, { label: "Name" },
      { version: 1 }, { bar: true }, { decimals: 1 }, { format: "date", unit: "days" },
      { format: "number", decimals: -1 }, { format: "number", decimals: 11 },
      { format: "number", decimals: 1.5 }, { format: "number", unit: 1 },
    ]) expect(parseValueSource(source(options)).ok, JSON.stringify(options)).toBe(false);
    expect(parseValueSource(':value{"collection":"results","filter":{"x":1e400},"field":"wer"}').ok).toBe(false);
    expect(parseValueSource(":value{broken}").ok).toBe(false);
    expect(parseValueSource(`${source()} trailing`).ok).toBe(false);
  });

  it("selects exactly one schema-valid record by every field's exact value and never by order", () => {
    const data = snapshot([
      record("wrong-type", { system: "Whisper turbo", active: "true", wer: 5 }),
      record("selected", { system: "Whisper turbo", active: true, wer: 10 }),
      record("invalid", { system: "Whisper turbo", active: true, wer: 20 }),
    ], ["invalid"]);
    const before = structuredClone(data);
    expect(prepareValue(source({ filter: { system: "Whisper turbo", active: true } }), data)).toMatchObject({ status: "ready", record: { id: "selected" } });
    expect(prepareValue(source({ filter: { system: "Whisper turbo", active: true } }), snapshot([...data.collections[0]!.records].reverse(), ["invalid"])))
      .toMatchObject({ status: "ready", record: { id: "selected" } });
    expect(data).toEqual(before);
    expect(prepareValue(source(), snapshot([record("a"), record("b")]))).toMatchObject({ status: "multiple-records" });
    expect(prepareValue(source(), snapshot([record("invalid")], ["invalid"]))).toMatchObject({ status: "no-records" });
    expect(prepareValue(source({ filter: { missing: null } }), snapshot([record("a")]))).toMatchObject({ status: "no-records" });
  });

  it("distinguishes unreadable source, missing and unusable collections, no match and several matches", () => {
    expect(prepareValue(":value{}", null).status).toBe("invalid-source");
    expect(prepareValue(source(), null).status).toBe("collection-absent");
    const unusable = snapshot([record("a")]);
    unusable.collections[0]!.schema = null as unknown as DataCollection["schema"];
    expect(prepareValue(source(), unusable).status).toBe("collection-unusable");
    expect(prepareValue(source(), snapshot([])).status).toBe("no-records");
    expect(prepareValue(source(), snapshot([record("a"), record("b")])).status).toBe("multiple-records");
    expect(prepareValue(source({ field: "absent" }), snapshot([record("a")]))).toMatchObject({ status: "ready", config: { field: "absent" } });
  });
});
