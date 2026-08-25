/**
 * The starter corpus: what `ub init` leaves in a workspace it just created.
 *
 * The writer is the real binary in a throwaway XDG home; the reader is an
 * in-process MCP server over the same database with no secret and therefore no
 * hub. That pairing is the point — the seed has to survive as a document an
 * ordinary MCP client can list, read and export, and it has to happen offline,
 * which is the only state a machine being initialised is reliably in.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createMcpServer,
  importSeedDir,
  resolveMcpConfig,
} from "@uberblick/mcp-server";
import { importMarkdown } from "@uberblick/schema";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  DEAD_HUB_URL,
  PACKAGE_ROOT,
  removeTempDirs,
  runUb,
  sandbox,
} from "./helpers.js";
import type { Sandbox } from "./helpers.js";

afterAll(removeTempDirs);

const TEMPLATES = [
  { file: "welcome.md", title: "Welcome" },
  { file: "bring-your-docs-in.md", title: "Bring your docs in" },
];

let box: Sandbox;

/** A workspace id for the half-seeded case, which starts from a config file. */
const HALF_WORKSPACE = "5f2b7c48-9d31-4a6e-8c05-3e7a1b9d4f62";

/** And one for a workspace that is already somebody's. */
const OWNED_WORKSPACE = "b7e9c130-6a48-4f21-9d3c-8e05a2b6f741";

/** `ub init` on a machine with no hub and nothing to install. */
function init(target: Sandbox = box): void {
  const run = runUb(["init", "--yes", "--no-mcp"], target, {
    HUB_URL: DEAD_HUB_URL,
  });
  expect(run.status, run.output).toBe(0);
}

function workspace(target: Sandbox = box): string {
  const path = join(target.configHome, "uberblick", "config.json");
  return JSON.parse(readFileSync(path, "utf8")).workspace;
}

/** Call MCP tools against the workspace `ub init` wrote, local-only. */
async function withTools<T>(
  fn: (call: (name: string, args?: Record<string, unknown>) => Promise<any>) => Promise<T>,
  target: Sandbox = box,
): Promise<T> {
  const config = resolveMcpConfig({
    WORKSPACE_ID: workspace(target),
    XDG_DATA_HOME: target.dataHome,
  });
  const instance = createMcpServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "uberblick-starter-tests", version: "0.0.0" });
  await Promise.all([
    instance.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    return await fn(async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).toBeFalsy();
      const [first] = result.content as { text: string }[];
      if (first === undefined) throw new Error(`${name} returned no content`);
      return JSON.parse(first.text);
    });
  } finally {
    await client.close();
    await instance.close();
  }
}

beforeAll(() => {
  box = sandbox();
  init();
});

it("seeds exactly the two starter documents, grouped under start-here", async () => {
  await withTools(async (call) => {
    const { docs } = await call("list_docs");
    expect(docs.map((doc: { title: string }) => doc.title)).toEqual([
      "Bring your docs in",
      "Welcome",
    ]);
    // The sidebar groups by tag, so an untagged starter document would land in
    // "Other" — the corpus a new user is shown must be the first group.
    for (const doc of docs) {
      expect(doc.tags).toContain("start-here");
    }
  });
});

it("exports both starter documents back to the markdown they came from", async () => {
  await withTools(async (call) => {
    for (const template of TEMPLATES) {
      const source = importMarkdown(
        readFileSync(join(PACKAGE_ROOT, "templates", template.file), "utf8"),
      );
      const { markdown } = await call("export_markdown", { uuid: source.uuid });
      // Round trip, not string equality: the export is canonical markdown, so
      // what has to survive is every block — type, level, language and text.
      expect(importMarkdown(markdown).blocks).toEqual(source.blocks);
      expect(importMarkdown(markdown).title).toBe(template.title);
    }
  });
});

it("seeds nothing on a second run, and duplicates no block", async () => {
  const before = await withTools(async (call) => call("get_doc", { uuid: uuidOf("welcome.md") }));
  init();
  await withTools(async (call) => {
    const { docs } = await call("list_docs");
    expect(docs).toHaveLength(2);
    const after = await call("get_doc", { uuid: uuidOf("welcome.md") });
    expect(after.blocks).toEqual(before.blocks);
  });
});

it("finishes a workspace whose seed stopped after the first document", async () => {
  // The state a refused log write leaves behind — one starter document here,
  // the other missing — reached through the importer itself rather than by
  // crashing one: what matters is that `ub init` reads what is missing instead
  // of remembering that it once ran.
  const half = sandbox({ userConfig: { workspace: HALF_WORKSPACE } });
  const partial = join(half.cwd, "one-template");
  mkdirSync(partial, { recursive: true });
  copyFileSync(join(PACKAGE_ROOT, "templates", "welcome.md"), join(partial, "welcome.md"));
  await importSeedDir(
    partial,
    resolveMcpConfig({ WORKSPACE_ID: HALF_WORKSPACE, XDG_DATA_HOME: half.dataHome }),
  );

  init(half);

  await withTools(async (call) => {
    const { docs } = await call("list_docs");
    expect(docs.map((doc: { title: string }) => doc.title)).toEqual([
      "Bring your docs in",
      "Welcome",
    ]);
    // The document that was already here is untouched: the importer never
    // rewrites a uuid it finds, so finishing the seed cannot duplicate a block.
    const welcome = await call("get_doc", { uuid: uuidOf("welcome.md") });
    const source = importMarkdown(
      readFileSync(join(PACKAGE_ROOT, "templates", "welcome.md"), "utf8"),
    );
    expect(welcome.blocks).toHaveLength(source.blocks.length);
  }, half);
});

it("adds nothing to a workspace that already holds other documents", async () => {
  // The upgrade case, and the joined-workspace case: a corpus that is already
  // somebody's is not one to write starter documents into, however little of
  // the starter corpus it happens to hold.
  const owned = sandbox({ userConfig: { workspace: OWNED_WORKSPACE } });
  await withTools(
    async (call) => call("create_doc", { title: "Real work", tags: ["feature"] }),
    owned,
  );

  init(owned);

  await withTools(async (call) => {
    const { docs } = await call("list_docs");
    expect(docs.map((doc: { title: string }) => doc.title)).toEqual(["Real work"]);
  }, owned);
});

it("ships the templates inside the package", () => {
  // The packing manifest, not the checkout: a template `ub init` can only find
  // by walking up to a repository would be missing from every install.
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    }),
  );
  const paths = packed[0].files.map((file: { path: string }) => file.path);
  for (const template of TEMPLATES) {
    expect(paths).toContain(`templates/${template.file}`);
  }
});

/** The identity a template carries, which is what makes a re-run idempotent. */
function uuidOf(file: string): string {
  const source = importMarkdown(
    readFileSync(join(PACKAGE_ROOT, "templates", file), "utf8"),
  );
  if (source.uuid === undefined) throw new Error(`${file}: no uuid`);
  return source.uuid;
}
