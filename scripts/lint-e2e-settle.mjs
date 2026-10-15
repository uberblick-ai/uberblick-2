import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sharedHelper = "packages/web/e2e/settle.ts";
const mcpReads = new Set(["get_doc", "get_data", "export_markdown"]);
const MCP = 1;
const PAGES = 2;

/** Use TypeScript's binder to follow local read-back aliases without matching text. */
export function lintE2eSources(sources) {
  const files = new Map(Object.entries(sources).map(([name, source]) => [resolve(root, name), source]));
  const options = { noResolve: true, noLib: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name, languageVersion) => {
    const source = files.get(resolve(name));
    return source === undefined ? undefined : ts.createSourceFile(name, source, languageVersion, true);
  };
  const program = ts.createProgram([...files.keys()], options, host);
  const checker = program.getTypeChecker();
  const diagnostics = [];
  const assignments = new Map();

  for (const source of program.getSourceFiles()) {
    function visit(node) {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        const symbol = checker.getSymbolAtLocation(node.left);
        if (symbol) assignments.set(symbol, [...assignments.get(symbol) ?? [], node.right]);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  function returned(body, seen) {
    if (!body) return 0;
    if (!ts.isBlock(body)) return provenance(body, seen);
    let result = 0;
    function visit(node) {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) result |= provenance(node.expression, seen);
      else ts.forEachChild(node, visit);
    }
    ts.forEachChild(body, visit);
    return result;
  }

  function declarationSource(declaration, seen) {
    if (ts.isVariableDeclaration(declaration)) return provenance(declaration.initializer, seen);
    if (ts.isBindingElement(declaration)) {
      let owner = declaration.parent;
      while (owner && !ts.isVariableDeclaration(owner)) owner = owner.parent;
      return owner ? provenance(owner.initializer, seen) : 0;
    }
    if (ts.isFunctionDeclaration(declaration)) return returned(declaration.body, seen);
    return 0;
  }

  function provenance(node, seen = new Set()) {
    if (!node || seen.has(node)) return 0;
    const next = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const initial = (symbol?.declarations ?? []).reduce((value, declaration) => value | declarationSource(declaration, next), 0);
      return (assignments.get(symbol) ?? []).reduce((value, assignment) => value | provenance(assignment, next), initial);
    }
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return returned(node.body, next);
    if (ts.isCallExpression(node)) {
      const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
      const first = node.arguments[0];
      if (method === "pages") return PAGES;
      if (mcpReads.has(method) || (method === "call" && first && ts.isStringLiteralLike(first) && mcpReads.has(first.text))) return MCP;
    }
    let result = 0;
    ts.forEachChild(node, (child) => { result |= provenance(child, next); });
    return result;
  }

  function retriedMcpAssertion(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
        ts.isCallExpression(parent.parent) && ts.isIdentifier(parent.parent.expression) &&
        parent.parent.expression.text === "expectMcp" && parent.parent.arguments.includes(parent)) return true;
    }
    return false;
  }

  for (const source of program.getSourceFiles()) {
    const name = relative(root, source.fileName).replaceAll("\\", "/");
    if (name === sharedHelper) continue;
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const assertion = ts.isIdentifier(callee) && callee.text === "expect" ||
          ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) &&
          callee.expression.text === "expect" && (callee.name.text === "soft" || callee.name.text === "poll");
        if (assertion) {
          const value = provenance(node.arguments[0]);
          const polling = ts.isPropertyAccessExpression(callee) && callee.name.text === "poll";
          if (value & PAGES || value & MCP && !polling && !retriedMcpAssertion(node)) {
            const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
            diagnostics.push({ file: name, line: line + 1, column: character + 1,
              message: value & PAGES ? "Assert open-page counts through settle.ts, after a positive reader barrier for a negative check." :
                "Assert MCP document/data reads through expectMcp in settle.ts so the read is retried." });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return diagnostics;
}

export function lintE2eDirectory(directory = join(root, "packages/web/e2e")) {
  const sources = Object.fromEntries(readdirSync(directory, { recursive: true })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => [relative(root, join(directory, name)), readFileSync(join(directory, name), "utf8")]));
  return lintE2eSources(sources);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const diagnostics = lintE2eDirectory();
  for (const diagnostic of diagnostics) {
    process.stderr.write(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}\n`);
  }
  if (diagnostics.length) process.exitCode = 1;
}
