import { expect, test } from "@playwright/test";
import { createDoc, docTitle, editor, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";
import { waitForAcknowledged } from "./settle.js";

const { openApp } = setupHarness();

for (const path of ["relay", "upstream"] as const) {
  test(`a visible edit stays pending until its ${path} acknowledgement arrives`, async ({ browser }) => {
    let hold = false;
    const replies: (() => void)[] = [];
    const page = await openApp(browser, "/", {
      upstream: path === "upstream",
      readySelector: ".ub-document-sidebar",
      beforeNavigate: async page => {
        await page.routeWebSocket(/.*/, socket => {
          const server = socket.connectToServer();
          server.onMessage(message => {
            const forward = (): void => { socket.send(message); };
            if (hold) replies.push(forward);
            else forward();
          });
        });
      },
    });
    await createDoc(page, docTitle("settle"));
    await waitForAcknowledged(page, { path });
    hold = true;
    await placeCaret(page);
    await page.keyboard.insertText("Visible before acknowledgement");
    await expect(editor(page)).toContainText("Visible before acknowledgement");
    await expect(page.locator(".ub-status")).toHaveAttribute("data-local-sync", "pending");
    if (path === "relay") {
      await expect(page.locator(".ub-status")).toHaveAttribute("data-upstream-sync", "pending");
    }
    hold = false;
    for (const forward of replies.splice(0)) forward();
    await waitForAcknowledged(page, { path });
    await page.reload();
    await expect(editor(page)).toContainText("Visible before acknowledgement");
  });
}
