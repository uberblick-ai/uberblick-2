/** The production-path harness owns isolated serving processes and artifacts. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { sharedAppBundle } from "./bundle.js";
import { startHarness } from "./harness.js";

test("two production-path harnesses share the run bundle, isolate configuration and both stop", async ({ browser }) => {
  const bundle = sharedAppBundle();
  const starts = await Promise.allSettled([startHarness(), startHarness()]);
  const running = starts.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  try {
    for (const result of starts) if (result.status === "rejected") throw result.reason;
    expect(running[0]?.appUrl).not.toBe(running[1]?.appUrl);
    for (const harness of running) {
      expect(await (await fetch(harness.appUrl)).text()).toBe(readFileSync(join(bundle.directory, "index.html"), "utf8"));
      const response = await fetch(new URL("/uberblick-config.json", harness.appUrl));
      expect(response.ok).toBe(true);
      await expect(response.json()).resolves.toMatchObject({
        hubUrl: harness.appUrl.replace(/^http:/, "ws:").replace(/\/$/, ""),
        remoteHubUrl: harness.hubUrl,
        workspaces: [harness.workspace],
      });

      // Omit endpoint and workspace, but provide a key so a wrong fallback
      // cannot hide behind missing-token suppression. Even a poisoned caller
      // environment must produce only this run's reserved endpoint/workspace.
      const context = await browser.newContext();
      try {
        await context.route("**/uberblick-config.json", (route) => route.fulfill({
          json: { hubAuthToken: harness.authSecret },
        }));
        const page = await context.newPage();
        const sockets: string[] = [];
        page.on("websocket", (socket) => sockets.push(socket.url()));
        await page.goto(harness.appUrl);
        await expect(page).toHaveURL(new URL(`/${bundle.workspace}`, harness.appUrl).href);
        await expect.poll(() => sockets.length).toBeGreaterThan(0);
        expect(sockets.every((url) => url === bundle.hubUrl || url === `${bundle.hubUrl}/`)).toBe(true);
        expect(bundle.hubUrl).not.toBe(harness.hubUrl);
        expect(bundle.workspace).not.toBe(harness.workspace);
      } finally {
        await context.close();
      }
    }
  } finally {
    await Promise.all(running.map((harness) => harness.stop()));
  }

  for (const harness of running) {
    await expect(fetch(harness.appUrl)).rejects.toThrow();
  }
});
