/** Ablauf blocks with a play section light their steps in order from the block's own controls. */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { expectMcp, waitForDocumentDraw } from "./settle.js";

const { harness, openApp } = setupHarness();
let agent: McpAgent | null = null;
const FLOW = 'flow v0\ncolumns main\n\npill draft tone=agent "Draft"\nbox check tone=system "Check draft"\nend done tone=done "Done"\n\ndraft --> check\ncheck --> done : Accepted';
const PLAYED = `${FLOW}\n\nplay\n  tempo 0.4s\n  step draft "A person writes it"\n  step check "The check runs"\n  step done "It ships"\n`;
const FANOUT = 'fan-out v0\nstep "Check approval"\n\noutcome "Approved" reason="A maintainer started it" destination="Start the run" tone="done"\noutcome "Outside input" reason="The input is uncleared" destination="Ask a maintainer" tone="stop"\n\nplay\n  step "Outside input" "Nobody cleared the input"\n';

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl,
    authSecret: harness().authSecret, statePrefix: "uberblick-e2e-ablauf-play-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

function writer(): McpSession {
  if (agent === null) throw new Error("e2e: Ablauf MCP agent is not configured");
  return agent.open({ name: "ablauf-play-e2e" });
}

async function doc(session: McpSession, title: string, blocks: string[]): Promise<string> {
  const result = await session.call<{ uuid: string }>("create_doc", {
    title, description: "Ablauf blocks that play back.",
    blocks: blocks.map((text) => ({ type: "code", language: "ablauf", text })),
  });
  return result.uuid;
}

function block(page: Page, index = 0): Locator { return page.locator(".ub-ablauf").nth(index); }
function play(page: Page, index = 0): Locator { return block(page, index).getByRole("button", { name: "Play", exact: true }); }
const lit = (page: Page, index: number, part: string): Promise<string> => block(page, index).locator(".ub-ablauf-drawing").evaluate(
  (host, name) => [...(host.shadowRoot?.querySelectorAll(`[data-ab-part="${name}"]`) ?? [])].map((el) => el.getAttribute("class") ?? "").join(" "),
  part,
);

test("a flow plays its steps in order, and the scrubber and caption follow it", async ({ browser }) => {
  const session = writer();
  const uuid = await doc(session, "Played flow", [PLAYED, FLOW]);
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await waitForDocumentDraw(page, session, uuid, { index: "all" });
  await expect(play(page)).toBeVisible();
  await expect(play(page, 1)).toBeHidden();
  await expect(block(page, 1).locator(".ub-ablauf-playback")).toBeHidden();
  await play(page).click();
  await expect(block(page).locator(".ub-ablauf-step-caption")).toHaveText("A person writes it");
  await expect.poll(() => lit(page, 0, "node:check")).toContain("ab-on");
  await expect.poll(() => lit(page, 0, "edge:draft>check")).toContain("ab-on");
  await expect(block(page).locator(".ub-ablauf-step-caption")).toHaveText("It ships");
  await expect(play(page)).toBeVisible();
  expect(await lit(page, 0, "node:draft")).toContain("ab-done");
  await block(page).getByRole("button", { name: "Step 2 of 3: The check runs", exact: true }).click();
  await expect(block(page).locator(".ub-ablauf-step-caption")).toHaveText("The check runs");
  expect(await lit(page, 0, "node:done")).not.toMatch(/ab-on|ab-done/);
  expect(await lit(page, 1, "node:check")).toBe("");
  await expectMcp(async () => {
    const result = await session.call<{ blocks: { text: string }[] }>("get_doc", { uuid });
    expect(result.blocks.map((entry) => entry.text)).toEqual([PLAYED, FLOW]);
  });
  await page.close();
});

test("a fan-out plays the outcome it names, read-only included", async ({ browser }) => {
  const session = writer();
  const uuid = await doc(session, "Played fan-out", [FANOUT]);
  await session.call("archive_doc", { uuid });
  const page = await openApp(browser, `/${harness().workspace}/${uuid}`);
  await waitForDocumentDraw(page, session, uuid);
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await play(page).click();
  await expect(block(page).locator(".ub-ablauf-step-caption")).toHaveText("Nobody cleared the input");
  await expect.poll(() => lit(page, 0, "outcome:2")).toContain("ab-on");
  expect(await lit(page, 0, "outcome:1")).not.toMatch(/ab-on|ab-done/);
  await page.close();
});
