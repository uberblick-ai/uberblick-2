/** Website assets only; run with mise run e2e --config=playwright-captures.config.ts. */
import { expect, test } from "@playwright/test";
import { setupHarness } from "../app-helpers.js";
import { McpAgent } from "../mcp-agent.js";
import { waitForDocumentDraw } from "../settle.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl, authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-ablauf-capture-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

for (const appearance of ["light", "dark"] as const) {
  test(`website Ablauf example is captured from the ${appearance} editor at 648 CSS pixels`, async ({ browser }, info) => {
    if (agent === null) throw new Error("e2e: missing Ablauf screenshot writer");
    const session = agent.open({ name: "ablauf-site-e2e" });
    // The first example on uberblick.ai/docs/markdown/diagrams (repository uberblick-ai/uberblick.ai); the
    // captured ablauf-light.png and ablauf-dark.png attachments are what that page shows.
    const text = `flow v0
columns rework main

pill edit_block col=main tone=agent "agent calls edit_block"
box server "checks old text and revision"
end applied "Edit applied"

pill stale_block col=rework row=server tone=rework
box rediff "agent re-diffs against the current text"

edit_block --> server
server --> applied : text and revision match
server --> stale_block tone=rework : someone edited meanwhile
stale_block --> rediff tone=rework
rediff --> edit_block tone=rework from=left to=left label=end : calls again`;
    const { uuid } = await session.call<{ uuid: string }>("create_doc", {
      title: "Ablauf website example", description: "The real editor block shown on the Diagrams page.",
      blocks: [{ type: "paragraph", text: "Reading, editing and syncing a page in one diagram." }, { type: "code", language: "ablauf", text }],
    });
    const page = await openApp(browser, `/${harness().workspace}/${uuid}`, {
      contextOptions: { viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 2, colorScheme: appearance },
    });
    await waitForDocumentDraw(page, session, uuid);
    await page.evaluate(() => document.fonts.ready);
    const block = page.locator(".ub-ablauf");
    await page.addStyleTag({ content: ".ub-ablauf { width: 648px !important; max-width: none !important; }" });
    expect((await block.boundingBox())?.width).toBe(648);
    const path = info.outputPath(`ablauf-${appearance}.png`);
    await block.screenshot({ path });
    await info.attach(`ablauf-${appearance}`, { path, contentType: "image/png" });
  });
}
