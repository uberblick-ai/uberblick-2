// @vitest-environment node

import { readFileSync } from "node:fs";
import { TOKENS } from "@uberblick/ablauf";
import { expect, it } from "vitest";

it("declares every Ablauf paint token in the host stylesheet", () => {
  const source = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const declared = [...source.matchAll(/^\s*(--ab-[\w-]+)\s*:/gm)].map(match => match[1]);
  for (const token of TOKENS) expect(declared, token).toContain(`--ab-${token}`);
});
