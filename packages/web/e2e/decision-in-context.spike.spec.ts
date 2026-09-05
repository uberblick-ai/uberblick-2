/** Disposable proof for #844. This file lives only on the retained evidence branch. */

import { expect, test } from "@playwright/test";
import type { BrowserContext } from "@playwright/test";
import { openUpstreamApp, startHarness } from "./harness.js";
import type { Harness } from "./harness.js";
import { McpAgent } from "./mcp-agent.js";

test.describe.configure({ mode: "serial" });

interface DocPayload {
  blocks: { id: string; text: string; rev: string }[];
  annotations: unknown[];
}

let started: Harness | null = null;
let mcpAgent: McpAgent | null = null;
const contexts: BrowserContext[] = [];

function harness(): Harness {
  if (started === null) throw new Error("spike: harness did not start");
  return started;
}

function agent(): McpAgent {
  if (mcpAgent === null) throw new Error("spike: MCP agent is unavailable");
  return mcpAgent;
}

test.beforeAll(async () => {
  started = await startHarness();
  mcpAgent = new McpAgent({
    workspace: harness().workspace,
    hubUrl: harness().hubUrl,
    authSecret: harness().authSecret,
    statePrefix: "uberblick-spike-844-",
  });
});

test.afterEach(async () => {
  await mcpAgent?.closeSessions();
  for (const context of contexts.splice(0)) await context.close();
});

test.afterAll(async () => {
  const running = started;
  started = null;
  await mcpAgent?.close();
  mcpAgent = null;
  await running?.stop();
});

test("a decision record in context stays independent and collaborative", async ({
  browser,
}) => {
  const session = agent().open({ name: "spike-844-agent" });
  const requirement = await session.call<{ uuid: string }>("create_doc", {
    title: "Keep the requirement in view",
    description: "A product document used by the in-context decision spike.",
    kind: "requirement",
    status: "planned",
    blocks: [{ type: "paragraph", text: "Requirement context stays here." }],
  });
  const decision = await session.call<{ uuid: string }>("create_doc", {
    title: "Choose the decision container",
    description: "A decision opened while its requirement remains routed.",
    kind: "decision",
    governs: requirement.uuid,
    blocks: [{ type: "paragraph", text: "Compare the three containers." }],
  });

  const opened = await openUpstreamApp(
    browser,
    harness(),
    `/${harness().workspace}/${requirement.uuid}`,
  );
  contexts.push(opened.context);
  const page = opened.page;
  const originalUrl = page.url();

  await expect(page.locator(".ub-title")).toHaveValue(
    "Keep the requirement in view",
  );
  const entry = page.getByRole("button", {
    name: "Open decision Choose the decision container",
  });
  await expect(entry).toContainText("Open");
  await entry.click();

  const dialog = page.getByRole("dialog", { name: "Decision in context" });
  await expect(dialog.locator(".ub-title")).toHaveValue(
    "Choose the decision container",
  );
  await expect(dialog.locator(".ub-lifecycle-badge")).toContainText(
    "Decision · open",
  );
  expect(page.url()).toBe(originalUrl);
  await expect(page.locator("main .ub-title")).toHaveValue(
    "Keep the requirement in view",
  );

  const before = await session.call<DocPayload>("get_doc", {
    uuid: decision.uuid,
  });
  const block = before.blocks[0];
  if (block === undefined) throw new Error("spike: decision has no block");
  await session.call("edit_block", {
    uuid: decision.uuid,
    block_id: block.id,
    old_text: block.text,
    new_text: "The agent edited the opened decision.",
    rev: block.rev,
  });
  const editor = dialog.locator(".ub-editor .ProseMirror");
  await expect(editor).toContainText("The agent edited the opened decision.");

  await editor.fill("The browser edited only this decision.");
  await expect
    .poll(async () => {
      const current = await session.call<DocPayload>("get_doc", {
        uuid: decision.uuid,
      });
      return current.blocks[0]?.text;
    })
    .toBe("The browser edited only this decision.");

  await editor.focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await dialog.getByRole("button", { name: "Comment", exact: true }).click();
  await dialog.getByPlaceholder(/Comment as/).fill("Keep this rationale.");
  await dialog.getByRole("button", { name: "Comment", exact: true }).click();

  await expect
    .poll(async () => {
      const current = await session.call<DocPayload>("get_doc", {
        uuid: decision.uuid,
      });
      return current.annotations.length;
    })
    .toBe(1);
  const requirementAfter = await session.call<DocPayload>("get_doc", {
    uuid: requirement.uuid,
  });
  expect(requirementAfter.blocks[0]?.text).toBe("Requirement context stays here.");
  expect(requirementAfter.annotations).toHaveLength(0);
  expect(page.url()).toBe(originalUrl);
});
