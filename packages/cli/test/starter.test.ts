/**
 * The starter corpus: what `ub workspace create` leaves in a workspace it just created.
 *
 * The writer is the real binary in a throwaway XDG home; the readers are two,
 * deliberately. An in-process MCP server over the same database with no secret
 * and therefore no hub reads the documents — the seed has to survive as a
 * document an ordinary MCP client can list, read and export, and it has to
 * happen offline, which is the only state a machine being initialised is
 * reliably in. The sidebar is read straight out of the update log instead,
 * without constructing a server at all: a broken `ub workspace create` must not pass
 * because a later reader repaired or reinterpreted its output, and the web
 * client is usually the first thing a new user opens.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createMcpServer,
  importSeedDir,
  readSeedDocs,
  resolveMcpConfig,
} from "@uberblick/mcp-server";
import {
  directoryRoom,
  getDirectoryEntry,
  getMeta,
  importMarkdown,
  isSidebarSeeded,
  readSidebar,
  roomForDoc,
  sidebarRoom,
} from "@uberblick/schema";
import type { SidebarGroup } from "@uberblick/schema";
import * as Y from "yjs";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  STARTER_GROUP_ID,
  STARTER_GROUP_NAME,
} from "../src/starter.js";
import {
  PACKAGE_ROOT,
  hubless,
  removeTempDirs,
  runUb,
  runUbAsync,
  sandbox as anySandbox,
  unboundSandbox as anyUnboundSandbox,
} from "./helpers.js";
import type { Run, Sandbox, SandboxFiles } from "./helpers.js";

afterAll(removeTempDirs);

/** No test here starts a hub, so none waits for one; see {@link hubless}. */
function sandbox(files?: SandboxFiles): Sandbox {
  return hubless(anySandbox(files));
}

/** Starter creation also covers the first binding written by create. */
function unboundSandbox(files?: SandboxFiles): Sandbox {
  return hubless(anyUnboundSandbox(files));
}

/** The shipped templates, in the order the sidebar pins them. */
const TEMPLATES = [
  {
    file: "welcome-to-uberblick.md",
    title: "Welcome to Überblick",
    uuid: "2d56b281-5614-43bd-b8d8-edd1c270a85a",
    description:
      "What Überblick is and how a fresh workspace works — local-first documents shared by you and the agents you connect. Read How to Use It next.",
  },
  {
    file: "how-to-use-it.md",
    title: "How to Use It",
    uuid: "d7ddd0b1-fee9-4ef0-8f1e-42882f925c31",
    description:
      "The shortest path from an empty workspace to useful work — open the editor, connect an agent over MCP, and organize documents with links and sidebar groups.",
  },
];

/** The two starter uuids in pin order. */
const PINS = TEMPLATES.map((template) => template.uuid);

let box: Sandbox;

/** And one seeded straight through the importer, to write into. */
const DESCRIBED_WORKSPACE = "9d3b6f27-1c84-4a05-b7e9-2f61c8d05a3b";

/** `ub workspace create` on a machine with no hub and nothing to install. */
function create(target: Sandbox = box): Run {
  const run = runUb(["workspace", "create", "Starter workspace"], target);
  expect(run.status, run.output).toBe(0);
  return run;
}

function workspace(target: Sandbox = box): string {
  const path = join(target.cwd, ".uberblick.json");
  return JSON.parse(readFileSync(path, "utf8")).workspaceId;
}

/**
 * One of the workspace's rooms, replayed from the update log alone.
 *
 * No MCP server is constructed and no hub is dialled: this opens the SQLite
 * mirror read-only, applies what the log holds for the room to a bare Y.Doc,
 * and hands it back to be read with the same schema functions every client
 * uses. That is the state a first-ever web client would sync down, which is
 * exactly what `ub workspace create` has to have written by the time it returns — and it is
 * the only reading that cannot be flattered by a later server's repairs.
 */
function replayRoom(
  roomOf: (workspaceId: string) => string,
  target: Sandbox = box,
): Y.Doc {
  const config = resolveMcpConfig({
    WORKSPACE_ID: workspace(target),
    XDG_DATA_HOME: target.dataHome,
  });
  const doc = new Y.Doc();
  const db = new DatabaseSync(config.databasePath, { readOnly: true });
  try {
    const room = roomOf(config.workspaceId);
    // The snapshot first, then everything the log holds beyond it: compaction
    // deletes the updates a snapshot covers, and Yjs takes both regardless.
    for (const row of db
      .prepare("SELECT state FROM snapshots WHERE room = ?")
      .all(room)) {
      Y.applyUpdate(doc, new Uint8Array(row.state as Uint8Array));
    }
    for (const row of db
      .prepare("SELECT payload FROM updates WHERE room = ? ORDER BY seq")
      .all(room)) {
      Y.applyUpdate(doc, new Uint8Array(row.payload as Uint8Array));
    }
  } finally {
    db.close();
  }
  return doc;
}

/** The workspace's sidebar, replayed from the update log alone. */
function sidebarFromLog(target: Sandbox = box): {
  groups: SidebarGroup[];
  seeded: boolean;
} {
  const doc = replayRoom(sidebarRoom, target);
  return { groups: readSidebar(doc), seeded: isSidebarSeeded(doc) };
}

/** Call MCP tools against the workspace `ub workspace create` wrote, local-only. */
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
  box = unboundSandbox();
  create();
});

it("pins both starter documents into the Überblick group, in order", () => {
  // Read from the update log, with no MCP server ever constructed against this
  // workspace: `ub workspace create` itself has to leave the pins durable, because the web
  // client is the first thing a new user opens and it runs no migration.
  const sidebar = sidebarFromLog();
  expect(sidebar.groups).toHaveLength(1);
  const [group] = sidebar.groups;
  expect(group?.name).toBe(STARTER_GROUP_NAME);
  expect(group?.id).toBe(STARTER_GROUP_ID);
  expect(group?.docs).toEqual(PINS);
  // Marked only once the whole layout is durable — the flag is what stops a
  // later run from seeding over curation.
  expect(sidebar.seeded).toBe(true);
});

it("seeds exactly two untagged starter documents, with their uuids and links", async () => {
  const directory = replayRoom(directoryRoom);
  for (const template of TEMPLATES) {
    const document = replayRoom((id) => roomForDoc(id, template.uuid));
    expect(getMeta(document).tags).toEqual([]);
    expect(getDirectoryEntry(directory, template.uuid)?.tags).toEqual([]);
  }

  await withTools(async (call) => {
    const { docs } = await call("list_docs");
    expect(docs.map((doc: { title: string }) => doc.title)).toEqual([
      "How to Use It",
      "Welcome to Überblick",
    ]);
    expect(docs.every((doc: { tags: unknown[] }) => doc.tags.length === 0)).toBe(
      true,
    );
    for (const template of TEMPLATES) {
      const doc = await call("get_doc", { uuid: template.uuid });
      expect(doc.title).toBe(template.title);
      expect(doc.tags).toEqual([]);
      // Each starter document points at the other, by uuid.
      expect(doc.links).toEqual([
        PINS.find((uuid) => uuid !== template.uuid),
      ]);
    }
  });
});

it("describes both starter documents, in the document and in the stub", () => {
  // What this pins is the observable contract: from the log alone, both
  // documents and both stubs are described by the time `ub workspace create` returns.
  // It does not pin which writer put the description in the stub — the seed's
  // own `upsertDirectoryEntry` and `Replicas.repairStub`, which reconciles a
  // stub from `meta.description`, both run inside that one process, and this
  // assertion cannot tell them apart. Reading from the log keeps a *later*
  // server's repair out of it, which is why no MCP server is constructed here.
  const directory = replayRoom(directoryRoom);
  for (const template of TEMPLATES) {
    const doc = replayRoom((id) => roomForDoc(id, template.uuid));
    expect(getMeta(doc).description).toBe(template.description);
    expect(getDirectoryEntry(directory, template.uuid)?.description).toBe(
      template.description,
    );
  }
});

it("leaves a freshly seeded document nothing to backfill", async () => {
  // The point of the descriptions: a document that arrives described does not
  // meet its first agent with a `descriptionHint` telling it to write one.
  const seeded = sandbox({ projectBinding: { workspaceId: DESCRIBED_WORKSPACE, hubUrl: null } });
  await importSeedDir(
    join(PACKAGE_ROOT, "templates"),
    resolveMcpConfig({
      WORKSPACE_ID: DESCRIBED_WORKSPACE,
      XDG_DATA_HOME: seeded.dataHome,
    }),
  );

  await withTools(async (call) => {
    const result = await call("set_metadata", {
      uuid: PINS[0]!,
      tags: ["mcp"],
    });
    expect(result.applied).toBe(true);
    expect(result.descriptionHint).toBeUndefined();
  }, seeded);
});

it("refuses a template that carries no description", () => {
  // The same bar as a missing uuid or title: a starter document nobody has
  // described is not one to write, so the reader stops rather than seeding it.
  const stripped = join(sandbox().cwd, "no-description");
  const { file } = TEMPLATES[0]!;
  mkdirSync(stripped, { recursive: true });
  const source = readFileSync(join(PACKAGE_ROOT, "templates", file), "utf8");
  writeFileSync(
    join(stripped, file),
    source
      .split("\n")
      .filter((line) => !line.startsWith("description:"))
      .join("\n"),
  );

  expect(() => readSeedDocs(stripped)).toThrow(/description/);

  // Quoted padding is the one spelling the schema's scalar reader hands back
  // whole, so the refusal has to measure the description rather than the
  // whitespace around it — the same discipline `create_doc` applies.
  const blank = join(sandbox().cwd, "blank-description");
  mkdirSync(blank, { recursive: true });
  writeFileSync(
    join(blank, file),
    source
      .split("\n")
      .map((line) =>
        line.startsWith("description:") ? 'description: "   "' : line,
      )
      .join("\n"),
  );

  expect(() => readSeedDocs(blank)).toThrow(/description/);
});

it("is adopted by an MCP server started afterwards, with no second group", async () => {
  // The sidebar is explicit seed state, not a projection of document tags. A
  // later MCP process adopts the group exactly as `ub workspace create` wrote it.
  await withTools(async (call) => {
    const { groups } = await call("get_sidebar");
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe(STARTER_GROUP_NAME);
    expect(
      groups[0].docs.map((doc: { uuid: string }) => doc.uuid),
    ).toEqual(PINS);
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

it("creates a complete new workspace on every run and leaves the old one unchanged", async () => {
  const rerun = unboundSandbox();
  create(rerun);
  const previous = workspace(rerun);
  const before = await withTools(call => call("get_doc", { uuid: PINS[0]! }), rerun);
  create(rerun);
  const next = workspace(rerun);
  expect(next).not.toBe(previous);
  expect(sidebarFromLog(rerun).groups).toEqual([
    { id: STARTER_GROUP_ID, name: STARTER_GROUP_NAME, docs: PINS },
  ]);
  expect(runUb(["workspace", "use", previous], rerun).status).toBe(0);
  await withTools(async call => {
    const after = await call("get_doc", { uuid: PINS[0]! });
    expect(after.blocks).toEqual(before.blocks);
  }, rerun);
});

it("seeds two complete new workspaces when creates race", async () => {
  const race = unboundSandbox();
  const runs = await Promise.all([
    runUbAsync(["workspace", "create", "First"], race),
    runUbAsync(["workspace", "create", "Second"], race),
  ]);
  expect(runs.map(run => run.status), runs.map(run => run.output).join("\n")).toEqual([0, 0]);
  const ids = runs.map(run => run.stdout.match(/\(([0-9a-f-]{36})\)/)?.[1]);
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) {
    expect(id).toBeDefined();
    expect(runUb(["workspace", "use", id!], race).status).toBe(0);
    expect(sidebarFromLog(race).groups).toEqual([
      { id: STARTER_GROUP_ID, name: STARTER_GROUP_NAME, docs: PINS },
    ]);
    await withTools(async call => {
      const { docs } = await call("list_docs");
      expect(docs).toHaveLength(2);
      for (const template of TEMPLATES) {
        const source = importMarkdown(readFileSync(join(PACKAGE_ROOT, "templates", template.file), "utf8"));
        const doc = await call("get_doc", { uuid: source.uuid });
        expect(doc.blocks).toHaveLength(source.blocks.length);
      }
    }, race);
  }
});

/**
 * The shipped copy, verbatim.
 *
 * Kept as a literal rather than derived from the file, because the file is what
 * is under test: this is the provisional onboarding text the owner approved,
 * and a diff to it is a product change to be made deliberately rather than
 * noticed later in a new user's workspace.
 */
const COPY: Record<string, string> = {
  "welcome-to-uberblick.md": `This is your Überblick workspace. It is shared by you and the agents you connect,
and it works locally first. When a hub is configured, the same documents sync to
your other clients.

Everything here is an ordinary document made of blocks. You can edit, link,
reorder, unpin, or archive it — including this page.

## Start here

- Open **How to Use It** for the shortest path from an empty workspace to useful work.
- Keep important documents close by pinning them in the sidebar.
- Replace these starter pages when the workspace becomes yours.
`,
  "how-to-use-it.md": `## Open the workspace

Run \`ub open\` to start Überblick and open the editor. Write directly in any
document; changes are saved locally first.

## Connect an agent

Run \`ub mcp install\` to connect a supported MCP client. An agent can then search,
read, create, and update the same documents you see in the editor.

## Organize what matters

Create documents for decisions, plans, research, or anything else worth keeping.
Use links to connect related documents and sidebar groups to curate the ones you
want close at hand.
`,
};

it("ships exactly the approved starter copy, frontmatter included", () => {
  for (const template of TEMPLATES) {
    const source = readFileSync(
      join(PACKAGE_ROOT, "templates", template.file),
      "utf8",
    );
    const other = TEMPLATES.find((one) => one !== template);
    expect(source).toBe(
      `---\nuuid: ${template.uuid}\ntitle: ${template.title}\ndescription: ${template.description}\nlinks:\n  - ${other?.uuid}\n---\n\n${COPY[template.file]}`,
    );
  }
});

it("ships the templates inside the package", () => {
  // The packing manifest, not the checkout: a template `ub workspace create` can only find
  // by walking up to a repository would be missing from every install.
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      // npm warns about every pnpm setting it finds in the environment.
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  const paths = packed[0].files.map((file: { path: string }) => file.path);
  for (const template of TEMPLATES) {
    expect(paths).toContain(`templates/${template.file}`);
  }
});
