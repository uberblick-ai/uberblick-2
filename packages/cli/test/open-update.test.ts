import { afterEach, describe, expect, it, vi } from "vitest";
import { formulaVersion, isNewerVersion, startUpdateCheck, type UpdateCheck } from "../src/open-update.js";

const FORMULA = `class Uberblick < Formula
  desc "Local-first collaborative documents for people and agents"
  url "https://github.com/uberblick-ai/homebrew-tap/releases/download/v0.4.12/uberblick-0.4.12.tar.gz"
  version "0.4.12"
end
`;

function answering(...answers: (string | Error | number)[]) {
  return vi.fn(async () => {
    const answer = answers.shift() ?? new Error("no more answers");
    if (answer instanceof Error) throw answer;
    return typeof answer === "number" ? new Response("", { status: answer }) : new Response(answer);
  });
}

describe("ub open update check", () => {
  let check: UpdateCheck | null = null;
  afterEach(() => {
    check?.stop();
    check = null;
    vi.useRealTimers();
  });

  it("reads the formula's version line", () => {
    expect(formulaVersion(FORMULA)).toBe("0.4.12");
    expect(formulaVersion("class Uberblick < Formula\nend\n")).toBeNull();
  });

  it("offers only a plain release that is newer", () => {
    expect(isNewerVersion("0.4.11", "0.4.12")).toBe(true);
    expect(isNewerVersion("0.4.9", "0.4.10")).toBe(true);
    expect(isNewerVersion("0.4.12", "0.5.0")).toBe(true);
    expect(isNewerVersion("0.4.12", "0.4.12")).toBe(false);
    expect(isNewerVersion("0.4.12", "0.4.11")).toBe(false);
    expect(isNewerVersion("0.4.11", "0.4.12-rc.1")).toBe(false);
    expect(isNewerVersion("0.0.0-dev", "0.4.12")).toBe(false);
  });

  it("offers the newer version with the release notes, then rereads hourly", async () => {
    vi.useFakeTimers();
    const fetchImpl = answering(FORMULA, FORMULA.replaceAll("0.4.12", "0.4.13"));
    check = startUpdateCheck("0.4.11", fetchImpl, 60 * 60 * 1_000);
    await vi.waitFor(() => expect(check?.available()).not.toBeNull());
    expect(check.available()).toEqual({
      current: "0.4.11",
      latest: "0.4.12",
      notesUrl: "https://github.com/uberblick-ai/uberblick-2/blob/main/CHANGELOG.md",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(check.available()?.latest).toBe("0.4.13");
  });

  it("says nothing when up to date, offline or answered with something else", async () => {
    vi.useFakeTimers();
    const fetchImpl = answering(FORMULA, new TypeError("fetch failed"), 404, "<html>rate limited</html>");
    check = startUpdateCheck("0.4.12", fetchImpl, 1_000);
    for (let reads = 1; reads <= 4; reads += 1) {
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(reads));
      expect(check.available()).toBeNull();
      await vi.advanceTimersByTimeAsync(1_000);
    }
  });

  it("keeps the last answer through a failed reread", async () => {
    vi.useFakeTimers();
    const fetchImpl = answering(FORMULA, new TypeError("fetch failed"));
    check = startUpdateCheck("0.4.11", fetchImpl, 1_000);
    await vi.waitFor(() => expect(check?.available()?.latest).toBe("0.4.12"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(check.available()?.latest).toBe("0.4.12");
  });
});
