import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it("keeps the transitive operation and failure path free of SDK value and type imports", () => {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const configFile = ts.readConfigFile(join(packageRoot, "tsconfig.json"), ts.sys.readFile);
  expect(configFile.error).toBeUndefined();
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, packageRoot);
  expect(config.errors).toEqual([]);
  // Compiler resolution follows workspace package exports and type-only edges.
  // Exclude automatically included test globals; they are outside this path.
  const program = ts.createProgram({
    rootNames: ["operations.ts", "tools/context.ts", "failures.ts"].map(file => join(packageRoot, "src", file)),
    options: { ...config.options, types: [] },
  });
  const sources = program.getSourceFiles();
  expect(sources.some(source => source.fileName.endsWith("/src/operations.ts"))).toBe(true);
  const sdkEdges = sources.flatMap(source => {
    const imports = ts.preProcessFile(source.text, true, true).importedFiles;
    return imports
      .filter(imported => imported.fileName.startsWith("@modelcontextprotocol/sdk"))
      .map(imported => `${source.fileName}: ${imported.fileName}`);
  });
  expect(sdkEdges).toEqual([]);
  expect(sources.filter(source => /[/@]modelcontextprotocol(?:\+|\/)sdk/.test(source.fileName)).map(source => source.fileName)).toEqual([]);
});
