/** Enforce the synchronous write phase documented at guarded. */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { MUTATING_TOOLS, READ_ONLY_TOOLS } from "../src/failures.js";
import { PACKAGE_ROOT } from "./helpers.js";

function parse(source: string, path = "handler.ts"): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
}

function awaits(node: ts.Node): ts.AwaitExpression[] {
  const found: ts.AwaitExpression[] = [];
  function visit(child: ts.Node): void {
    if (ts.isAwaitExpression(child)) found.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

function bodyOf(handler: ts.Node): ts.ConciseBody {
  if ((!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler) &&
      !ts.isFunctionDeclaration(handler)) || handler.body === undefined) {
    throw new Error("The invariant requires an inline function body.");
  }
  return handler.body;
}

function expectOpeningWait(
  handler: ts.Node,
  source: ts.SourceFile,
  expression: RegExp,
  skipUnsettledTools = false,
): void {
  const waits = awaits(handler);
  expect(waits).toHaveLength(1);
  const wait = waits[0]!;
  expect(wait.expression.getText(source)).toMatch(expression);
  const body = bodyOf(handler);
  if (!ts.isBlock(body)) {
    expect(body).toBe(wait);
    return;
  }
  const first = body.statements[0]!;
  if (skipUnsettledTools) {
    expect(ts.isIfStatement(first)).toBe(true);
    const branch = first as ts.IfStatement;
    expect(branch.expression.getText(source)).toMatch(
      /^tool\s*!==\s*["']sync_status["']\s*&&\s*tool\s*!==\s*["']get_help["']$/,
    );
    expect(branch.thenStatement).toBe(wait.parent);
    expect(branch.elseStatement).toBeUndefined();
  } else {
    expect(first).toBe(wait.parent);
  }
}

function expectSynchronousBody(handler: ts.Node): void {
  bodyOf(handler);
  expect(awaits(handler)).toHaveLength(0);
}

interface OperationBody {
  tool: string;
  handler: ts.Node;
  source: ts.SourceFile;
}

/** Follow the named import used by a registration to its inspected declaration. */
function importedOperationKey(name: string, source: ts.SourceFile): string {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const imported = bindings.elements.find((element) => element.name.text === name);
    if (imported === undefined) continue;
    const path = resolve(dirname(source.fileName), statement.moduleSpecifier.text.replace(/\.js$/, ".ts"));
    return `${path}:${imported.propertyName?.text ?? imported.name.text}`;
  }
  throw new Error(`No operation import for ${name} in ${source.fileName}`);
}

it("every registered tool is guarded and its operation works synchronously after opening settle", () => {
  const root = join(PACKAGE_ROOT, "src");
  const sources = (readdirSync(root, { recursive: true }) as string[])
    .filter((path) => path.endsWith(".ts"))
    .map((path) => parse(readFileSync(join(root, path), "utf8"), join(root, path)));
  const operations = new Map<string, OperationBody>();
  for (const source of sources) {
    function visit(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
          node.initializer !== undefined && ts.isCallExpression(node.initializer)) {
        const call = node.initializer;
        if (["operation", "documentOperation", "sidebarOperation"].includes(call.expression.getText(source)) &&
            call.arguments[0] !== undefined && ts.isStringLiteral(call.arguments[0])) {
          operations.set(`${source.fileName}:${node.name.text}`, {
            tool: call.arguments[0].text, handler: call.arguments[2]!, source,
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  const registered: string[] = [];
  for (const source of sources) {
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "registerTool") {
        const name = (node.arguments[0] as ts.StringLiteral).text;
        registered.push(name);
        const guard = node.arguments[2]!;
        expect(ts.isCallExpression(guard), name).toBe(true);
        const call = guard as ts.CallExpression;
        expect(call.expression.getText(source), name).toBe("guarded");
        expect(call.arguments[0]?.getText(source), name).toBe(node.arguments[0]!.getText(source));
        expect(call.arguments[1]?.getText(source), name).toBe("context");
        const reference = call.arguments[2]!;
        expect(ts.isIdentifier(reference), name).toBe(true);
        const operation = operations.get(importedOperationKey((reference as ts.Identifier).text, source));
        if (operation === undefined) throw new Error(`No inspected operation for ${name}`);
        expect(operation.tool, name).toBe(name);
        if (name === "sync_status") {
          // This read delegates its opening settle to the shared status helper.
          expectOpeningWait(operation.handler, operation.source, /^collectSyncStatus\(context\.replicas\)$/);
        } else {
          expectSynchronousBody(operation.handler);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(registered.sort()).toEqual([...MUTATING_TOOLS, ...READ_ONLY_TOOLS].sort());
  const wrapper = sources.find((source) => source.fileName === join(root, "tools/operation.ts"))!;
  for (const name of ["operation", "documentOperation", "sidebarOperation"]) {
    const node = wrapper.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    if (node?.body === undefined) throw new Error(`No inspected ${name} wrapper`);
    if (name === "operation") {
      const returned = node.body.statements.find(ts.isReturnStatement)!;
      expectOpeningWait(returned.expression!, wrapper, /^context\.replicas\.settle\(/, true);
    } else {
      // The shared write wrappers must not introduce a new interleaving either.
      expectSynchronousBody(node);
    }
  }
  const status = sources.find((source) => source.fileName === join(root, "status.ts"))!;
  const collect = status.statements.find((node) => ts.isFunctionDeclaration(node) &&
    node.name?.text === "collectSyncStatus")!;
  expectOpeningWait(collect, status, /^replicas\.settle\(/);
});

it("the invariant check rejects an added await after settle", () => {
  const source = parse("async function handler() { await replicas.settle(); await anotherWriter(); write(); }");
  expect(() => expectOpeningWait(source.statements[0]!, source, /^replicas\.settle\(/)).toThrow();
});

it.each([
  "async function handler() { write(); await anotherWriter(); write(); }",
  "function handler() { write(); void (async () => { await anotherWriter(); write(); })(); }",
])("the invariant check rejects an await in an operation body: %s", (fixture) => {
  const source = parse(fixture);
  expect(() => expectSynchronousBody(source.statements[0]!)).toThrow();
});
