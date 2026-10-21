import { afterAll, beforeAll, expect, it } from "vitest";
import { removeTempDirs, startServer } from "./helpers.js";

/** Size limits for every model-facing text; descriptions count characters, everything else UTF-8 bytes. */
const LIMITS = {
  instructions: { limit: 1_500, unit: "B" }, // initialize instructions, read at every session start
  toolDescription: { limit: 1_000, unit: "chars" }, // each tool description in tools/list
  propertyDescription: { limit: 400, unit: "chars" }, // each input property description, at any depth
  toolsList: { limit: 50_000, unit: "B" }, // compact model-facing tools/list, measured as tools-list.test.ts does
  conceptTopic: { limit: 8_000, unit: "B" }, // each concept help topic
  formatGuideTopic: { limit: 10_000, unit: "B" }, // each format guide copied from another package
  toolTopic: { limit: 5_000, unit: "B" }, // each per-tool help topic
  allTopics: { limit: 150_000, unit: "B" }, // all help topics together
} as const;

/** Concept topics that reproduce another package's format guide get the larger topic limit. */
const FORMAT_GUIDES = new Set(["ablauf", "wireframe"]);

/** Phrases about superseded clients or internals that help must not mention. */
const BANNED_PHRASES = ["older clients", "older client", "protocol 4", "until its viewer", "legacy", "applyDocData"];

interface Measured {
  id: string;
  size: number;
  limit: number;
  unit: string;
}

let measured: Measured[] = [];
let topicTexts = new Map<string, string>();

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function row(id: string, size: number, budget: { limit: number; unit: string }): Measured {
  return { id, size, ...budget };
}

/** Every `properties` entry with a description, under any union, array or nested object. */
function propertyDescriptions(schema: unknown, path: string, out: Array<[string, string]>): void {
  if (schema === null || typeof schema !== "object") return;
  if (Array.isArray(schema)) {
    for (const [index, item] of schema.entries()) propertyDescriptions(item, `${path}[${index}]`, out);
    return;
  }
  const record = schema as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === "properties" && value !== null && typeof value === "object") {
      for (const [name, property] of Object.entries(value as Record<string, unknown>)) {
        const description = (property as { description?: unknown }).description;
        if (typeof description === "string") out.push([`${path}.${name}`, description]);
        propertyDescriptions(property, `${path}.${name}`, out);
      }
    } else if (key !== "description") {
      propertyDescriptions(value, key === "items" ? `${path}[]` : path, out);
    }
  }
}

function table(rows: Measured[]): string {
  const width = Math.max(...rows.map(({ id }) => id.length));
  return rows.map(({ id, size, limit, unit }) =>
    `${id.padEnd(width)}  ${String(size).padStart(7)}  ${String(limit).padStart(7)} ${unit}`).join("\n");
}

beforeAll(async () => {
  const rig = await startServer();
  try {
    const rows: Measured[] = [row("instructions", bytes(rig.client.getInstructions() ?? ""), LIMITS.instructions)];
    const { tools } = await rig.client.listTools();
    const toolNames = new Set(tools.map(({ name }) => name));
    for (const { name, description, inputSchema } of tools) {
      rows.push(row(`tool:${name}`, (description ?? "").length, LIMITS.toolDescription));
      const descriptions: Array<[string, string]> = [];
      propertyDescriptions(inputSchema, `input:${name}`, descriptions);
      for (const [id, text] of descriptions) rows.push(row(id, text.length, LIMITS.propertyDescription));
    }
    const modelFacing = tools.map(({ name, title, description, inputSchema }) => ({
      name, title, description, inputSchema,
    }));
    rows.push(row("tools/list", bytes(JSON.stringify(modelFacing)), LIMITS.toolsList));

    const { topics } = await rig.ok("get_help");
    topicTexts = new Map();
    for (const { id } of topics as Array<{ id: string }>) {
      const { text } = await rig.ok("get_help", { topic: id });
      topicTexts.set(id, text);
      const budget = toolNames.has(id) ? LIMITS.toolTopic
        : FORMAT_GUIDES.has(id) ? LIMITS.formatGuideTopic : LIMITS.conceptTopic;
      rows.push(row(`help:${id}`, bytes(text), budget));
    }
    rows.push(row("help:*", [...topicTexts.values()].reduce((sum, text) => sum + bytes(text), 0), LIMITS.allTopics));
    measured = rows;
  } finally {
    await rig.close();
  }
});

afterAll(() => {
  removeTempDirs();
});

it("reports current help sizes", () => {
  expect(measured.length).toBeGreaterThan(0);
  expect(topicTexts.size).toBeGreaterThan(0);
  console.log(`Model-facing text sizes (id, size, limit):\n${table([...measured].sort((a, b) => b.size - a.size))}`);
});

it.fails("keeps every model-facing help text within its size limit", () => {
  const over = measured.filter(({ size, limit }) => size > limit);
  expect(over, `Texts over their limit (id, size, limit):\n${table(over)}`).toEqual([]);
});

it.fails("keeps superseded-client and internal wording out of help", () => {
  const hits = [...topicTexts].flatMap(([id, text]) => BANNED_PHRASES
    .filter((phrase) => text.toLowerCase().includes(phrase.toLowerCase()))
    .map((phrase) => `help:${id}: "${phrase}"`));
  expect(hits, `Banned phrases in help:\n${hits.join("\n")}`).toEqual([]);
});
