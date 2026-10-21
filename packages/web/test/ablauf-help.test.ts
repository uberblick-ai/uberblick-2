// @vitest-environment node

import { readFileSync } from "node:fs";
import { render } from "@uberblick/ablauf";
import { expect, it } from "vitest";
import { HelpCatalog } from "../../mcp-server/src/help.js";

it("renders the published flow and fan-out help examples without diagnostics", () => {
  const text = new HelpCatalog().read("ablauf").text;
  const examples = [...text.matchAll(/^```ablauf\n([\s\S]*?)\n```/gm)]
    .map((match) => match[1]!);
  expect(examples.map((source) => source.split("\n")[0])).toEqual(
    expect.arrayContaining(["flow v0", "fan-out v0"]),
  );
  for (const source of examples) {
    const result = render(source);
    expect(result.diagnostics, source).toEqual([]);
    expect(result.svg).toContain("<svg");
  }
});

it("ends the help with the primer at the web editor's declared ablauf version", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies: { "@uberblick/ablauf": string };
  };
  const specifier = manifest.dependencies["@uberblick/ablauf"];
  const version = /^\^?(\d+\.\d+\.\d+)$/.exec(specifier)?.[1];
  expect(version, `Unrecognized ablauf version specifier: ${specifier}`).toBeDefined();
  const text = new HelpCatalog().read("ablauf").text.trim();
  const closingLink = text.match(/\]\(([^)\s]+)\)\.?$/)?.[1];
  expect(closingLink).toBe(`https://github.com/uberblick-ai/ablauf/blob/v${version}/spike/PRIMER.md`);
});
