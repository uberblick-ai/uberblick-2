import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { activateControl, docTitle, editor, setupHarness } from "./app-helpers.js";
import { McpAgent } from "./mcp-agent.js";
import type { McpSession } from "./mcp-agent.js";
import { expectMcp, proveMcpArrival } from "./settle.js";

const displayName = "Browser decision maker";
const { harness, openApp } = setupHarness({ gitUserName: displayName });
let agent: McpAgent | null = null;

test.beforeAll(() => {
  agent = new McpAgent({
    workspace: harness().workspace, hubUrl: harness().hubUrl, authSecret: harness().authSecret,
    statePrefix: "uberblick-e2e-settle-decision-",
  });
});
test.afterEach(async () => { await agent?.closeSessions(); });
test.afterAll(async () => { await agent?.close(); agent = null; });

interface StoredDoc {
  uuid: string;
  topic?: string;
  title: string;
  status?: string;
  decidedBy?: string;
  decidedAt?: string;
  decidedWhere?: string;
  agentStance?: boolean;
  approvalChanged?: boolean;
  rejectionReason?: string;
  blocks: Array<{ id: string; rev: string; type: string; text: string }>;
  resolution?: { inForce: string | null; pending: string[]; conflicts: string[] };
  inForce?: string | null;
  pending?: string[];
  conflicts?: string[];
}

type Action = "Decide" | "Reject" | "Withdraw";

function session(): McpSession {
  if (agent === null) throw new Error("e2e: MCP agent is not configured");
  return agent.open({ name: "settle-decision-e2e" });
}

async function create(writer: McpSession, title: string | undefined, text: string, fields: Record<string, unknown> = {}): Promise<StoredDoc> {
  const created = await writer.call<StoredDoc>("create_doc", {
    ...(title === undefined ? {} : { title }), kind: "decision",
    description: "Settle decision browser acceptance fixture.",
    blocks: [{ type: "paragraph", text }], ...fields,
  });
  return { ...created, blocks: created.blocks.map(block => ({ ...block, text })) };
}

function answer() {
  return { who: "Earlier decision maker", when: "2026-10-04T12:00:00Z", where: "https://example.org/decision" };
}

function entry(page: Page, uuid: string): Locator {
  return page.locator(`.ub-decision-timeline > li[data-record="${uuid}"]`);
}

function pill(page: Page, name: "Not yet decided" | "Under review"): Locator {
  return page.locator(".ub-decision-answer-header").getByRole("button", { name, exact: true });
}

function dialog(page: Page, action: Action): Locator {
  const name = action === "Withdraw" ? "Withdraw this proposal?" : `${action} this answer?`;
  return page.getByRole("alertdialog", { name, exact: true });
}

async function openAction(page: Page, state: "Not yet decided" | "Under review", action: Action, touch = false): Promise<void> {
  await activateControl(pill(page, state), { touch });
  await activateControl(page.getByRole("menuitem", { name: action, exact: true }), { touch });
  await expect(dialog(page, action)).toBeVisible();
}

async function selected(page: Page, record: StoredDoc, editable: boolean): Promise<void> {
  await expect(entry(page, record.uuid).locator(".ub-decision-record")).toHaveAttribute("aria-current", "true");
  await expect(editor(page)).toHaveText(record.blocks[0]?.text ?? "");
  await expect(editor(page)).toHaveAttribute("contenteditable", String(editable));
}

async function resolution(writer: McpSession, topic: string, inForce: string | null, pending: string[]): Promise<void> {
  await expectMcp(() => writer.call<{ docs: StoredDoc[] }>("list_docs", { kind: "decision" }), listed => {
    const row = listed.docs.find(doc => doc.topic === topic);
    expect(row).toMatchObject({ inForce, pending, conflicts: [] });
  });
}

async function contained(control: Locator): Promise<void> {
  await expect(control).toBeVisible();
  await expect.poll(() => control.evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight;
  })).toBe(true);
}

test("the state menu and confirmation work by desktop keyboard and pointer or iPad touch", { tag: "@webkit-touch" }, async ({ browser }, info) => {
  const touch = info.project.use.hasTouch === true;
  const writer = session();
  const source = await create(writer, docTitle("Settle controls"), "Keep the open answer.");
  const page = await openApp(browser, `/${harness().workspace}/${source.uuid}`, {
    contextOptions: touch ? devices["iPad (gen 7) landscape"] : { viewport: { width: 1440, height: 1000 } },
  });
  await selected(page, source, true);
  await page.evaluate(() => document.fonts.ready);
  const trigger = pill(page, "Not yet decided");
  await expect(entry(page, source.uuid).getByRole("button")).toHaveCount(0);
  if (touch) await trigger.tap();
  else {
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Decide", exact: true })).toBeFocused();
  }
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Decide", "Reject"]);
  const menuPaint: string[] = [];
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await contained(menu);
    menuPaint.push(await menu.evaluate(element => getComputedStyle(element).backgroundColor));
  }
  expect(menuPaint[0]).not.toBe(menuPaint[1]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await activateControl(trigger, { touch });
  if (touch) await page.touchscreen.tap(3, 3);
  else await page.mouse.click(3, 3);
  await expect(menu).toHaveCount(0);

  await openAction(page, "Not yet decided", "Decide", touch);
  const confirmation = dialog(page, "Decide");
  const dialogPaint: string[] = [];
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await contained(confirmation);
    await contained(confirmation.getByRole("button", { name: "Decide", exact: true }));
    dialogPaint.push(await confirmation.evaluate(element => getComputedStyle(element).backgroundColor));
  }
  expect(dialogPaint[0]).not.toBe(dialogPaint[1]);
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await openAction(page, "Not yet decided", "Decide", touch);
  await activateControl(confirmation.getByRole("button", { name: "Cancel", exact: true }), { touch });
  await expect(confirmation).toHaveCount(0);
  // The later answer edit proves the preceding dismissal paths reached the
  // same upstream MCP reader before checking that they recorded no answer.
  const edited = "The answer remains editable after cancelling settlement.";
  await editor(page).fill(edited);
  await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: source.uuid }), stored => {
    expect(stored.blocks[0]?.text).toBe(edited);
    expect(stored.status).toBe("open");
    expect(stored.decidedBy).toBeUndefined();
    expect(stored.decidedAt).toBeUndefined();
    expect(stored.decidedWhere).toBeUndefined();
  });

  await page.evaluate(() => { document.documentElement.dataset.settlementJourney = "same-page"; });
  await openAction(page, "Not yet decided", "Decide", touch);
  const before = await page.evaluate(() => Date.now());
  if (touch) await confirmation.getByRole("button", { name: "Decide", exact: true }).tap();
  else {
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(confirmation.getByRole("button", { name: "Decide", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
  }
  await expect(confirmation).toHaveCount(0);
  const after = await page.evaluate(() => Date.now());
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(editor(page)).toHaveText(edited);
  await expect(page.locator("html")).toHaveAttribute("data-settlement-journey", "same-page");
  await expect(page.locator(".ub-decision-answer-header")).toContainText("In force");
  await expect(page.getByRole("button", { name: "Alter decision", exact: true })).toBeVisible();
  await expect(entry(page, source.uuid)).toContainText("In force");
  await expect(entry(page, source.uuid)).toContainText(displayName);
  await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: source.uuid }), stored => {
    expect(stored).toMatchObject({ status: "decided", decidedBy: displayName, agentStance: false, approvalChanged: false });
    expect(stored.decidedWhere).toContain("Uberblick web");
    expect(Date.parse(stored.decidedAt ?? "")).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stored.decidedAt ?? "")).toBeLessThanOrEqual(after);
    expect(stored.rejectionReason).toBeUndefined();
    expect(stored.blocks[0]?.text).toBe(edited);
  });
  await resolution(writer, source.uuid, source.uuid, []);
});

test("Decide settles the selected proposal and supersedes the earlier answer in place", async ({ browser }) => {
  const writer = session();
  const source = await create(writer, docTitle("Selected settlement"), "Earlier answer remains in force.", { status: "decided", answer: answer() });
  const selectedProposal = await create(writer, undefined, "Accept only this selected proposal.", { supersedes: source.uuid });
  const otherProposal = await create(writer, undefined, "Keep the other proposal pending.", { supersedes: source.uuid });
  const page = await openApp(browser, `/${harness().workspace}/${source.uuid}`);
  await selected(page, source, false);
  await expect(page.locator(".ub-decision-timeline").getByRole("button")).toHaveCount(0);
  await entry(page, selectedProposal.uuid).locator(".ub-decision-record").click();
  await selected(page, selectedProposal, true);
  await openAction(page, "Under review", "Decide");
  await dialog(page, "Decide").getByRole("button", { name: "Decide", exact: true }).click();
  await expect(dialog(page, "Decide")).toHaveCount(0);
  await selected(page, selectedProposal, false);
  await expect(entry(page, selectedProposal.uuid)).toContainText("In force");
  await expect(entry(page, source.uuid)).toContainText("Superseded");
  await expect(entry(page, otherProposal.uuid)).toContainText("Under review");
  await expect(page.getByRole("button", { name: "Alter decision", exact: true })).toBeVisible();
  await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: selectedProposal.uuid }), stored => {
    expect(stored).toMatchObject({ status: "decided", decidedBy: displayName, approvalChanged: false, agentStance: false });
    expect(stored.blocks[0]?.text).toBe(selectedProposal.blocks[0]?.text);
  });
  await resolution(writer, source.uuid, selectedProposal.uuid, [otherProposal.uuid]);
  await entry(page, otherProposal.uuid).locator(".ub-decision-record").click();
  await selected(page, otherProposal, true);
  await pill(page, "Under review").click();
  await expect(page.getByRole("menuitem", { name: /^Decide/ })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("menu")).toContainText(/since been replaced|create a conflict/);
  await expect(page.getByRole("menuitem", { name: "Reject", exact: true })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Withdraw", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
});

test("Reject records a trimmed reason and Withdraw leaves no recorded answer while preserving the answer in force", async ({ browser }) => {
  const writer = session();
  const source = await create(writer, docTitle("Rejected and withdrawn proposals"), "Keep this answer in force.", { status: "decided", answer: answer() });
  const rejected = await create(writer, undefined, "Reject this proposal with a reason.", { supersedes: source.uuid });
  const withdrawn = await create(writer, undefined, "Withdraw this proposal without recording an answer.", { supersedes: source.uuid });
  const page = await openApp(browser, `/${harness().workspace}/${source.uuid}/record/${rejected.uuid}`);
  await selected(page, rejected, true);
  await openAction(page, "Under review", "Reject");
  const rejection = dialog(page, "Reject");
  await expect(rejection.getByRole("button", { name: "Reject", exact: true })).toBeDisabled();
  await rejection.getByRole("textbox", { name: "Rejection reason", exact: true }).fill("  The proposal omits a required constraint.  ");
  await rejection.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(rejection).toHaveCount(0);
  await selected(page, rejected, false);
  await expect(page.locator(".ub-decision-answer-header")).toContainText("Rejected");
  await expect(page.locator(".ub-decision-rejection")).toHaveText("Rejection reason: The proposal omits a required constraint.");
  await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: rejected.uuid }), stored => {
    expect(stored).toMatchObject({ status: "rejected", decidedBy: displayName, agentStance: false, approvalChanged: false,
      rejectionReason: "The proposal omits a required constraint." });
    expect(stored.decidedWhere).toContain("Uberblick web");
    expect(stored.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stored.blocks[0]?.text).toBe(rejected.blocks[0]?.text);
  });
  await resolution(writer, source.uuid, source.uuid, [withdrawn.uuid]);

  await entry(page, withdrawn.uuid).locator(".ub-decision-record").click();
  await selected(page, withdrawn, true);
  await openAction(page, "Under review", "Withdraw");
  await dialog(page, "Withdraw").getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(dialog(page, "Withdraw")).toHaveCount(0);
  await selected(page, withdrawn, false);
  await expect(page.locator(".ub-decision-answer-header")).toContainText("Withdrawn");
  await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: withdrawn.uuid }), stored => {
    expect(stored.status).toBe("withdrawn");
    expect(stored.decidedBy).toBeUndefined();
    expect(stored.decidedAt).toBeUndefined();
    expect(stored.decidedWhere).toBeUndefined();
    expect(stored.rejectionReason).toBeUndefined();
    expect(stored.approvalChanged).toBe(false);
    expect(stored.blocks[0]?.text).toBe(withdrawn.blocks[0]?.text);
  });
  await resolution(writer, source.uuid, source.uuid, []);
  await page.getByRole("link", { name: "Go to the current answer", exact: true }).click();
  await selected(page, source, false);
});

test("confirmation refuses a record settled through MCP after the dialog opened", async ({ browser }) => {
  const writer = session();
  const source = await create(writer, docTitle("Live settlement recheck"), "Keep the answer when another person settles first.");
  const page = await openApp(browser, `/${harness().workspace}/${source.uuid}`);
  await selected(page, source, true);
  await openAction(page, "Not yet decided", "Decide");
  await writer.call("set_status", { uuid: source.uuid, status: "rejected", answer: answer(), reason: "Another person rejected the answer first." });
  await expect(entry(page, source.uuid)).toContainText("Rejected");
  await expect(dialog(page, "Decide")).toBeVisible();
  await dialog(page, "Decide").getByRole("button", { name: "Decide", exact: true }).click();
  await expect(dialog(page, "Decide")).toContainText(/no longer open/);
  await dialog(page, "Decide").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog(page, "Decide")).toHaveCount(0);
  await proveMcpArrival(page, writer, source.uuid, { path: "upstream", restore: true });
  await expectMcp(() => writer.call<StoredDoc>("get_doc", { uuid: source.uuid }), stored => {
    expect(stored).toMatchObject({ status: "rejected", decidedBy: "Earlier decision maker", decidedAt: "2026-10-04T12:00:00.000Z",
      decidedWhere: "https://example.org/decision", rejectionReason: "Another person rejected the answer first.", approvalChanged: false });
    expect(stored.blocks[0]?.text).toBe(source.blocks[0]?.text);
  });
});
