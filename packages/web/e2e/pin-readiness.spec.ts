/** Pin controls wait for this connection's sidebar state before writing. */

import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { MessageType } from "@hocuspocus/provider";
import { sidebarRoom } from "@uberblick/schema";
import { startHarness } from "./harness.js";
import { createPinnedDoc } from "./sidebar-helpers.js";

// Decode with the provider's own dependency, as the hub's protocol probes do.
const providerBuild = createRequire(import.meta.url).resolve("@hocuspocus/provider");
const decoding = createRequire(providerBuild)("lib0/decoding") as {
  createDecoder: (data: Uint8Array) => object;
  readVarString: (decoder: object) => string;
  readVarUint: (decoder: object) => number;
};

test("both pin controls wait for sidebar sync, then pin and unpin", async ({ browser }) => {
  const running = await startHarness();
  const authorContext = await browser.newContext();
  const readerContext = await browser.newContext();
  try {
    const title = "Pin readiness";
    const author = await authorContext.newPage();
    await author.goto(running.appUrl);
    await expect(author.getByRole("button", { name: "+ new doc" })).toBeEnabled();
    await createPinnedDoc(author, title);
    const docPath = new URL(author.url()).pathname;

    const reader = await readerContext.newPage();
    let holding = true;
    const pending: Array<() => void> = [];
    await reader.routeWebSocket("**", (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        if (holding && typeof message !== "string") {
          const decoder = decoding.createDecoder(message);
          const room = decoding.readVarString(decoder);
          const type = decoding.readVarUint(decoder);
          if (room === sidebarRoom(running.workspaceUuid) && type === MessageType.Sync) {
            pending.push(() => socket.send(message));
            return;
          }
        }
        socket.send(message);
      });
    });
    await reader.goto(running.appUrl);
    const rowPin = reader.locator(".ub-docs-row", { hasText: title }).locator(".ub-docs-pin");
    // Authentication passes through: group creation still needs only writable.
    await expect(reader.locator(".ub-group-add")).toBeEnabled();
    await expect.poll(() => pending.length).toBeGreaterThan(0);
    await expect(rowPin).toBeDisabled();
    await expect(rowPin).toHaveAccessibleName(`Pin ${title} to the sidebar unavailable while sidebar is not ready to write`);
    await expect(rowPin).toHaveAttribute("title", "Pin unavailable while the sidebar is not ready to write");
    await rowPin.evaluate((button: HTMLButtonElement) => button.click());

    await reader.locator(".ub-docs-title", { hasText: title }).click();
    await expect(reader).toHaveURL(new URL(docPath, running.appUrl).href);
    const actions = reader.getByRole("button", { name: "Document actions" });
    await actions.click();
    const unavailable = reader.getByRole("menuitem", { name: "Pin unavailable — sidebar is not ready to write", exact: true });
    await expect(unavailable).toBeDisabled();
    await unavailable.dispatchEvent("click");

    // Deliver the real server state to the already authenticated sidebar room.
    holding = false;
    for (const send of pending.splice(0)) send();
    await expect(reader.getByRole("menuitem", { name: "Unpin from sidebar", exact: true })).toBeEnabled();
    await expect(reader.locator(".ub-group-label")).toHaveText(["Pinned"]);
    await reader.getByRole("menuitem", { name: "Unpin from sidebar", exact: true }).click();
    await expect(author.locator(".ub-group-body li")).toHaveCount(0);
    await actions.click();
    await reader.getByRole("menuitem", { name: "Pin to sidebar", exact: true }).click();
    await expect(author.locator(".ub-group-body li > button:first-child")).toHaveText([title]);

    await reader.getByRole("button", { name: "All docs", exact: true }).click();
    await expect(rowPin).toBeEnabled();
    await expect(rowPin).toHaveAttribute("aria-pressed", "true");
    await rowPin.click();
    await expect(author.locator(".ub-group-body li")).toHaveCount(0);
    await expect(rowPin).toHaveAttribute("aria-pressed", "false");
    await rowPin.click();
    await expect(author.locator(".ub-group-body li > button:first-child")).toHaveText([title]);
    await expect(author.locator(".ub-group-label")).toHaveText(["Pinned"]);
  } finally {
    await readerContext.close();
    await authorContext.close();
    await running.stop();
  }
});
