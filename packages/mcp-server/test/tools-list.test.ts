import { readFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { removeTempDirs, startServer } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

it("preserves the complete ordered tools/list contract", async () => {
  // Keep result schemas and display names reviewable beside the arguments and
  // descriptions. Includes the four sidebar tools.
  const baseline = JSON.parse(
    readFileSync(new URL("./fixtures/tools-list.json", import.meta.url), "utf8"),
  );
  const rig = await startServer();
  try {
    const { tools } = await rig.client.listTools();
    expect(
      tools.map(({ name, title, inputSchema, outputSchema, description }) => ({
        name,
        title,
        inputSchema,
        outputSchema,
        description,
      })),
    ).toEqual(baseline);
  } finally {
    await rig.close();
  }
});

it("keeps the model-facing tool catalog within its byte and description budgets", async () => {
  const rig = await startServer();
  try {
    const { tools } = await rig.client.listTools();
    for (const { name, description } of tools) {
      expect(description, `${name} has no tool-specific description`).toBeDefined();
      expect(description!.length, `${name} exceeds the description character budget`).toBeLessThanOrEqual(1_500);
    }
    // Output schemas and SDK metadata are outside the model-facing budget.
    // Measure UTF-8 compact JSON, not pretty JSON or JavaScript string length.
    const modelFacing = tools.map(({ name, title, description, inputSchema }) => ({
      name, title, description, inputSchema,
    }));
    expect(Buffer.byteLength(JSON.stringify(modelFacing), "utf8")).toBeLessThanOrEqual(60_000);
  } finally {
    await rig.close();
  }
});

it("ends each tool-specific description with one complete, resolvable help pointer", async () => {
  const rig = await startServer();
  try {
    const { tools } = await rig.client.listTools();
    const { topics } = await rig.ok("get_help");
    const ids = new Set(topics.map(({ id }: { id: string }) => id));
    const sentences = new Map<string, string>();
    for (const { name, description } of tools) {
      const lines = description!.split("\n");
      const pointer = lines.at(-1)!;
      expect(pointer, name).toMatch(/^Help: [a-z_-]+(?:, [a-z_-]+)*\.$/);
      expect(lines.filter((line) => line.startsWith("Help:")), name).toHaveLength(1);
      const owned = pointer.slice("Help: ".length, -1).split(", ");
      expect(owned[0], name).toBe(name);
      expect(owned, name).toContain("tool-contracts");
      expect(new Set(owned).size, name).toBe(owned.length);
      for (const id of owned) {
        expect(ids.has(id), `${name} points to missing help topic ${id}`).toBe(true);
      }
      const { text } = await rig.ok("get_help", { topic: name });
      const related = text.split("## Related\n")[1] ?? "";
      const linked = [...related.matchAll(/uberblick:\/\/help\/([a-z_-]+)/g)].map((match) => match[1]);
      expect(owned.slice(1), `${name}'s pointer omits or adds an owning concept`).toEqual(linked);

      // A pointer may repeat, but prose explaining a shared rule must have
      // one owner. Detect repeated sentences as well as repeated paragraphs.
      const contract = lines.slice(0, -1).join("\n").trim();
      expect(contract.length, `${name} has only a help pointer`).toBeGreaterThan(0);
      for (const sentence of contract.split(/(?<=[.!?])\s+/)) {
        const normalized = sentence.replace(/\s+/g, " ").trim();
        if (sentences.get(normalized) === name) continue;
        expect(sentences.get(normalized), `${name} repeats prose from ${sentences.get(normalized)}: ${normalized}`)
          .toBeUndefined();
        sentences.set(normalized, name);
      }
    }
  } finally {
    await rig.close();
  }
});
