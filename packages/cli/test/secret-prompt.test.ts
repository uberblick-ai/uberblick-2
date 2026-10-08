import { describe, expect, it } from "vitest";
import { removeTempDirs, runUb, sandbox } from "./helpers.js";
import { afterAll } from "vitest";

afterAll(removeTempDirs);

describe("remote credentials", () => {
  it("refuses the removed signing-secret option before reading it or writing", () => {
    const box = sandbox();
    const run = runUb(["workspace", "use", "wss://hub.invalid/ws/5c1f9a72-4d38-4e02-9b6a-7e3f10c85b94", "--secret-file", "synthetic-private-secret"], box);
    expect(run.status).toBe(2);
    expect(run.output).not.toContain("synthetic-private-secret");
    expect(run.stderr).toContain("Unknown option");
  });
});
