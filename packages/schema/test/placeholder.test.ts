import { describe, expect, it } from "vitest";

describe("@uberblick/schema scaffold", () => {
  it("loads the package entrypoint", async () => {
    const mod = await import("../src/index.js");
    expect(mod).toBeDefined();
  });
});
