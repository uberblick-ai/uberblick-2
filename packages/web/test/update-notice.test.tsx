/** The update notice names a newer release and its fix, and stays closed until the next one. */
import { within } from "@testing-library/react";
import { act, cleanup, renderSettled } from "./react-render.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AvailableUpdate, DocumentSearchClient } from "../src/shell/document-search.js";
import { UPDATE_NOTICE_POLL_MS, UpdateNotice } from "../src/ui/shell/ShellNotices.js";

const NOTES = "https://github.com/uberblick-ai/uberblick-2/blob/main/CHANGELOG.md";

function client(...answers: (AvailableUpdate | null | Error)[]): DocumentSearchClient {
  return {
    status: vi.fn(async () => ({ caughtUp: true, rooms: {} })),
    search: vi.fn(async () => []),
    update: vi.fn(async () => {
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    }),
  };
}

function offer(latest: string): AvailableUpdate {
  return { current: "0.4.11", latest, notesUrl: NOTES };
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

it("names the newer version, the fix and the release notes", async () => {
  const view = await renderSettled(<UpdateNotice client={client(offer("0.4.12"))} />);
  const notice = within(view.container).getByRole("status");
  expect(notice.textContent).toContain("Uberblick 0.4.12 is available.");
  expect(notice.textContent).toContain("You have 0.4.11.");
  expect(notice.textContent).toContain("Run ub update, then restart ub open.");
  const notes = within(notice).getByRole("link", { name: "Release notes" });
  expect(notes.getAttribute("href")).toBe(NOTES);
  expect(notes.getAttribute("target")).toBe("_blank");
});

it("shows nothing without a serving ub open, a newer version or a usable answer", async () => {
  for (const api of [null, client(null), client(new Error("ub open answered 500"))]) {
    const view = await renderSettled(<UpdateNotice client={api} />);
    expect(view.container.textContent).toBe("");
    cleanup();
  }
});

it("stays closed for the dismissed version and returns for a newer one", async () => {
  const api = client(offer("0.4.12"), offer("0.4.12"), offer("0.4.13"));
  const view = await renderSettled(<UpdateNotice client={api} />);
  await act(async () => {
    within(view.container).getByRole("button", { name: "Dismiss update notice" }).click();
  });
  expect(view.container.textContent).toBe("");

  await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_NOTICE_POLL_MS); });
  expect(api.update).toHaveBeenCalledTimes(2);
  expect(view.container.textContent).toBe("");

  await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_NOTICE_POLL_MS); });
  expect(within(view.container).getByRole("status").textContent).toContain("Uberblick 0.4.13 is available.");
});

it("keeps the notice through a failed reread", async () => {
  const api = client(offer("0.4.12"), new Error("ub open answered 500"));
  const view = await renderSettled(<UpdateNotice client={api} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_NOTICE_POLL_MS); });
  expect(api.update).toHaveBeenCalledTimes(2);
  expect(within(view.container).getByRole("status").textContent).toContain("0.4.12");
});
