import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import type { AnnotationComment } from "@uberblick/schema";
import { act, render } from "./react-render.js";
import { CommentByline } from "../src/ui/comments/CommentByline.js";

const now = Date.parse("2026-10-26T12:00:00Z");
const comment: AnnotationComment = {
  author: "Ben Kubota",
  text: "Keep the display name stored with this comment.",
  createdAt: "2026-10-26T11:00:00Z",
};

beforeEach(() => vi.spyOn(navigator, "onLine", "get").mockReturnValue(true));

describe("comment attribution", () => {
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

  it("gives legacy and generic agent comments no product mark", () => {
    const { container, rerender } = render(<CommentByline comment={comment} now={now} />);
    expect(container.querySelector(".ub-comment-agent")).toBeNull();
    rerender(<CommentByline comment={{ ...comment, kind: "agent" }} now={now} />);
    expect(container.querySelector(".ub-comment-agent")).toBeNull();
  });
});
