import { describe, expect, it } from "vitest";
import { renderAuthCode } from "../src/auth-code-output.js";

describe("approval-code block letters", () => {
  it("covers every hub-code character with a distinct five-by-five glyph", () => {
    const rendered = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-", character => {
      const lines = renderAuthCode(character);
      expect(lines).toHaveLength(5);
      for (const line of lines) expect(line).toMatch(/^ {2}[█ ]{5}$/u);
      expect(lines.join("")).toContain("█");
      return lines.join("\n");
    });
    expect(new Set(rendered).size).toBe(37);
  });

  it.each([["0", "O"], ["1", "I"], ["5", "S"], ["8", "B"], ["2", "Z"]])(
    "keeps the look-alike pair %s/%s distinct",
    (digit, letter) => {
      expect(renderAuthCode(digit)).not.toEqual(renderAuthCode(letter));
    },
  );

  it("renders the sample code with two-space gaps and indentation in 63 columns", () => {
    const lines = renderAuthCode("WDJB-MJHT");
    expect(lines).toEqual([
      "  █   █  ████     ███  ████          █   █    ███  █   █  █████",
      "  █   █  █   █      █  █   █         ██ ██      █  █   █    █  ",
      "  █ █ █  █   █      █  ████    ███   █ █ █      █  █████    █  ",
      "  ██ ██  █   █  █   █  █   █         █   █  █   █  █   █    █  ",
      "  █   █  ████    ███   ████          █   █   ███   █   █    █  ",
    ]);
    for (const line of lines) expect(line).toHaveLength(63);
  });
});
