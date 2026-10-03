/** Touch paths for information formerly available only on hover (#1071). */

import { expect, test } from "@playwright/test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/hub";
import { wrapToken } from "@uberblick/hub/protocol";
import { appendBlock, getBlocksFragment } from "@uberblick/schema";
import * as Y from "yjs";
import { createDoc, setupHarness } from "./app-helpers.js";

const { harness, openApp } = setupHarness();
const LONG_NAME = "Alexandria Montgomery · Engineering collaboration session on the production workspace";
const UNBROKEN_NAME = "Collaborator".repeat(12);

for (const [device, width, hasTouch] of [
  ["iPhone", 375, true],
  ["iPad", 744, true],
  ["MacBook", 1366, false],
] as const) {
  test(`hover information has a ${device} path`, async ({ browser }) => {
    const page = await openApp(browser, "/", {
      upstream: true,
      contextOptions: { viewport: { width, height: 900 }, hasTouch },
    });
    if (width < 1280) {
      await page.getByRole("button", { name: "Show document list", exact: true }).click();
    }
    for (const destination of ["Dashboard", "Product requirements"]) {
      const row = page.getByRole("button", { name: new RegExp(`${destination}.*coming soon`, "i") });
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("aria-disabled", "true");
    }
    const uuid = await createDoc(page, `Hover paths ${device}`);
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: harness().hubUrl,
      name: `${harness().workspaceUuid}/${uuid}`,
      document: doc,
      token: async () => wrapToken(await mintToken(await importRootSecret(harness().authSecret), {
        typ: "room",
        sub: "hover-proof-agent",
        workspace: harness().workspaceUuid,
        scope: "read-write",
        kid: null,
        lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      })),
    });
    try {
      await new Promise<void>((resolve) => provider.on("synced", resolve));
      for (let index = 0; index < 28; index += 1) {
        appendBlock(doc, { type: "paragraph", text: `Collaboration paragraph ${index}` });
      }
      await expect(page.locator(".ub-editor .ProseMirror > *")).toHaveCount(29);
      provider.setAwarenessField("user", { name: LONG_NAME, color: "#0675c9" });
      provider.setAwarenessField("client", "agent");
      const block = getBlocksFragment(doc).get(28);
      if (!(block instanceof Y.XmlElement) || !(block.firstChild instanceof Y.XmlText)) {
        throw new Error("last block has no text");
      }
      const anchor = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(block.firstChild, 1));
      provider.setAwarenessField("cursor", { anchor, head: anchor });
      // Match the product's complete label without depending on punctuation.
      const peer = page.locator(".ub-peer-control[data-peer-id]").filter({ has: page.locator(".ub-avatar-agent-badge") });
      await expect(peer).toHaveCount(1);
      await expect(peer).toHaveAccessibleName(/Alexandria Montgomery.*agent.*29/);
      const syncFocusViaTab = async (): Promise<void> => {
        for (let count = 0; count < 10; count += 1) {
          await page.keyboard.press("Tab");
          if (await page.locator(".ub-status-sync").evaluate((element) => element === document.activeElement)) return;
        }
        throw new Error("keyboard did not reach sync trigger");
      };
      if (hasTouch) {
        await peer.tap();
        await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
        await expect.poll(() => page.locator(".ub-pane").evaluate((pane) => pane.scrollTop)).toBeGreaterThan(0);
        await page.locator(".ub-pane").evaluate((pane) => { pane.scrollTop = 0; });
      } else {
        // Focus from a scrolled pane still opens the product tooltip.
        await page.locator(".ub-pane").evaluate((pane) => { pane.scrollTop = 250; });
        await page.locator(".ub-title").focus();
        await syncFocusViaTab();
        await page.locator(".ub-pane").evaluate((pane) => { pane.scrollTop = 250; });
        await page.keyboard.press("Tab");
        await expect(peer).toBeFocused();
        let previousScroll = -1;
        let stableReads = 0;
        await expect.poll(async () => {
          const scroll = await page.locator(".ub-pane").evaluate((pane) => pane.scrollTop);
          stableReads = scroll === previousScroll ? stableReads + 1 : 0;
          previousScroll = scroll;
          return stableReads;
        }, { intervals: [50], timeout: 2_000 }).toBeGreaterThanOrEqual(4);
        await expect(page.getByRole("tooltip")).toHaveText(`${LONG_NAME} · agent`);
        await page.keyboard.press("Escape");
        await page.locator(".ub-title").focus();
        await peer.hover();
        const content = page.locator('[data-slot="tooltip-content"]');
        await expect(content).toBeVisible();
        await expect(page.getByRole("tooltip")).toHaveText(`${LONG_NAME} · agent`);
        await content.hover();
        await expect(content).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(content).toHaveCount(0);
        await peer.focus();
        await expect(page.getByRole("tooltip")).toHaveText(`${LONG_NAME} · agent`);
        await page.keyboard.press("Escape");
        await expect(peer).toBeFocused();
        await expect(content).toHaveCount(0);
      }
      const updated = page.locator(".ub-last-updated time");
      await expect(updated).toBeVisible();
      const exact = await updated.getAttribute("title");
      const stamp = await updated.getAttribute("datetime");
      const sync = page.getByRole("button", { name: /^Sync details/ });
      if (hasTouch) await sync.tap();
      else { await sync.focus(); await page.keyboard.press("Enter"); }
      const panel = page.getByRole("complementary", { name: "Sync and presence" });
      await expect(panel).toBeVisible();
      await expect(panel.locator("dt", { hasText: "Last updated" }).locator("..").locator("time")).toHaveText(exact ?? "");
      await expect(panel.locator("time")).toHaveAttribute("datetime", stamp ?? "");
      const checkName = async (name: string): Promise<void> => {
        const text = panel.locator(".ub-presence-name");
        await expect(text).toHaveText(name);
        const layout = await text.evaluate((element) => {
          const nameBox = element.getBoundingClientRect();
          const panel = element.closest("aside");
          if (panel === null) throw new Error("name has no panel");
          const panelBox = panel.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          const blockBox = element.nextElementSibling?.getBoundingClientRect();
          return {
            fits: element.scrollWidth <= element.clientWidth + 1,
            wraps: range.getClientRects().length > 1,
            inside: nameBox.right <= panelBox.right && (blockBox === undefined || blockBox.right <= panelBox.right),
          };
        });
        expect(layout).toEqual({ fits: true, wraps: true, inside: true });
      };
      await checkName(LONG_NAME);
      await expect(panel.getByText("block 29", { exact: true })).toBeVisible();
      // The same panel is also the full-name path when there is no caret to reveal.
      provider.setAwarenessField("cursor", null);
      provider.setAwarenessField("user", { name: UNBROKEN_NAME, color: "#0675c9" });
      await checkName(UNBROKEN_NAME);
      await expect(panel.getByText("block 29", { exact: true })).toHaveCount(0);
    } finally {
      provider.destroy();
      doc.destroy();
    }
  });
}

test("unavailable Restore and pin reasons are visible on touch", async ({ browser }) => {
  const page = await openApp(browser, "/", {
    upstream: true,
    contextOptions: { viewport: { width: 375, height: 900 }, hasTouch: true },
  });
  await page.getByRole("button", { name: "Show document list", exact: true }).click();
  await createDoc(page, "Still listed");
  await page.getByRole("button", { name: "Show document list", exact: true }).click();
  await createDoc(page, "Archived reason");
  await page.getByRole("button", { name: "Document actions" }).click();
  await page.getByRole("menuitem", { name: "Archive document" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive document" }).click();
  await expect(page.locator(".ub-archived-banner")).toBeVisible();
  await harness().stopHub();
  try {
    await expect(page.getByRole("button", { name: "Restore unavailable" })).toBeDisabled();
    await expect(page.locator(".ub-restore-unavailable")).toBeVisible();
    await expect(page.locator(".ub-restore-unavailable")).toContainText("directory is not ready to write");
    await page.getByRole("button", { name: "Show document list", exact: true }).click();
    await page.getByRole("button", { name: "All docs", exact: true }).click();
    await expect(page.locator(".ub-docs-pin-unavailable")).toBeVisible();
    await expect(page.locator(".ub-docs-pin-unavailable")).toContainText("sidebar is not ready to write");
    await expect(page.locator(".ub-docs-pin").first()).toBeDisabled();
  } finally {
    await harness().startHub();
  }
});
