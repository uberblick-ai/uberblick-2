import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { MessageType } from "@hocuspocus/provider";
import { roomForDoc } from "@uberblick/schema";
import { activateControl, createDoc, docTitle, editor, openPath, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";
import { waitForAcknowledged } from "./settle.js";

const { harness, openApp } = setupHarness();

// Use the provider's own frame decoder to select one room on the shared socket.
const providerBuild = createRequire(import.meta.url).resolve("@hocuspocus/provider");
const decoding = createRequire(providerBuild)("lib0/decoding") as {
  createDecoder: (data: Uint8Array) => object;
  readVarString: (decoder: object) => string;
  readVarUint: (decoder: object) => number;
};

for (const interrupted of ["authentication", "initial state"] as const) {
  test(`a deep link recovers when its socket drops before ${interrupted} @webkit`, async ({
    browser, contextOptions, viewport, hasTouch, isMobile, deviceScaleFactor, userAgent,
  }) => {
    const publisher = await openApp(browser);
    await expect(publisher.getByRole("heading", { name: "All documents", exact: true })).toBeVisible();
    const showList = publisher.getByRole("button", { name: "Show document list", exact: true });
    if (await showList.isVisible()) await activateControl(showList);
    const title = docTitle("Initial join recovery");
    const uuid = await createDoc(publisher, title);
    const text = "This document arrived after reconnecting.";
    await placeCaret(publisher);
    await publisher.keyboard.insertText(text);
    await waitForAcknowledged(publisher, { path: "relay" });
    const path = openPath(publisher);
    await publisher.context().close();

    const room = roomForDoc(harness().workspaceUuid, uuid);
    let sockets = 0;
    let replacementAuthentications = 0;
    let deliveredState = 0;
    let navigations = 0;
    let hold = true;
    let drop: (() => Promise<void>) | undefined;
    const replies: Array<() => void> = [];
    const page = await openApp(browser, path, {
      // openApp creates a fresh context; retain the project's iPad input and viewport.
      contextOptions: {
        ...contextOptions, viewport, hasTouch, isMobile,
        ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
        ...(userAgent === undefined ? {} : { userAgent }),
      },
      beforeNavigate: async target => {
        target.on("framenavigated", frame => { if (frame === target.mainFrame()) navigations += 1; });
        await target.routeWebSocket("**", socket => {
          const connection = ++sockets;
          const server = socket.connectToServer();
          server.onMessage(message => {
            if (typeof message === "string") { socket.send(message); return; }
            const decoder = decoding.createDecoder(message);
            const targetRoom = decoding.readVarString(decoder) === room;
            const type = decoding.readVarUint(decoder);
            if (!targetRoom) { socket.send(message); return; }
            if (connection > 1 && type === MessageType.Auth) replacementAuthentications += 1;
            const forward = (): void => {
              if (type === MessageType.Sync) deliveredState += 1;
              socket.send(message);
            };
            if (!hold) { forward(); return; }
            if (connection > 1) { replies.push(forward); return; }
            if (interrupted === "initial state" && type === MessageType.Auth) { forward(); return; }
            if (type !== (interrupted === "authentication" ? MessageType.Auth : MessageType.Sync)) return;
            // The target room has joined, but none of its sync state can reach the page.
            drop ??= async () => {
              await Promise.all([
                socket.close({ code: 1011, reason: "initial join transport loss" }),
                server.close({ code: 1011, reason: "initial join transport loss" }),
              ]);
            };
          });
        });
      },
    });

    await expect.poll(() => drop !== undefined).toBe(true);
    expect(deliveredState).toBe(0);
    await expect(editor(page)).toHaveCount(0);
    if (drop === undefined) throw new Error("e2e: target room did not start joining");
    await drop();
    await expect(page.locator(".ub-waiting-meta")).toBeVisible();
    await expect(page.locator(".ub-not-saved")).toHaveText("not saved");
    await expect.poll(() => replacementAuthentications).toBe(1);
    expect(sockets).toBe(2);
    expect(deliveredState).toBe(0);

    hold = false;
    for (const forward of replies.splice(0)) forward();
    await expect(page.locator(".ub-title")).toHaveValue(title);
    await expect(editor(page)).toHaveText(text);
    await waitForAcknowledged(page, { path: "relay" });
    await expect(page.locator(".ub-not-saved")).toHaveCount(0);
    await expect(page.locator(".ub-waiting-meta")).toHaveCount(0);
    expect(deliveredState).toBeGreaterThan(0);
    expect(openPath(page)).toBe(path);
    expect(navigations).toBe(1);
  });
}
