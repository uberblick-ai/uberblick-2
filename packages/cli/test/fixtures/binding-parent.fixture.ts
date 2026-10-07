import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, inject, it } from "vitest";

// Selected only by helpers.test.ts's child runs, never by the ordinary suite.
it("leaves parent unchanged", () => {
  expect(readFileSync(join(inject("boundFixtureRoot"), ".uberblick.json")).length).toBeGreaterThan(0);
});

it("changes parent bytes without changing JSON meaning", () => {
  const path = join(inject("boundFixtureRoot"), ".uberblick.json");
  const before = JSON.parse(readFileSync(path, "utf8"));
  appendFileSync(path, "\n");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(before);
});
