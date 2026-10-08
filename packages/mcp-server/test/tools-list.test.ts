import { readFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { removeTempDirs, startServer } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

it("preserves the complete ordered tools/list contract", async () => {
  // Recorded from main at 9082eb6ce1503359c2e7a05b465480795771d37d before
  // extracting the inline registrations. Includes the four sidebar tools.
  const baseline = JSON.parse(
    readFileSync(new URL("./fixtures/tools-list.json", import.meta.url), "utf8"),
  );
  const rig = await startServer();
  try {
    const { tools } = await rig.client.listTools();
    expect(
      tools.map(({ name, inputSchema, description }) => ({
        name,
        inputSchema,
        description,
      })),
    ).toEqual(baseline);
  } finally {
    await rig.close();
  }
});
