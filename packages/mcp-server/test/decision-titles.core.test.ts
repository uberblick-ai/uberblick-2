import { getDirectoryEntry, getDirectoryMap, getMeta, setTitle } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { removeTempDirs, startServer, testConfig } from "./core-helpers.js";
import type { Rig } from "./core-helpers.js";

const rigs: Rig[] = [];
const answer = { who: "A workspace member", when: "2026-10-20T12:00:00Z", where: "A team discussion" };
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
afterAll(removeTempDirs);

async function assertReadTitles(rig: Rig, records: string[], page: string, title: string): Promise<void> {
  for (const uuid of records) {
    const read = await rig.ok("get_doc", { uuid });
    expect(read.title).toBe(title);
    const entries = [read.resolution, read.resolution.inForce, ...read.resolution.pending, ...read.resolution.conflicts, ...read.predecessors, ...read.successors];
    for (const entry of entries) if (entry !== null) expect(entry.title).toBe(title);
    expect((await rig.ok("export_markdown", { uuid })).markdown).toContain(`title: ${title}\n`);
  }
  const topics = (await rig.ok("list_docs", { kind: "decision" })).docs;
  const rows = (await rig.ok("list_docs", { kind: "decision", include_superseded: true })).docs;
  expect(rows.map((row: { uuid: string }) => row.uuid).sort()).toEqual([...records].sort());
  const related = (await rig.ok("get_doc", { uuid: page })).decisions;
  for (const topic of [...topics, ...related]) {
    for (const entry of [topic, topic.inForce, ...topic.pending, ...topic.conflicts]) {
      if (entry !== null) expect(entry.title).toBe(title);
    }
  }
  for (const row of rows) expect(row.title).toBe(title);
  expect((await rig.ok("export_markdown", { uuid: page })).markdown).toContain(`— ${title} —`);
  for (const [name, result] of [
    ["search", (await rig.ok("search", { query: "Evidence", kind: "decision", limit: 100 })).hits],
    ["find_decisions", (await rig.ok("find_decisions", { github_ref: "owner/repo#42" })).decisions],
    ["backlinks", (await rig.ok("backlinks", { uuid: page })).backlinks],
  ]) {
    expect(result.map((row: { uuid: string }) => row.uuid).sort(), name).toEqual([...records].sort());
    for (const row of result) expect(row.title).toBe(title);
  }
  const pins = (await rig.ok("get_sidebar")).groups.flatMap((group: { docs: unknown[] }) => group.docs);
  expect(pins).toHaveLength(records.length);
  for (const pin of pins) expect(pin.title).toBe(title);
}

describe("one decision topic title across MCP reads", () => {
  it("projects the first title through divergent records, partial tombstones, renames and conflicts", async () => {
    const rig = await startServer(testConfig());
    rigs.push(rig);
    const page = await rig.ok("create_doc", { title: "Owning page", description: "Related context." });
    const seed = {
      description: "An answer in the same topic.", kind: "decision", related: page.uuid,
      blocks: [{ type: "paragraph", text: "", inline: [
        { text: "Evidence ", marks: { link: "https://github.com/owner/repo/issues/42" } },
        { text: "Owning page", marks: { docLink: page.uuid } },
      ] }],
    };
    const first = await rig.ok("create_doc", { ...seed, title: "Original compass", status: "decided", answer });
    const current = await rig.ok("create_doc", { ...seed, supersedes: first.uuid, status: "decided", answer });
    const pending = await rig.ok("create_doc", { ...seed, supersedes: current.uuid });
    const rejected = await rig.ok("create_doc", { ...seed, supersedes: current.uuid });
    const withdrawn = await rig.ok("create_doc", { ...seed, supersedes: current.uuid });
    await rig.ok("set_status", { uuid: rejected.uuid, status: "rejected", answer, reason: "Another answer won." });
    await rig.ok("set_status", { uuid: withdrawn.uuid, status: "withdrawn" });
    const records = [first, current, pending, rejected, withdrawn].map(record => record.uuid as string);
    for (const uuid of records) {
      if (uuid !== first.uuid) setTitle(rig.instance.replicas.replica(uuid).doc, `Ignored ${uuid}`);
      await rig.ok("pin_doc", { uuid, group: "Decisions" });
    }
    const directory = rig.instance.replicas.directory().doc;
    getDirectoryMap(directory).set(pending.uuid, { ...getDirectoryEntry(directory, pending.uuid), deleted: true });
    await assertReadTitles(rig, records, page.uuid, "Original compass");
    await rig.ok("set_metadata", { uuid: rejected.uuid, title: "Unified beacon" });
    await assertReadTitles(rig, records, page.uuid, "Unified beacon");
    for (const uuid of records) {
      expect(getMeta(rig.instance.replicas.replica(uuid).doc).title).toBe(uuid === first.uuid ? "Unified beacon" : `Ignored ${uuid}`);
    }
    await rig.ok("set_status", { uuid: pending.uuid, status: "decided", answer });
    const other = await rig.ok("create_doc", { ...seed, supersedes: current.uuid, status: "decided", answer });
    records.push(other.uuid);
    await rig.ok("pin_doc", { uuid: other.uuid, group: "Decisions" });
    await assertReadTitles(rig, records, page.uuid, "Unified beacon");
    expect((await rig.ok("get_doc", { uuid: first.uuid })).resolution.conflicts).toHaveLength(2);
    await rig.ok("archive_doc", { uuid: current.uuid });
    const archived = (await rig.ok("list_docs", { kind: "decision", include_superseded: true, include_deleted: true })).docs;
    expect(archived).toHaveLength(records.length);
    for (const row of archived) expect(row).toMatchObject({ title: "Unified beacon", deleted: true });
    for (const uuid of records) {
      expect(await rig.ok("get_doc", { uuid })).toMatchObject({ title: "Unified beacon", resolution: { archived: true } });
      expect((await rig.ok("export_markdown", { uuid })).markdown).toContain("title: Unified beacon\n");
      await rig.ok("pin_doc", { uuid, group: "Archived decisions" });
    }
    const pins = (await rig.ok("get_sidebar")).groups.flatMap((group: { docs: unknown[] }) => group.docs);
    expect(pins).toHaveLength(records.length);
    for (const pin of pins) expect(pin).toMatchObject({ title: "Unified beacon", status: "archived" });
  });
});
