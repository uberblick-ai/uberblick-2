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
