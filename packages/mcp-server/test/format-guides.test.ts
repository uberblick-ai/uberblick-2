import { render as renderAblauf } from "@uberblick/ablauf";
import { parseWireframe } from "@uberblick/wireframe";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, expect, it } from "vitest";
// @ts-expect-error The sync script is plain JavaScript run by node.
import { render as renderGuides } from "../scripts/sync-format-guides.mjs";
import { FORMAT_GUIDES } from "../src/generated/format-guides.js";
import { removeTempDirs, startServer } from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});
afterAll(() => removeTempDirs());

const FLOW = "flow v0\ncolumns main\nbox draft\nbox review\nend done\ndraft --> review\nreview --> done";

it("serves the guide of the installed format version, regenerated when a package moves", () => {
  // Fails after a catalog bump until `node scripts/sync-format-guides.mjs` runs.
  const generated = readFileSync(new URL("../src/generated/format-guides.ts", import.meta.url), "utf8");
  expect(generated).toBe(renderGuides());
  for (const guide of Object.values(FORMAT_GUIDES)) {
    expect(guide.url).toContain(`/blob/v${guide.version}/`);
  }
});

it("keeps every example in the served guides free of renderer problems", () => {
  const check = { ablauf: (source: string) => renderAblauf(source).diagnostics, wireframe: (source: string) => parseWireframe(source).diagnostics };
  for (const [format, guide] of Object.entries(FORMAT_GUIDES)) {
    const examples = [...guide.text.matchAll(new RegExp(`\`\`\`(?:${format})?\\n([\\s\\S]*?)\\n\`\`\``, "g"))]
      .map((match) => match[1]!)
      .filter((source) => format === "wireframe" || /^(flow|fan-out) v0/.test(source));
    expect(examples.length, format).toBeGreaterThan(0);
    for (const source of examples) {
      expect(check[format as keyof typeof check](source).filter(({ severity }) => severity === "error"), `${format}:\n${source}`).toEqual([]);
    }
  }
});

it("returns renderer diagnostics from writes without refusing them", async () => {
  const rig = await startServer();
  rigs.push(rig);
  const created = await rig.ok("create_doc", {
    title: "Release flow",
    description: "The release process as a diagram.",
    blocks: [{ type: "code", language: "ablauf", text: FLOW }],
  });
  expect(created.diagnostics).toBeUndefined();

  const broken = await rig.ok("insert_block", {
    uuid: created.uuid, after_block_id: created.blocks[0].id, type: "code", language: "ablauf",
    text: `${FLOW}\nreview --> merge`,
  });
  expect(broken.applied).toBe(true);
  expect(broken.diagnostics).toEqual([expect.objectContaining({ block: broken.block.id, format: "ablauf", line: 8, severity: "error" })]);

  const fixed = await rig.ok("edit_block", {
    uuid: created.uuid, block_id: broken.block.id, old_text: broken.block.text, new_text: FLOW,
  });
  expect(fixed.diagnostics).toBeUndefined();

  const sketch = await rig.ok("insert_block", {
    uuid: created.uuid, type: "code", language: "wireframe", text: "page\n  row\n    row.end\n      button Save",
  });
  expect(sketch.diagnostics?.length).toBeGreaterThan(0);
  expect(sketch.diagnostics.every(({ format }: { format: string }) => format === "wireframe")).toBe(true);
});

it("serves each format topic with its version and source link", async () => {
  const rig = await startServer();
  rigs.push(rig);
  for (const [format, guide] of Object.entries(FORMAT_GUIDES)) {
    const { text } = await rig.ok("get_help", { topic: format });
    expect(text).toContain(`${guide.name} ${guide.version}`);
    expect(text).toContain(guide.url);
    expect(text).toContain("diagnostics");
  }
});
