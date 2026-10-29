import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import type { AnnotationComment } from "@uberblick/schema";
import { act, render } from "./react-render.js";
import { CommentByline, CommentEdited } from "../src/ui/comments/CommentByline.js";

const now = Date.parse("2026-10-26T12:00:00Z");
const comment: AnnotationComment = {
  author: "Ben Kubota",
  text: "Keep the display name stored with this comment.",
  createdAt: "2026-10-26T11:00:00Z",
};

beforeEach(() => vi.spyOn(navigator, "onLine", "get").mockReturnValue(true));

describe("comment attribution", () => {
  it("shows a muted inline edit marker with the edit time as its tooltip", () => {
    const editedAt = "2026-10-26T11:55:00Z";
    const { container } = render(<span>Revised text <CommentEdited editedAt={editedAt} now={now} /></span>);
    const marker = within(container).getByText("(edited)");
    expect(marker.tagName).toBe("TIME");
    expect(marker.getAttribute("dateTime")).toBe("2026-10-26T11:55:00.000Z");
    expect(marker.className).toContain("text-(--muted-foreground)");
    expect(marker.getAttribute("title")).toBe(new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium", timeStyle: "short",
    }).format(Date.parse(editedAt)));
  });

  it("keeps the stored author and uses the newest time beneath an opener", () => {
    const { container } = render(<CommentByline comment={{ ...comment, account: "bk-one" }} now={now} updatedAt="2026-10-26T11:55:00Z" />);
    expect(container.querySelector(".ub-thread-author")?.textContent).toBe("Ben Kubota");
    expect(container.querySelector("time")?.textContent).toBe("Updated 5 minutes ago");
    expect(container.querySelector("time")?.dateTime).toBe("2026-10-26T11:55:00.000Z");
    expect(container.querySelector("img")?.src).toBe("https://avatars.githubusercontent.com/bk-one?s=64");
  });

  it("falls back to neutral initials for absent, failed and offline avatars", () => {
    const { container, rerender } = render(<CommentByline comment={comment} now={now} />);
    expect(container.querySelector(".ub-comment-avatar")?.textContent).toBe("BK");
    expect(container.querySelector("img")).toBeNull();
    rerender(<CommentByline comment={{ ...comment, account: "bk-one" }} now={now} />);
    const avatar = container.querySelector("img");
    expect(avatar).not.toBeNull();
    fireEvent.error(avatar as HTMLImageElement);
    expect(container.querySelector(".ub-comment-avatar")?.textContent).toBe("BK");
    expect(container.querySelector("img")).toBeNull();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("offline")));
    rerender(<CommentByline comment={{ ...comment, account: "other-account" }} now={now} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".ub-comment-avatar")?.textContent).toBe("BK");
  });

  it.each(["claude", "codex"] as const)("labels the bundled %s mark without changing the author", (agent) => {
    const { container } = render(<CommentByline comment={{ ...comment, author: "Agent client", kind: "agent", account: "bk-one", agent }} now={now} />);
    const name = agent === "claude" ? "via Claude" : "via Codex";
    expect(within(container).getByRole("img", { name })).toBeTruthy();
    expect(container.querySelector(`[data-icon="${agent}"] svg`)).not.toBeNull();
    expect(container.querySelector(".ub-thread-author")?.textContent).toBe("Agent client");
    expect(container.querySelector("time")?.textContent).toBe("1 hour ago");
  });

  it.each([
    { clientName: "Cursor", label: "via Cursor" },
    { clientName: "Other <client>", label: "via Other <client>" },
    { label: "via unknown MCP client" },
  ])("labels a generic agent mark $label without visible attribution text", ({ clientName, label }) => {
    const { container } = render(<CommentByline comment={{ ...comment, kind: "agent", ...(clientName === undefined ? {} : { clientName }) }} now={now} />);
    const mark = within(container).getByRole("img", { name: label });
    expect(mark.textContent).toBe("");
    expect(mark.querySelector("svg")).not.toBeNull();
    expect(mark.querySelector("[data-icon]")).toBeNull();
    expect(mark.style.color).toBe("");
    expect(container.querySelector(".ub-thread-author")?.textContent).toBe("Ben Kubota");
  });

  it.each([
    comment,
    { ...comment, kind: "person" as const },
  ])("gives browser and legacy comments no agent mark", (value) => {
    const { container } = render(<CommentByline comment={value} now={now} />);
    expect(container.querySelector(".ub-comment-agent")).toBeNull();
  });
});
