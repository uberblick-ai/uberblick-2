// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source checks defend the single scale; browser tests own the cascade,
// rendered roles, contrast and the coarse-pointer field minimum.
const sourceRoot = new URL("../src/", import.meta.url);
const files = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.(?:css|[jt]sx?|html)$/.test(file))
  .map((file) => ({ file, text: readFileSync(new URL(file, sourceRoot), "utf8") }));
const cleanCss = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "");
const stylesheet = cleanCss(files.find(({ file }) => file === "ui/styles.css")?.text ?? "");
const roots = [...stylesheet.matchAll(/(?:^|\n):root\s*\{([^}]*)\}/g)];
const declarations = roots.flatMap((root) => [...(root[1] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]);
const sizes = declarations.filter((match) => match[1]?.endsWith("-size"));
const sizeNames = new Set(sizes.map((match) => match[1]));
const expectedScale = ["12px/16px", "13px/18px", "14px/20px", "16px/27px", "18px/24px", "22px/28px", "36px/42px"];

describe("product typography source contract", () => {
  it("defines the seven size and leading pairs once, outside Tailwind theme namespaces", () => {
    expect(roots).toHaveLength(1);
    expect(sizes).toHaveLength(7);
    expect(sizeNames.size).toBe(7);
    const scale = sizes.map((match) => {
      const name = match[1] ?? "";
      expect(name).not.toMatch(/^--(?:text|leading|font)-/);
      const leadingName = name.replace(/-size$/, "-leading");
      const leading = declarations.filter((entry) => entry[1] === leadingName);
      expect(leading, leadingName).toHaveLength(1);
      return `${match[2]?.trim()}/${leading[0]?.[2]?.trim()}`;
    });
    expect(scale.sort()).toEqual(expectedScale.toSorted());
    expect(declarations.filter((match) => match[1]?.endsWith("-leading"))).toHaveLength(7);
    for (const name of sizeNames) {
      const definition = new RegExp(`${name}\\s*:`, "g");
      expect(files.flatMap(({ text }) => [...cleanCss(text).matchAll(definition)]), name).toHaveLength(1);
    }
  });

  it("uses scale tokens for CSS sizes and font shorthands, apart from badge, inline-code and hidden-source exceptions", () => {
    const failures: string[] = [];
    for (const { file, text } of files.filter(({ file }) => file.endsWith(".css"))) {
      for (const rule of cleanCss(text).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = rule[1]?.trim() ?? "";
        for (const declaration of (rule[2] ?? "").matchAll(/(?:^|;)\s*(font-size|font)\s*:\s*([^;]+)/g)) {
          const property = declaration[1];
          const value = declaration[2]?.trim() ?? "";
          if (value === "inherit") continue;
          if (property === "font-size" && (
            (selector === ".ub-avatar-agent-badge" && value === "8px") ||
            (selector === ".ub-inline-code" && value === "0.85em") ||
            (selector.replace(/\s+/g, "") === ".ub-github-link-text,.ub-person-mention-text,.ub-toggle-heading-marker,.ub-inline-icon-text" && value === "0")
          )) continue;
          const token = property === "font-size"
            ? /^var\((--[\w-]+)\)$/.exec(value)?.[1]
            : /^(?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]00)\s+)*var\((--[\w-]+)\)(?:\s*\/|\s)/.exec(value)?.[1];
          if (!sizeNames.has(token)) failures.push(`${file}: ${selector}: ${property}: ${value}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps component sizes on product utilities, including responsive variants", () => {
    const failures: string[] = [];
    for (const { file, text } of files.filter(({ file }) => /\.[jt]sx?$/.test(file))) {
      const source = file === "ui/shadcn/button.tsx" ? text.replaceAll("after:text-[0.55rem]", "") : text;
      for (const match of source.matchAll(/\btext-(?:xs|sm|base|lg|xl|[2-9]xl)\b|\btext-\[([^\]\n]+)\]/g)) {
        const arbitrary = match[1];
        if (arbitrary === undefined || /^(?:length:|[+-]?(?:\d|\.\d)|(?:calc|clamp|min|max)\(|var\(--(?:type|text)-)/.test(arbitrary)) {
          failures.push(`${file}: ${match[0]}`);
        }
      }
      for (const match of source.matchAll(/\[font(?:-size)?:([^\]\n]+)\]/g)) {
        if (match[1] !== "inherit") failures.push(`${file}: ${match[0]}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
