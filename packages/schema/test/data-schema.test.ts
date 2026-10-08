import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  DataError,
  assertJSON,
  canonicalJson,
  cloneJson,
  compareCodePoints,
  validateCollectionSchema,
  validateDataRecord,
} from "../src/data-schema.js";
import type { CollectionSchema, DataSchema, JSONValue } from "../src/data-schema.js";

function collection(schema: DataSchema): CollectionSchema {
  const value = { version: 1, schema: { type: "object", properties: { value: schema } } };
  validateCollectionSchema(value);
  return value;
}

function failure(action: () => void): DataError {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(DataError);
    return error as DataError;
  }
  throw new Error("Expected a data failure");
}

describe("closed document data schema vocabulary", () => {
  it.each([
    ["object", { nested: [true, null] }, []],
    ["array", [1, { a: false }], {}],
    ["string", "name", 1],
    ["number", 1.25, "1.25"],
    ["integer", 2, 2.5],
    ["boolean", false, 0],
    ["null", null, "null"],
  ] as const)("validates %s and its nullable form", (type, valid, invalid) => {
    const schema = collection({ type });
    expect(() => validateDataRecord({ value: valid }, schema)).not.toThrow();
    expect(failure(() => validateDataRecord({ value: invalid }, schema)).code).toBe("data_record_invalid");
    if (type !== "null") {
      for (const nullable of [[type, "null"], ["null", type]] as const) {
        const nullableSchema = collection({ type: nullable });
        expect(() => validateDataRecord({ value: null }, nullableSchema)).not.toThrow();
        expect(() => validateDataRecord({ value: valid }, nullableSchema)).not.toThrow();
        expect(() => validateDataRecord({ value: invalid }, nullableSchema)).toThrow();
      }
    }
  });

  it.each([
    [{ minimum: 2, maximum: 4 }, 2, 1, 5],
    [{ minLength: 1, maxLength: 2 }, "😀", "", "😀ab"],
    [{ minItems: 1, maxItems: 2 }, [null], [], [1, 2, 3]],
    [{ enum: ["minimum", null, false, 1] }, "minimum", "other", {}],
    [{ const: null }, null, false, "null"],
  ] as const)("applies scalar and length constraints %j", (rules, valid, low, high) => {
    const schema = collection(rules);
    expect(() => validateDataRecord({ value: valid }, schema)).not.toThrow();
    expect(() => validateDataRecord({ value: low }, schema)).toThrow();
    expect(() => validateDataRecord({ value: high }, schema)).toThrow();
  });

  it("validates object properties, required fields, additional properties and array items", () => {
    const schema = collection({
      type: "object",
      properties: { type: { type: "string", enum: ["minimum"] }, rows: {
        type: "array", items: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
      } },
      required: ["type", "rows"],
      additionalProperties: false,
    });
    expect(() => validateDataRecord({ value: { type: "minimum", rows: [{ count: 2 }] } }, schema)).not.toThrow();
    expect(failure(() => validateDataRecord({ value: { type: "minimum" } }, schema)).details.path).toBe("/value/rows");
    expect(failure(() => validateDataRecord({ value: { type: "minimum", rows: [], extra: true } }, schema)).details.path).toBe("/value/extra");
    expect(failure(() => validateDataRecord({ value: { type: "minimum", rows: [{ count: 1.5 }] } }, schema)).details.path).toBe("/value/rows/0/count");
    expect(() => validateDataRecord({ value: {} }, collection({ required: [] }))).not.toThrow();
    expect(() => validateDataRecord({ value: { extra: true } }, collection({}))).not.toThrow();
    expect(() => validateDataRecord({ value: {} }, collection({ additionalProperties: false }))).not.toThrow();
    expect(() => validateDataRecord({ value: { extra: true } }, collection({ additionalProperties: false }))).toThrow();
  });

  it("uses each keyword only for the instance types it constrains", () => {
    const schema = collection({ minimum: 2, minLength: 3, minItems: 2, required: ["name"] });
    for (const value of [null, false, 2, "abc", [1, 2], { name: "x" }]) {
      expect(() => validateDataRecord({ value }, schema)).not.toThrow();
    }
  });

  it.each([
    ["type", "any"], ["type", ["string"]], ["type", ["string", "integer"]],
    ["type", ["null", "null"]], ["type", ["string", "null", "number"]],
    ["properties", []], ["properties", { x: true }],
    ["required", "x"], ["required", [1]], ["required", ["x", "x"]],
    ["additionalProperties", true], ["additionalProperties", {}],
    ["items", []], ["items", false],
    ["enum", []], ["enum", ["x", "x"]], ["enum", [0, -0]], ["enum", [{}]], ["enum", "x"],
    ["const", []], ["const", {}],
    ["minimum", "1"], ["maximum", null],
    ["minLength", -1], ["maxLength", 1.5], ["minItems", "1"], ["maxItems", null],
  ])("refuses malformed %s at its schema path", (keyword, value) => {
    const error = failure(() => validateCollectionSchema({
      version: 1, schema: { type: "object", properties: { child: { [keyword]: value } } },
    }));
    expect(error.code).toBe("data_schema_invalid");
    expect(error.details.path).toBe(keyword === "properties" && !Array.isArray(value)
      ? "/schema/properties/child/properties/x" : `/schema/properties/child/${keyword}`);
  });

  it.each(["$ref", "allOf", "oneOf", "if", "format", "pattern", "uniqueItems", "contains", "minProperties"])(
    "rejects unsupported %s in nested schemas without confusing property names", (keyword) => {
      const error = failure(() => validateCollectionSchema({ version: 1, schema: {
        type: "object", properties: { [keyword]: { items: { [keyword]: true } } },
      } }));
      expect(error.details.path).toBe(`/schema/properties/${keyword}/items/${keyword}`);
      expect(() => collection({ properties: { [keyword]: { type: "string" } } })).not.toThrow();
    },
  );

  it("reports unsupported versions, closed envelopes and root types", () => {
    expect(failure(() => validateCollectionSchema({ version: 2, schema: { type: "object" } })).details.path).toBe("/version");
    expect(failure(() => validateCollectionSchema({ schema: { type: "object" } })).details.path).toBe("/version");
    expect(failure(() => validateCollectionSchema({ version: 1, schema: { type: "object" }, extra: 1 })).details.path).toBe("/extra");
    for (const schema of [{}, { type: "array" }, { type: ["object", "null"] }]) {
      expect(failure(() => validateCollectionSchema({ version: 1, schema })).details.path).toBe("/schema/type");
    }
    const schema = collection({});
    for (const record of [[], null, "text", 1, false]) {
      expect(failure(() => validateDataRecord(record, schema)).code).toBe("data_record_invalid");
    }
  });

  it("escapes schema and record paths consistently", () => {
    const name = "a/b~c";
    const malformed = failure(() => validateCollectionSchema({
      version: 1, schema: { type: "object", properties: { [name]: { format: "date" } } },
    }));
    expect(malformed.details.path).toBe("/schema/properties/a~1b~0c/format");
    const schema = { version: 1, schema: { type: "object", properties: { [name]: { type: "integer" } } } };
    validateCollectionSchema(schema);
    expect(failure(() => validateDataRecord({ [name]: "wrong" }, schema)).details.path).toBe("/a~1b~0c");
  });
});

describe("plain canonical JSON", () => {
  it("detaches records, sorts keys by Unicode code point and preserves safe property names", () => {
    const original = JSON.parse('{"😀":2,"\\ue000":1,"nested":{"b":2,"a":[true]},"prototype":{"constructor":"__proto__"}}') as JSONValue;
    const copy = cloneJson(original);
    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
    expect(Object.hasOwn(copy as object, "prototype")).toBe(true);
    expect(canonicalJson(original)).toBe('{"nested":{"a":[true],"b":2},"prototype":{"constructor":"__proto__"},"\ue000":1,"😀":2}');
    expect(compareCodePoints("\ue000", "😀")).toBe(-1);
    expect(compareCodePoints("a", "ab")).toBe(-1);
    expect(compareCodePoints("ab", "a")).toBe(1);
    expect(compareCodePoints("same", "same")).toBe(0);
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(canonicalJson(-0)).toBe("0");
  });

  it.each([
    [JSON.parse('{"__proto__":1}'), "/__proto__"],
    [{ constructor: "text" }, "/constructor"],
    [JSON.parse('{"nested":[{"__proto__":{"x":1}}]}'), "/nested/0/__proto__"],
    [{ nested: ["\uD800"] }, "/nested/0"],
    [{ nested: ["\uDC00"] }, "/nested/0"],
    [{ nested: { "a/~\uD800": true } }, "/nested/a~1~0\uD800"],
    [{ nested: { "a/~\uDC00": true } }, "/nested/a~1~0\uDC00"],
  ])("rejects JSON that Yjs cannot preserve: %j", (value, path) => {
    expect(failure(() => assertJSON(value))).toMatchObject({
      code: "data_invalid_input", details: { path },
    });
  });

  it("rejects lossy JSON input and live shared types", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = new Array(2);
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { throw new Error("must not call"); } });
    const symbol = { [Symbol("value")]: true };
    for (const value of [undefined, NaN, Infinity, -Infinity, 1n, () => true,
      { value: undefined }, new Date(), new Y.Map(), cyclic, sparse, accessor, symbol]) {
      expect(failure(() => assertJSON(value)).code).toBe("data_invalid_input");
    }
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { okay: true });
    expect(canonicalJson(nullPrototype)).toBe('{"okay":true}');
    expect(failure(() => validateCollectionSchema({ version: 1, schema: { type: "object", minimum: NaN } })).code).toBe("data_schema_invalid");
    expect(failure(() => validateDataRecord({ value: undefined }, collection({}))).code).toBe("data_record_invalid");
  });

  it("bounds container depth independently for each record and schema", () => {
    let record: JSONValue = {};
    for (let depth = 1; depth < 32; depth += 1) record = { nested: record };
    expect(() => assertJSON(record)).not.toThrow();
    const error = failure(() => assertJSON({ nested: record }));
    expect(error.code).toBe("data_limit_exceeded");
    expect(error.details).toMatchObject({ limit: "nesting_depth", value: 32, attempted: 33 });
    expect(() => canonicalJson({ envelope: record }, Infinity)).not.toThrow();

    let schema: DataSchema = { type: "string" };
    for (let depth = 1; depth < 29; depth += 1) schema = { items: schema };
    expect(() => collection(schema)).not.toThrow();
    const schemaError = failure(() => collection({ items: schema }));
    expect(schemaError.code).toBe("data_limit_exceeded");
    expect(schemaError.details).toMatchObject({ limit: "nesting_depth", value: 32, attempted: 33 });
  });
});
