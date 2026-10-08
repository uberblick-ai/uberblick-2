/** Enforce the synchronous write phase documented at guarded. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { MUTATING_TOOLS, READ_ONLY_TOOLS } from "../src/failures.js";
import { PACKAGE_ROOT } from "./helpers.js";

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("handler.ts", source, ts.ScriptTarget.Latest, true);
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

function expectOpeningSettle(handler: ts.Node, source: ts.SourceFile): void {
  const waits = awaits(handler);
  expect(waits.map((wait) => wait.expression.getText(source))).toHaveLength(1);
  expect(waits[0]!.expression.getText(source)).toMatch(/^replicas\.settle\(/);
  expect(ts.isArrowFunction(handler) || ts.isFunctionDeclaration(handler)).toBe(true);
  const body = (handler as ts.ArrowFunction | ts.FunctionDeclaration).body!;
  expect(ts.isBlock(body)).toBe(true);
  expect((body as ts.Block).statements[0]!.getText(source)).toBe(waits[0]!.parent.getText(source));
}

it("every tool uses the shutdown guard and awaits only its opening settle", () => {
  const registered: string[] = [];
  const root = join(PACKAGE_ROOT, "src");
  for (const path of readdirSync(root, { recursive: true }) as string[]) {
    if (!path.endsWith(".ts")) continue;
    const source = parse(readFileSync(join(root, path), "utf8"));
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "registerTool") {
        const name = (node.arguments[0] as ts.StringLiteral).text;
        registered.push(name);
        const guard = node.arguments[2]!;
        expect(ts.isCallExpression(guard), name).toBe(true);
        const call = guard as ts.CallExpression;
        expect(call.expression.getText(source), name).toBe("guarded");
        expect(call.arguments[2]?.getText(source), name).toBe("context.work");
        const handler = call.arguments[1]!;
        if (name === "sync_status") {
          // This read delegates its opening settle to the shared status helper.
          expect(awaits(handler).map((wait) => wait.expression.getText(source)))
            .toEqual(["collectSyncStatus(replicas)"]);
        } else {
          expectOpeningSettle(handler, source);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(registered.sort()).toEqual([...MUTATING_TOOLS, ...READ_ONLY_TOOLS].sort());
  const status = parse(readFileSync(join(root, "status.ts"), "utf8"));
  const collect = status.statements.find((node) => ts.isFunctionDeclaration(node) &&
    node.name?.text === "collectSyncStatus")!;
  expectOpeningSettle(collect, status);
});

it("the invariant check rejects an added await after settle", () => {
  const source = parse("async function handler() { await replicas.settle(); await anotherWriter(); write(); }");
  expect(() => expectOpeningSettle(source.statements[0]!, source)).toThrow();
});
