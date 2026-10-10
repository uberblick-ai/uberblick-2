// SPIKE: the wireframe parser and renderer never throw, stay inert and bounded.
import { describe, expect, it } from "vitest";
import { parseWireframe, renderWireframe, WF_LIMITS, wireframeSummary } from "../src/editor/wireframe-render.js";

describe("wireframe spike parser", () => {
  it("builds a tree from two-space indentation with variants, attributes and labels", () => {
    const parse = parseWireframe("frame.phone w=300 Home\n  row align=end\n    button.primary Save changes\n  \"free text");
    expect(parse.diagnostics).toEqual([]);
    const frame = parse.roots[0];
    expect(frame).toMatchObject({ kind: "frame", variants: ["phone"], attrs: { w: "300" }, label: "Home", line: 1 });
    expect(frame?.children[0]?.children[0]).toMatchObject({ kind: "button", variants: ["primary"], label: "Save changes", line: 3 });
    expect(frame?.children[1]).toMatchObject({ kind: "text", label: "free text" });
  });

  it("reports problems with line numbers and still draws every line", () => {
    const parse = parseWireframe("frame\n  ??? odd\n  button w=1 w=2 Twice\n      text deep\n\tinput tabbed");
    const messages = parse.diagnostics.map(item => `${item.line}: ${item.message}`);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringMatching(/^2: .*not an element/),
      expect.stringMatching(/^3: Attribute w given twice/),
      expect.stringMatching(/^4: Indented more than one level/),
      expect.stringMatching(/^5: Tab in indentation/),
    ]));
    const root = renderWireframe(parse);
    expect(root.textContent).toContain("??? odd");
    expect(root.textContent).toContain("deep");
  });

  it("draws unknown kinds as labelled boxes and keeps hostile text as text", () => {
    const root = renderWireframe(parseWireframe("carousel 3 slides\ntext <img src=x onerror=alert(1)>\nicon not-real"));
    expect(root.querySelector(".wf-unknown")?.textContent).toContain("carousel");
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("produces inert output with nothing focusable", () => {
    const root = renderWireframe(parseWireframe("frame\n  button Go\n  input Name\n  textarea\n  link Docs\n  checkbox.on Agree"));
    expect(root.querySelectorAll("button, input, textarea, a, select, [tabindex]")).toHaveLength(0);
  });

  it("stops at its limits instead of doing unbounded work", () => {
    expect(parseWireframe("x".repeat(WF_LIMITS.chars + 1)).overLimit).toMatch(/longer than/);
    expect(parseWireframe("text a\n".repeat(WF_LIMITS.lines + 1)).overLimit).toMatch(/more than/);
    const deep = Array.from({ length: WF_LIMITS.depth + 1 }, (_, depth) => `${"  ".repeat(depth)}box`).join("\n");
    expect(parseWireframe(deep).overLimit).toMatch(/Nesting deeper/);
  });

  it("summarises frames for assistive technology", () => {
    expect(wireframeSummary(parseWireframe("frame.phone Topics\n  text a\nframe.phone Call"))).toBe(
      "Wireframe, 2 screens (Topics, Call), 3 elements");
  });
});
