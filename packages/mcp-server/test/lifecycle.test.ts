import { expect, it, vi } from "vitest";
import { waitUntil } from "./lifecycle.js";

it("expires a named wait while the wall clock is frozen", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  try {
    await expect(waitUntil("an unreachable condition", () => false, 25))
      .rejects.toThrow("timed out waiting for an unreachable condition");
  } finally {
    clock.mockRestore();
  }
});
