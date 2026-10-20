import { resolveDecisionTopics } from "@uberblick/schema";
import type { DirectoryEntry } from "@uberblick/schema";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "./react-render.js";
import { DecisionsBlock, DecisionsLink, decisionsSummary } from "../src/ui/document/DecisionsBlock.js";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const FIRST = "00000000-0000-4000-8000-000000000001";
const SECOND = "00000000-0000-4000-8000-000000000002";
const THIRD = "00000000-0000-4000-8000-000000000003";
const FOURTH = "00000000-0000-4000-8000-000000000004";
const FIFTH = "00000000-0000-4000-8000-000000000005";
const SIXTH = "00000000-0000-4000-8000-000000000006";
const ID = "decisions-page";

function record(uuid: string, title: string, patch: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return { uuid, title, tags: [], kind: "decision", status: "decided", topic: uuid, createdAt: 1, answerPreview: `Answer to ${title}`, ...patch };
}

function block(records: DirectoryEntry[], navigate = vi.fn()) {
  const topics = resolveDecisionTopics(records);
  return render(<DecisionsBlock topics={topics} segment="workspace" navigate={navigate} id={ID} />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the compact Decisions block", () => {
  it("omits both surfaces without related topics", () => {
    const view = render(<>
      <DecisionsLink topics={[]} id={ID} />
      <DecisionsBlock topics={[]} segment="workspace" navigate={vi.fn()} id={ID} />
    </>);
    expect(view.container.childElementCount).toBe(0);
  });

  it("orders states, then questions, and shares their text in accessible link names", () => {
    const host = block([
      record(FIRST, "Zebra answer"),
      record(SECOND, "Alpha answer"),
      record(THIRD, "Agent answer", { agentStance: true }),
      record(FOURTH, "Open question", { status: "open" }),
      record(FIFTH, "Review question"),
      record(`${FIFTH}-pending`, "Pending title", { topic: FIFTH, supersedes: FIFTH, status: "open", createdAt: 2 }),
      record(SIXTH, "Conflict first"),
      record(`${SIXTH}-other`, "Conflict latest", { topic: SIXTH, createdAt: 2 }),
    ]).container;
    expect(within(host).getByRole("region", { name: "Decisions" }).getAttribute("tabindex")).toBe("-1");
    expect(within(host).getAllByRole("link").map((link) => link.getAttribute("aria-label"))).toEqual([
      "Conflict: Conflict first", "Under review: Review question", "In force: Alpha answer",
      "In force: Zebra answer", "Agent stance: Agent answer", "Not yet decided: Open question",
    ]);
    expect(host.querySelectorAll('.ub-decisions-mark[aria-hidden="true"]')).toHaveLength(6);
  });

  it("keeps the current question and preview while reviewing, and never shows conflicting or undecided answers", () => {
    const host = block([
      record(FIRST, "Current question", { answerPreview: "Current answer" }),
      record(SECOND, "Pending question", { topic: FIRST, status: "open", supersedes: FIRST, createdAt: 2, answerPreview: "Pending answer" }),
      record(THIRD, "Conflict first", { answerPreview: "Conflicting first answer" }),
      record(FOURTH, "Conflict latest", { topic: THIRD, createdAt: 2, answerPreview: "Conflicting latest answer" }),
      record(FIFTH, "Unanswered question", { status: "open", answerPreview: "Unapproved answer" }),
      record(SIXTH, "Agent question", { agentStance: true, answerPreview: "Agent answer" }),
    ]).container;
    const review = within(host).getByRole("link", { name: "Under review: Current question" });
    expect(review.textContent).toContain("Current answer");
    expect(review.querySelector(".ub-decisions-question")?.getAttribute("title")).toBe("Current question");
    expect(review.querySelector(".ub-decisions-row-preview")?.getAttribute("title")).toBe("Current answer");
    expect(review.textContent).not.toContain("Pending");
    expect(within(host).getByRole("link", { name: "Conflict: Conflict first" }).textContent).toContain("Nothing is in force.");
    expect(host.textContent).not.toContain("Conflicting first answer");
    expect(host.textContent).not.toContain("Conflicting latest answer");
    expect(within(host).getByRole("link", { name: "Not yet decided: Unanswered question" }).querySelector(".ub-decisions-row-preview")).toBeNull();
    expect(within(host).getByRole("link", { name: "Agent stance: Agent question" }).textContent).toContain("Agent answer");
  });

  it("uses only cached previews and leaves null and unknown caches out", () => {
    const unknown = { ...record(SECOND, "Unknown cache"), tldr: "Legacy summary does not fill the cache" };
    delete unknown.answerPreview;
    const host = block([
      record(FIRST, "Null cache", { answerPreview: null }),
      unknown,
    ]).container;
    expect(host.querySelector(".ub-decisions-row-preview")).toBeNull();
    expect(host.textContent).not.toContain("Legacy summary");
  });

  it("shows stored answerers, compact valid dates and a state fallback without usable attribution", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const host = block([
      record(FIRST, "Human answer", { decidedBy: "Ben (@bk-one)", decidedAt: "2026-10-07T12:00:00Z" }),
      record(SECOND, "Answerer only", { decidedBy: "bk-one", decidedAt: "not a date" }),
      record(THIRD, "Date only", { decidedAt: "2026-10-10" }),
      record(FOURTH, "No attribution"),
      record(FIFTH, "Invalid date", { decidedAt: "unparseable" }),
    ]).container;
    const answer = within(host).getByRole("link", { name: "In force: Human answer" });
    expect(answer.querySelector(".ub-decisions-row-meta")?.textContent).toBe("Ben (@bk-one) · 5d");
    const date = answer.querySelector("time");
    expect(date?.getAttribute("datetime")).toBe("2026-10-07T12:00:00.000Z");
    expect(date?.getAttribute("title")).toBeTruthy();
    expect(within(host).getByRole("link", { name: "In force: Answerer only" }).querySelector(".ub-decisions-row-meta")?.textContent).toBe("bk-one");
    expect(within(host).getByRole("link", { name: "In force: Date only" }).querySelector("time")?.textContent).toBe("2d");
    for (const question of ["No attribution", "Invalid date"]) {
      expect(within(host).getByRole("link", { name: `In force: ${question}` }).querySelector(".ub-decisions-row-meta")?.textContent).toBe("In force");
    }
  });

  it("navigates current topic addresses on ordinary clicks and leaves modified clicks native", () => {
    const navigate = vi.fn();
    const host = block([record(FIRST, "Topic question")], navigate).container;
    const link = within(host).getByRole("link", { name: "In force: Topic question" });
    expect(link.getAttribute("href")).toBe(`/workspace/${FIRST}`);
    expect(fireEvent.click(link)).toBe(false);
    expect(navigate).toHaveBeenCalledWith(`/workspace/${FIRST}`);
    for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
      expect(fireEvent.click(link, { [modifier]: true })).toBe(true);
    }
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("jumps and focuses the block through the header's native anchor", () => {
    const topics = resolveDecisionTopics([record(FIRST, "Topic question")]);
    const scroll = vi.fn();
    const view = render(<>
      <DecisionsLink topics={topics} id={ID} />
      <DecisionsBlock topics={topics} segment="workspace" navigate={vi.fn()} id={ID} />
    </>);
    const section = within(view.container).getByRole("region", { name: "Decisions" });
    section.scrollIntoView = scroll;
    const link = within(view.container).getByRole("link", { name: "1 decision in force" });
    expect(link.textContent).toBe("1 decision in force");
    expect(link.getAttribute("href")).toBe(`#${ID}`);
    expect(fireEvent.click(link)).toBe(false);
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(section);
    for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
      expect(fireEvent.click(link, { [modifier]: true })).toBe(true);
    }
    expect(scroll).toHaveBeenCalledOnce();
  });
});

describe("decision summaries", () => {
  it("counts topics, uses singular and lists non-in-force states in block order", () => {
    expect(decisionsSummary(resolveDecisionTopics([record(FIRST, "One")]))).toBe("1 decision in force");
    expect(decisionsSummary(resolveDecisionTopics([record(FIRST, "One"), record(SECOND, "Two")]))).toBe("2 decisions in force");
    expect(decisionsSummary(resolveDecisionTopics([
      record(FIRST, "One"),
      record(SECOND, "Pending", { status: "open", topic: FIRST, supersedes: FIRST, createdAt: 2 }),
      record(THIRD, "Two"),
    ]))).toBe("2 decisions · 1 under review");
    expect(decisionsSummary(resolveDecisionTopics([
      record(FIRST, "Conflict"), record(SECOND, "Other conflict", { topic: FIRST }),
      record(THIRD, "Stance", { agentStance: true }),
      record(FOURTH, "Open", { status: "open" }), record(FIFTH, "Human"),
    ]))).toBe("4 decisions · 1 conflict · 1 agent stance · 1 not yet decided");
  });
});
