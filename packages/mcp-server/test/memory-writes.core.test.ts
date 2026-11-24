import { getDirectoryEntry } from "@uberblick/schema";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { startServer } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

let rig: Rig | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });

const description = "A reusable agent observation.";
const scope = { agent: "implementer", repository: "uberblick-ai/uberblick-2" };

function state(rig: Rig, uuid?: string) {
  return {
    directory: Y.encodeStateAsUpdate(rig.instance.replicas.directory().doc),
    sidebar: Y.encodeStateAsUpdate(rig.instance.replicas.sidebar().doc),
    ...(uuid === undefined ? {} : { document: Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc) }),
    log: rig.instance.store.logSize(),
    index: rig.instance.store.search("observation", 100),
  };
}

async function refuseUnchanged(rig: Rig, tool: string, args: Record<string, unknown>, error: string, uuid?: string) {
  const before = state(rig, uuid);
  const refused = await rig.call(tool, args);
  expect(refused).toMatchObject({ isError: true, payload: {
    error, applied: false, partial: false, synced: false,
    recoveryClass: "manual", recovery: expect.any(String),
  } });
  expect(state(rig, uuid)).toEqual(before);
  return refused.payload;
}

describe("memory writes", () => {
  it("creates memories with either scope independently and makes normalized scope immediately discoverable", async () => {
    rig = await startServer();
    for (const fields of [{}, { agent: scope.agent }, { repository: "Uberblick-AI/Uberblick-2" }, { agent: scope.agent, repository: "Uberblick-AI/Uberblick-2" }]) {
      const written = await rig.ok("create_doc", {
        title: "Observed behavior", description, kind: "memory", ...fields,
        blocks: [{ type: "paragraph", text: "Keep this observation." }],
      });
      const expected = {
        uuid: written.uuid, kind: "memory", title: "Observed behavior", description,
        ...("agent" in fields ? { agent: scope.agent } : {}),
        ...("repository" in fields ? { repository: scope.repository } : {}),
      };
      expect(written).toMatchObject({ ...expected, applied: true });
      expect(written).not.toHaveProperty("status");
      const read = await rig.ok("get_doc", { uuid: written.uuid });
      expect(read).toMatchObject(expected);
      expect(read).not.toHaveProperty("status");
      expect(getDirectoryEntry(rig.instance.replicas.directory().doc, written.uuid)).toMatchObject(expected);
      const row = (await rig.ok("get_memories", scope)).memories.find((memory: any) => memory.uuid === written.uuid);
      expect(row).toMatchObject({ uuid: written.uuid, title: expected.title, description });
      if ("agent" in fields) expect(row.agent).toBe(scope.agent);
      else expect(row).not.toHaveProperty("agent");
      if ("repository" in fields) expect(row.repository).toBe(scope.repository);
      else expect(row).not.toHaveProperty("repository");
    }
  });

  it("sets each scope and clears it with blank strings or null without losing unnamed fields", async () => {
    rig = await startServer();
    const created = await rig.ok("create_doc", { title: "Memory observation", description, kind: "memory" });
    const uuid = created.uuid;
    const written = await rig.ok("set_metadata", { uuid, agent: scope.agent, repository: "Uberblick-AI/Uberblick-2" });
    expect(written).toMatchObject({ uuid, kind: "memory", ...scope, applied: true });
    expect((await rig.ok("get_memories", scope)).memories).toEqual([expect.objectContaining({ uuid, ...scope })]);
    expect((await rig.ok("get_memories", { agent: "reviewer", repository: scope.repository })).memories).toEqual([]);
    await rig.ok("set_metadata", { uuid, agent: "reviewer" });
    expect(await rig.ok("get_doc", { uuid })).toMatchObject({ agent: "reviewer", repository: scope.repository });

    for (const clear of ["", "   ", null]) {
      await rig.ok("set_metadata", { uuid, ...scope });
      const clearedAgent = await rig.ok("set_metadata", { uuid, agent: clear });
      expect(clearedAgent).not.toHaveProperty("agent");
      expect(clearedAgent.repository).toBe(scope.repository);
      const cleared = await rig.ok("set_metadata", { uuid, repository: clear });
      expect(cleared).not.toHaveProperty("repository");
      const read = await rig.ok("get_doc", { uuid });
      expect(read).toMatchObject({ title: "Memory observation", description, kind: "memory" });
      expect(read).not.toHaveProperty("agent");
      expect(read).not.toHaveProperty("repository");
      const row = (await rig.ok("get_memories", { agent: "reviewer", repository: "another/repository" })).memories[0];
      expect(row.uuid).toBe(uuid);
      expect(row).not.toHaveProperty("agent");
      expect(row).not.toHaveProperty("repository");
    }
  });

  it("refuses malformed scope before creating a room or changing any accepted metadata", async () => {
    rig = await startServer();
    const memory = await rig.ok("create_doc", { title: "Memory observation", description, kind: "memory", ...scope });
    for (const [field, values] of [
      ["agent", ["Implementer", " implementer", "implementer ", 17, {}, []]],
      ["repository", ["https://github.com/owner/repo", "owner/repo/extra", " owner/repo", "owner", 17, {}, []]],
    ] as const) {
      for (const value of values) {
        const fields = { [field]: value };
        expect((await refuseUnchanged(rig, "create_doc", {
          title: "Must not exist", description, kind: "memory", ...fields,
        }, `invalid_memory_${field}`)).field).toBe(field);
        expect((await refuseUnchanged(rig, "set_metadata", {
          uuid: memory.uuid, title: "Must not change", ...fields,
        }, `invalid_memory_${field}`, memory.uuid)).field).toBe(field);
      }
      await refuseUnchanged(rig, "create_doc", {
        title: "Must not exist", description, kind: "memory", [field]: null,
      }, `invalid_memory_${field}`);
    }
  });

  it("refuses memory scope on regular pages and decisions and decision fields on memories atomically", async () => {
    rig = await startServer();
    for (const kind of [undefined, "decision"] as const) {
      for (const fields of [{ agent: scope.agent }, { repository: scope.repository }]) {
        const base = { title: "Ordinary observation", description, ...(kind === undefined ? {} : { kind }) };
        await refuseUnchanged(rig, "create_doc", { ...base, ...fields }, "memory_scope_unsupported");
        const document = await rig.ok("create_doc", base);
        await refuseUnchanged(rig, "set_metadata", {
          uuid: document.uuid, title: "Must not change", ...fields,
        }, "memory_scope_unsupported", document.uuid);
      }
    }
    for (const field of ["status", "related", "supersedes", "discussion", "answer"] as const) {
      const value = field === "status" ? "open" : field === "answer" ?
        { who: "A maintainer", when: "2026-11-24T12:00:00Z", where: "A review" } : randomUUID();
      const refused = await refuseUnchanged(rig, "create_doc", {
        title: "Must not exist", description, kind: "memory", ...scope, [field]: value,
      }, "memory_field_unsupported");
      expect(refused.field).toBe(field);
    }
    const memory = await rig.ok("create_doc", { title: "Memory observation", description, kind: "memory", ...scope });
    await refuseUnchanged(rig, "set_metadata", {
      uuid: memory.uuid, title: "Must not change", agent: "reviewer", discussion: null,
    }, "discussion_not_writable", memory.uuid);
  });
});
