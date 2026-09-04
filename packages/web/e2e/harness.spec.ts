/** The production-path harness owns isolated serving processes and artifacts. */

import { expect, test } from "@playwright/test";
import { startHarness } from "./harness.js";

test("two production-path harnesses run together and both stop", async () => {
  const running = await Promise.all([startHarness(), startHarness()]);
  try {
    expect(running[0]?.appUrl).not.toBe(running[1]?.appUrl);
    for (const harness of running) {
      const response = await fetch(new URL("/uberblick-config.json", harness.appUrl));
      expect(response.ok).toBe(true);
      await expect(response.json()).resolves.toMatchObject({
        hubUrl: harness.appUrl.replace(/^http:/, "ws:").replace(/\/$/, ""),
        remoteHubUrl: harness.hubUrl,
        workspaces: [harness.workspace],
      });
    }
  } finally {
    await Promise.all(running.map((harness) => harness.stop()));
  }

  for (const harness of running) {
    await expect(fetch(harness.appUrl)).rejects.toThrow();
  }
});
