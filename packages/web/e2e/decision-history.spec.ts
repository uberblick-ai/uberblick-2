import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { appendBlock, createAnnotation, decisionApprovalFingerprint, getMetaMap, initDoc, setKind, setStatus } from "@uberblick/schema";
import * as Y from "yjs";
import { activateControl, closeIfOpen, docTitle, editor, setupHarness } from "./app-helpers.js";
import { waitForAcknowledged } from "./settle.js";

const { harness, openApp } = setupHarness({ accessRole: "admin" });

function create(title: string, text: string, fields: {
  related?: string;
  topic?: string;
  supersedes?: string;
  status?: "open" | "decided";
} = {}) {
  const uuid = randomUUID();
  const doc = new Y.Doc();
  initDoc(doc, {
    uuid, title, description: "Decision document-history browser fixture.",
    ...(fields.related === undefined ? {} : { related: [fields.related] }),
    ...(fields.topic === undefined ? {} : { topic: fields.topic }),
    ...(fields.supersedes === undefined ? {} : { supersedes: fields.supersedes }),
  });
  const block = appendBlock(doc, { type: "paragraph", text });
  if (fields.status !== undefined) {
    setKind(doc, "decision");
    setStatus(doc, fields.status);
    if (fields.status === "decided") {
      const meta = getMetaMap(doc);
      meta.set("decidedBy", "Browser acceptance");
      meta.set("decidedAt", "2026-10-04T12:00:00Z");
      meta.set("decidedWhere", "https://example.org/decision");
      meta.set("approvalFingerprint", decisionApprovalFingerprint(doc));
    }
  }
  return { uuid, doc, block };
}

function history(page: Page): Locator {
  return page.getByRole("group", { name: "Document history", exact: true });
}

async function historyList(page: Page): Promise<void> {
  const list = page.getByRole("navigation", { name: "Revision history", exact: true });
  const show = page.getByRole("button", { name: "Show document list", exact: true });
  if (!await list.isVisible()) await activateControl(show);
  await expect(list).toBeVisible();
  const collapse = list.getByRole("switch", { name: "Collapse unchanged", exact: true });
  if (await collapse.getAttribute("aria-checked") === "true") await activateControl(collapse);
  await closeIfOpen(page.getByRole("button", { name: "Close document list", exact: true }), show);
}

async function decisionWithoutDocumentHistory(page: Page, uuid: string, text: string): Promise<void> {
  await expect(page.locator(`.ub-decision-timeline > li[data-record="${uuid}"] .ub-decision-record`)).toHaveAttribute("aria-current", "true");
  await expect(editor(page)).toHaveText(text);
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.locator(".ub-decision-answer-header")).toBeVisible();
  await expect(page.getByRole("region", { name: "Decision history", exact: true })).toBeVisible();
  await expect(page.locator(".ub-decision-timeline > li")).toHaveCount(3);
  await expect(history(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Previous revision|Next revision|Name current revision|Rename revision)$/ })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Revision name", exact: true })).toHaveCount(0);
  await expect(page.locator(".ub-revision-pane")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Revision history", exact: true })).toHaveCount(0);
  await expect(page.locator(".ub-document-rail")).not.toHaveCSS("display", "none");
  await expect(page.locator(".ub-document-rail")).not.toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: /^Copy revision /, includeHidden: true })).toHaveCount(1);
}

test("decision topics keep only their record timeline while regular pages retain document history", { tag: "@webkit" }, async ({ browser }) => {
  const owner = create(docTitle("Decision history owner"), "This regular page keeps document history.");
  const topicTitle = docTitle("Decision history topic");
  const firstText = "Earlier answer remains in the record timeline.";
  const currentText = "Current answer stays in force during review.";
  const pendingText = "Pending answer remains an open proposal.";
  const first = create(topicTitle, firstText, {
    status: "decided", related: owner.uuid,
  });
  const current = create(topicTitle, currentText, {
    status: "decided", topic: first.uuid, supersedes: first.uuid, related: owner.uuid,
  });
  const pending = create(topicTitle, pendingText, {
    status: "open", topic: first.uuid, supersedes: current.uuid, related: owner.uuid,
  });
  appendBlock(owner.doc, {
    type: "paragraph", inline: [{ text: "Read the decision topic", marks: { docLink: first.uuid } }],
  });
  createAnnotation(current.doc, current.block, 0, 7, "Browser acceptance", "The current answer's conversation remains available.");
  const fixtures = [owner, first, current, pending];
  try {
    for (const [index, fixture] of fixtures.entries()) {
      getMetaMap(fixture.doc).set("createdAt", Date.UTC(2026, 9, index + 1));
      await harness().seedDocument(fixture.doc);
    }
  } finally {
    for (const fixture of fixtures) fixture.doc.destroy();
  }

  const ownerPath = `/${harness().workspace}/${owner.uuid}`;
  const topicPath = `/${harness().workspace}/${first.uuid}`;
  const page = await openApp(browser, ownerPath);
  const decisions = page.getByRole("region", { name: "Decisions", exact: true });
  await expect(decisions.getByRole("link")).toHaveCount(1);
  await expect(editor(page).getByRole("link", { name: "Read the decision topic", exact: true })).toBeVisible();
  await expect(history(page)).toBeVisible();
  await waitForAcknowledged(page, { path: "upstream" });
  await activateControl(history(page).getByRole("button", { name: "Name current revision", exact: true }));
  const name = history(page).getByRole("textbox", { name: "Revision name", exact: true });
  await name.fill("Reviewed guidance");
  await name.press("Enter");
  await expect(page.getByText("Revision named", { exact: true })).toBeVisible();
  await activateControl(history(page).getByRole("button", { name: "Previous revision", exact: true }));
  await expect(page.locator(".ub-revision-pane")).toBeVisible();
  await expect(history(page)).toContainText("Reviewed guidance");
  await historyList(page);
  // Follow an authored link without reloading, while the regular page's history is open.
  await activateControl(page.locator(`.ub-revision-pane a.ub-doclink[data-doc-id="${first.uuid}"]`).last());
  await expect(page).toHaveURL(new RegExp(`${topicPath}$`));
  await decisionWithoutDocumentHistory(page, current.uuid, currentText);
  const threadsToggle = page.locator(".ub-threads-toggle");
  if (await threadsToggle.isVisible()) await activateControl(threadsToggle);
  await expect(page.getByRole("region", { name: "Threads", exact: true })).toContainText("The current answer's conversation remains available.");
  await closeIfOpen(page.getByRole("button", { name: "Close threads", exact: true }), threadsToggle);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${ownerPath}$`));
  await expect(history(page)).toBeVisible();
  await expect(history(page).getByRole("button", { name: "Name current revision", exact: true })).toBeVisible();
  await expect(page.locator(".ub-revision-pane")).toHaveCount(0);
  await activateControl(decisions.getByRole("link"));
  await decisionWithoutDocumentHistory(page, current.uuid, currentText);
  for (const [record, text] of [[first, firstText], [current, currentText], [pending, pendingText]] as const) {
    await activateControl(page.locator(`.ub-decision-timeline > li[data-record="${record.uuid}"] .ub-decision-record`));
    await expect(page).toHaveURL(new RegExp(`${topicPath}/record/${record.uuid}$`));
    await decisionWithoutDocumentHistory(page, record.uuid, text);
  }
  await expect(page.locator(".ub-decision-record-state")).toHaveText(["Under review", "In force", "Superseded"]);

  await page.goto(new URL(`/${harness().workspace}/${current.uuid}`, harness().appUrl).href);
  await decisionWithoutDocumentHistory(page, current.uuid, currentText);
  await page.goto(new URL(ownerPath, harness().appUrl).href);
  await expect(decisions.getByRole("link")).toHaveCount(1);
  await expect(history(page).getByRole("button", { name: "Name current revision", exact: true })).toBeVisible();
  await activateControl(history(page).getByRole("button", { name: "Previous revision", exact: true }));
  await expect(page.locator(".ub-revision-pane")).toBeVisible();
  await expect(history(page)).toContainText("Reviewed guidance");
  await historyList(page);
});
