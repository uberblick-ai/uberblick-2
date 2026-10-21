import { describe, expect, it } from "vitest";
import { shortenCodePath } from "../src/ui/status/CodeCheckPaths.js";

describe("code-check path fitting", () => {
  const measure = (text: string): number => Array.from(text).length;

  it("keeps fitting paths intact and cuts only whole leading folders", () => {
    expect(shortenCodePath("src/file.ts", 11, measure)).toBe("src/file.ts");
    expect(shortenCodePath("packages/web/src/mcp/module/something.ts", 26, measure)).toBe("…/mcp/module/something.ts");
    expect(shortenCodePath("../.hidden/module/file.ts", 19, measure)).toBe("…/module/file.ts");
  });

  it("keeps the filename whole unless it alone exceeds the row", () => {
    expect(shortenCodePath("src/filename.ts", 13, measure)).toBe("…/filename.ts");
    expect(shortenCodePath("src/very-long-filename.ts", 13, measure)).toBe("…/very-long-…");
    expect(shortenCodePath("very-long-filename.ts", 13, measure)).toBe("very-long-fi…");
  });
});
