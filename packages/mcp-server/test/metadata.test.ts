/** Combined metadata writes retain the field rules and refuse before mutation. */

import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { setTldrOptOut } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { removeTempDirs, startServer, testConfig } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const DESCRIPTION = "Metadata contract fixture.";

async function localRig(): Promise<Rig> {
  const rig = await startServer(testConfig());
  rigs.push(rig);
  return rig;
}

async function document(rig: Rig, fields: Record<string, unknown> = {}) {
  return rig.ok("create_doc", {
    title: "Metadata fixture",
    description: DESCRIPTION,
    blocks: [{ type: "paragraph", text: "metadata aardvark" }],
    ...fields,
  });
}

/** Exactly the read-back fields set_metadata promises, including absent values. */

/** Both authoritative rooms and the durable log must survive a refusal intact. */
function state(rig: Rig, uuid?: string) {
  return {
    directory: Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc),
    ...(uuid === undefined
      ? {}
      : { document: Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc) }),
    log: rig.instance.store.logSize(),
    index: rig.instance.store.search("aardvark", 10),
  };
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(removeTempDirs);

describe("set_metadata", () => {

  it("requires a valid non-null summary whenever the opt-in flag is present, before mutation", async () => {
    const rig = await localRig();
    const source = await document(rig);
    setTldrOptOut(rig.instance.replicas.replica(source.uuid).doc, true);
    for (const flag of [true, false]) {
      for (const tldr of [undefined, null, "", "   "]) {
        const before = state(rig, source.uuid);
        const refused = await rig.call("set_metadata", {
          uuid: source.uuid, title: "Must stay unchanged", tldr_opt_in: flag,
          ...(tldr === undefined ? {} : { tldr }),
        });
        expect(refused).toMatchObject({ isError: true, payload: { error: "schema_validation" } });
        expect(state(rig, source.uuid)).toEqual(before);
      }
    }
    const unknownMark = await rig.call("set_metadata", { uuid: source.uuid, tldrOptOut: true });
    expect(unknownMark).toMatchObject({ isError: true, payload: { error: "schema_validation" } });
    const { tools } = await rig.client.listTools();
    const schema = tools.find(({ name }) => name === "set_metadata")?.inputSchema as any;
    expect(schema.properties.tldr_opt_in.type).toBe("boolean");
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    for (const flag of [true, false]) {
      for (const tldr of [undefined, null, ""]) {
        expect(validate({ uuid: source.uuid, title: "Rename", tldr_opt_in: flag,
          ...(tldr === undefined ? {} : { tldr }),
        }).valid).toBe(false);
      }
      expect(validate({ uuid: source.uuid, tldr: "New summary.", tldr_opt_in: flag }).valid).toBe(true);
    }
  });

  it("advertises and enforces a non-empty strict subset before any mutation", async () => {
    const rig = await localRig();
    const source = await document(rig);
    const { tools } = await rig.client.listTools();
    const schema = tools.find(({ name }) => name === "set_metadata")?.inputSchema as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["uuid"]);
    expect(schema.anyOf).toEqual([
      { required: ["title"] },
      { required: ["description"] },
      { required: ["tldr"] },
      { required: ["tags"] },
      { required: ["links"] },
      { required: ["discussion"] },
    ]);
    const before = state(rig, source.uuid);
    const empty = await rig.call("set_metadata", { uuid: source.uuid });
    expect(empty.payload.error).toBe("schema_validation");
    for (const [field, value] of [
      ["changelog_suggestion", "Unsupported suggestion"],
      ["titel", "Misspelled title"],
    ] as const) {
      const refused = await rig.call("set_metadata", {
        uuid: source.uuid,
        description: "This valid field must not be written.",
        [field]: value,
      });
      expect(refused.isError).toBe(true);
      expect(refused.payload.error).toBe("schema_validation");
      expect(refused.payload.message).toContain(field);
    }
    // A bad named field must also stop individually valid fields at the input
    // boundary. The exhaustive limits remain in the existing field suites.
    for (const field of ["title", "description"]) {
      for (const value of ["", "   ", null]) {
        const refused = await rig.call("set_metadata", {
          uuid: source.uuid,
          tldr: "Must not be written.",
          [field]: value,
        });
        expect(refused.isError).toBe(true);
        expect(refused.payload.error).toBe("schema_validation");
        expect(refused.payload.message).toContain(field);
      }
    }
    expect(state(rig, source.uuid)).toEqual(before);
  });

});
