import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { lintE2eSources } from "./lint-e2e-settle.mjs";

function lint(source, name = "packages/web/e2e/example.spec.ts") {
  return lintE2eSources({ [name]: source });
}

test("MCP one-shot assertions fail for direct reads, aliases, destructuring and local helper returns", () => {
  for (const read of ["get_doc", "get_data", "export_markdown"]) {
    for (const source of [
      `expect((await session.call('${read}', {uuid})).blocks).toEqual(before);`,
      `const doc = await session.call('${read}', {uuid}); const blocks = doc.blocks; expect(blocks).toEqual(before);`,
      `const {blocks} = await session.call('${read}', {uuid}); expect.soft(blocks).toEqual(before);`,
      `let doc; doc = await session.call('${read}', {uuid}); expect(doc.blocks).toEqual(before);`,
      `async function stored() { const doc = await session.call('${read}', {uuid}); return doc.blocks; } expect(await stored()).toEqual(before);`,
      `const stored = async () => (await session.call('${read}', {uuid})).blocks; expect(await stored()).toEqual(before);`,
    ]) assert.equal(lint(source).length, 1, source);
  }
});

test("open-page assertions fail for direct counts and assigned aliases", () => {
  for (const source of [
    "expect(page.context().pages()).toHaveLength(1);",
    "const count = context.pages().length; expect(count).toBe(before);",
    "const pages = context.pages(); const count = pages.length; expect.soft(count).toBe(1);",
    "await expect.poll(() => context.pages().length).toBe(1);",
  ]) assert.match(lint(source)[0]?.message ?? "", /open-page counts/, source);
});

test("retry callbacks reject captured MCP snapshots instead of retrying only the assertion", () => {
  for (const assertion of [
    "await expect.poll(() => doc.blocks).toEqual(before);",
    "await expectMcp(async () => { expect(doc.blocks).toEqual(before); });",
    "await expectMcp(() => doc, value => expect(value.blocks).toEqual(before));",
    "const read = () => doc; await expect.poll(read).toEqual(before);",
    "async function read() { return doc; } await expectMcp(read, value => expect(value.blocks).toEqual(before));",
  ]) {
    assert.equal(lint(`const doc = await session.call('get_doc', {uuid}); ${assertion}`).length, 1, assertion);
  }
});

test("polling, shared assertions, baselines and unrelated immediate reads remain valid", () => {
  assert.deepEqual(lint(`
    const before = await session.call('get_doc', {uuid});
    await expectMcp(() => session.call('get_doc', {uuid}), doc => expect(doc.blocks).toEqual(before.blocks));
    await expectMcp(async () => {
      const doc = await session.call('get_doc', {uuid});
      expect(doc.blocks).toEqual(before.blocks);
      expect(await session.call('get_data', {uuid})).toEqual([]);
    });
    await expect.poll(async () => (await session.call('get_data', {uuid})).count).toBe(2);
    async function read() { const doc = await session.call('get_doc', {uuid}); return doc; }
    const readData = async () => { const data = await session.call('get_data', {uuid}); return data; };
    await expect.poll(read).toEqual(before);
    await expectMcp(read, doc => expect(doc.blocks).toEqual(before.blocks));
    await expectMcp(readData, data => expect(data).toEqual([]));
    await expectMcp(async () => { const doc = await read(); expect(doc.blocks).toEqual(before.blocks); });
    const width = await page.evaluate(() => innerWidth); expect(width).toBe(100);
    // expect(await session.call('get_doc')).toEqual(before);
    const example = "expect(context.pages()).toHaveLength(1)";
  `), []);
  assert.deepEqual(lint("expect((await session.call('get_doc')).blocks).toEqual(before); expect(context.pages()).toHaveLength(1);",
    "packages/web/e2e/settle.ts"), []);
});

test("read aliases are scoped to their own function", () => {
  assert.deepEqual(lint(`
    async function first() { const doc = await session.call('get_doc', {uuid}); return doc; }
    function second() { const doc = {blocks: []}; expect(doc.blocks).toEqual([]); }
  `), []);
});

test("native selections require returned positions while pointer input can return void", () => {
  const source = readFileSync(new URL("../packages/web/e2e/native-selection.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("native-selection.ts", source, ts.ScriptTarget.Latest, true);
  const functions = new Map(file.statements.filter(ts.isFunctionDeclaration).map((node) => [node.name.text, node]));
  const signature = (name) => functions.get(name).parameters[1].type.getText(file);
  const fixture = `type SelectionTarget = {anchor: number; head: number};
    declare function script(select: ${signature("setNativeSelection")}): void;
    declare function pointer(select: ${signature("setPointerSelection")}): void;
    script(async () => ({anchor: 1, head: 1}));
    script(async () => {});
    pointer(async () => {});`;
  const host = ts.createCompilerHost({ noEmit: true, strict: true, target: ts.ScriptTarget.Latest });
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, languageVersion, ...rest) => name === "selection-contract.ts" ?
    ts.createSourceFile(name, fixture, languageVersion, true) : getSourceFile(name, languageVersion, ...rest);
  const program = ts.createProgram(["selection-contract.ts"], { noEmit: true, strict: true, target: ts.ScriptTarget.Latest }, host);
  const errors = program.getSemanticDiagnostics().filter((diagnostic) => diagnostic.file?.fileName === "selection-contract.ts");
  assert.equal(errors.length, 1, errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, " ")).join("\n"));
  assert.match(ts.flattenDiagnosticMessageText(errors[0].messageText, " "), /Promise<void>.*Promise<SelectionTarget>/);
});
