/**
 * The starter corpus: what `ub init` leaves in a workspace it just created.
 *
 * The writer is the real binary in a throwaway XDG home; the readers are two,
 * deliberately. An in-process MCP server over the same database with no secret
 * and therefore no hub reads the documents — the seed has to survive as a
 * document an ordinary MCP client can list, read and export, and it has to
 * happen offline, which is the only state a machine being initialised is
 * reliably in. The sidebar is read straight out of the update log instead,
 * without constructing a server at all: a broken `ub init` must not pass
 * because a later reader repaired or reinterpreted its output, and the web
 * client is usually the first thing a new user opens.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
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
} from "./helpers.js";
import type { Run, Sandbox, SandboxFiles } from "./helpers.js";

afterAll(removeTempDirs);

/** No test here starts a hub, so none waits for one; see {@link hubless}. */
function sandbox(files?: SandboxFiles): Sandbox {
  return hubless(anySandbox(files));
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

/** A workspace id for the half-seeded case, which starts from a config file. */
const HALF_WORKSPACE = "5f2b7c48-9d31-4a6e-8c05-3e7a1b9d4f62";

/** And one for a workspace that is already somebody's. */
const OWNED_WORKSPACE = "b7e9c130-6a48-4f21-9d3c-8e05a2b6f741";

/** A non-starter document known only by its archived directory stub. */
const OWNED_ARCHIVE = "a98a269e-749c-402e-8776-648b78154d79";

/** One for a workspace whose documents landed but whose sidebar did not. */
const UNPINNED_WORKSPACE = "c4a1e582-70b3-4d9f-8a26-1fb3d0c95e84";

/** And one seeded straight through the importer, to write into. */
const DESCRIBED_WORKSPACE = "9d3b6f27-1c84-4a05-b7e9-2f61c8d05a3b";

/** `ub init` on a machine with no hub and nothing to install. */
function init(target: Sandbox = box): Run {
  const run = runUb(["init", "--yes", "--no-mcp"], target);
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
 * exactly what `ub init` has to have written by the time it returns — and it is
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

it("pins both starter documents into the Überblick group, in order", () => {
  // Read from the update log, with no MCP server ever constructed against this
  // workspace: `ub init` itself has to leave the pins durable, because the web
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
  // documents and both stubs are described by the time `ub init` returns.
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
    const result = await call("set_tags", {
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
  // later MCP process adopts the group exactly as `ub init` wrote it.
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

it("seeds nothing on a second run: no duplicate document, group or pin", async () => {
  const before = await withTools(async (call) =>
    call("get_doc", { uuid: uuidOf(TEMPLATES[0]!.file) }),
  );
  init();
  expect(sidebarFromLog().groups).toEqual([
    { id: STARTER_GROUP_ID, name: STARTER_GROUP_NAME, docs: PINS },
  ]);
  await withTools(async (call) => {
    const { docs } = await call("list_docs");
    expect(docs).toHaveLength(2);
    const after = await call("get_doc", { uuid: uuidOf(TEMPLATES[0]!.file) });
    expect(after.blocks).toEqual(before.blocks);
  });
});

it("finishes a workspace whose seed stopped after the first document", async () => {
  // The state a refused log write leaves behind — one starter document here,
  // the other missing, and no sidebar — reached through the importer itself
  // rather than by crashing one: what matters is that `ub init` reads what is
  // missing instead of remembering that it once ran.
  const half = sandbox({ projectBinding: { workspaceId: HALF_WORKSPACE, hubUrl: null } });
  const partial = join(half.cwd, "one-template");
  const first = TEMPLATES[0]!.file;
  mkdirSync(partial, { recursive: true });
  copyFileSync(join(PACKAGE_ROOT, "templates", first), join(partial, first));
  await importSeedDir(
    partial,
    resolveMcpConfig({ WORKSPACE_ID: HALF_WORKSPACE, XDG_DATA_HOME: half.dataHome }),
  );
  // Half a starter corpus is not a layout to declare: nothing was pinned and
  // the sidebar was left unseeded, so the next run still owns it.
  expect(sidebarFromLog(half)).toEqual({ groups: [], seeded: false });

  init(half);

  expect(sidebarFromLog(half).groups).toEqual([
    { id: STARTER_GROUP_ID, name: STARTER_GROUP_NAME, docs: PINS },
  ]);
  await withTools(async (call) => {
    const { docs } = await call("list_docs");
    expect(docs.map((doc: { title: string }) => doc.title)).toEqual([
      "How to Use It",
      "Welcome to Überblick",
    ]);
    // The document that was already here is untouched: the importer never
    // rewrites a uuid it finds, so finishing the seed cannot duplicate a block.
    const welcome = await call("get_doc", { uuid: uuidOf(first) });
    const source = importMarkdown(
      readFileSync(join(PACKAGE_ROOT, "templates", first), "utf8"),
    );
    expect(welcome.blocks).toHaveLength(source.blocks.length);
  }, half);
});

it("repairs an unseeded sidebar in a workspace holding only the starter documents", async () => {
  // Both documents landed, the pins never did — the workspace a `ub init` from
  // before this feature leaves behind, and the one an init interrupted between
  // the two writes leaves behind. The next run finishes the layout.
  const unpinned = sandbox({ projectBinding: { workspaceId: UNPINNED_WORKSPACE, hubUrl: null } });
  await importSeedDir(
    join(PACKAGE_ROOT, "templates"),
    resolveMcpConfig({
      WORKSPACE_ID: UNPINNED_WORKSPACE,
      XDG_DATA_HOME: unpinned.dataHome,
    }),
  );
  expect(sidebarFromLog(unpinned)).toEqual({ groups: [], seeded: false });

  init(unpinned);

  expect(sidebarFromLog(unpinned).groups).toEqual([
    { id: STARTER_GROUP_ID, name: STARTER_GROUP_NAME, docs: PINS },
  ]);
});

it("leaves sidebar curation alone once it exists", async () => {
  // The pins are the user's from the moment they land. A renamed group, a
  // reordered one, an unpinned document — every later `ub init` has to read
  // that as state it must not touch, and the seed marker is what says so even
  // after the group itself is deleted.
  const curated = sandbox();
  init(curated);
  await withTools(async (call) => {
    await call("sidebar_group", {
      action: "rename",
      group: STARTER_GROUP_ID,
      name: "Mine",
    });
    await call("unpin_doc", { uuid: PINS[1]! });
  }, curated);

  init(curated);

  expect(sidebarFromLog(curated).groups).toEqual([
    { id: STARTER_GROUP_ID, name: "Mine", docs: [PINS[0]!] },
  ]);

  // And the harder half: a sidebar emptied on purpose stays empty, because the
  // marker outlives the groups it stood for.
  await withTools(async (call) => {
    await call("sidebar_group", { action: "delete", group: STARTER_GROUP_ID });
  }, curated);

  init(curated);

  expect(sidebarFromLog(curated)).toEqual({ groups: [], seeded: true });
});

it("adds nothing to a workspace that already holds other documents", async () => {
  // The upgrade case, and the joined-workspace case: a corpus that is already
  // somebody's is not one to write starter documents into, however little of
  // the starter corpus it happens to hold.
  const owned = sandbox({ projectBinding: { workspaceId: OWNED_WORKSPACE, hubUrl: null } });
  await withTools(
    async (call) =>
      call("create_doc", {
        title: "Real work",
        description: "A test document.",
      }),
    owned,
  );

  init(owned);

  // Read before any MCP server touches this workspace again: the sidebar is a
  // seed too, and it must not be written into somebody else's workspace either.
  expect(sidebarFromLog(owned)).toEqual({ groups: [], seeded: false });
  await withTools(async (call) => {
    const { docs } = await call("list_docs");
    expect(docs.map((doc: { title: string }) => doc.title)).toEqual(["Real work"]);
  }, owned);
});

it("adds nothing when an archived stub has no document room", async () => {
  // A different replica can deliver a tombstone without ever having attached
  // the archived room. The stub is still evidence that this workspace belongs
  // to somebody, so `ub init` must not seed starter documents into it.
  const owned = sandbox({ projectBinding: { workspaceId: OWNED_WORKSPACE, hubUrl: null } });
  const config = resolveMcpConfig({
    WORKSPACE_ID: OWNED_WORKSPACE,
    XDG_DATA_HOME: owned.dataHome,
  });
  const instance = createMcpServer(config);
  const directory = new Y.Doc();
  try {
    upsertDirectoryEntry(directory, {
      uuid: OWNED_ARCHIVE,
      title: "Archived elsewhere",
      tags: [],
    });
    tombstoneDirectoryEntry(directory, OWNED_ARCHIVE);
    instance.store.appendUpdate(
      directoryRoom(OWNED_WORKSPACE),
      Y.encodeStateAsUpdate(directory),
      "local",
    );
  } finally {
    directory.destroy();
    await instance.close();
  }

  const run = init(owned);

  expect(run.output).not.toContain("starter documents");
  expect(sidebarFromLog(owned)).toEqual({ groups: [], seeded: false });
  expect(getDirectoryEntry(replayRoom(directoryRoom, owned), OWNED_ARCHIVE)).toMatchObject(
    { deleted: true, title: "Archived elsewhere" },
  );
});

it("leaves an archived starter document archived, and re-pins nothing", async () => {
  // A tombstone is sticky, so a document the user threw away must not read as
  // "missing" — re-seeding it would be refused every time and complained about
  // every time. Uses the workspace the first cases seeded.
  await withTools(async (call) =>
    call("archive_doc", { uuid: uuidOf(TEMPLATES[0]!.file) }),
  );
  // Read after the archive, not before it: archiving unpins (#957), so what
  // `ub init` must leave alone is the sidebar the throwing-away left behind.
  const before = sidebarFromLog();

  const run = init();

  // Nothing was attempted at all: no import to refuse, so no warning about a
  // document the importer had to skip and none about an incomplete seed.
  expect(run.output).not.toContain("skipping a seed document");
  expect(run.output).not.toContain("starter documents");
  // The sidebar is what the archive left: `ub init` is not a repair crew for a
  // workspace that already has its layout, and a starter document the user
  // threw away does not come back as an entry point.
  expect(sidebarFromLog()).toEqual(before);
  await withTools(async (call) => {
    const { docs } = await call("list_docs");
    expect(docs.map((doc: { title: string }) => doc.title)).toEqual([
      "How to Use It",
    ]);
    const all = await call("list_docs", { include_deleted: true });
    expect(all.docs).toHaveLength(2);
  });
});

it("does not duplicate a document when two ub init runs race", async () => {
  // Deciding what to write by reading the workspace is only safe while nothing
  // else can write between the two, which is what the init lock is for here:
  // without it both runs read an empty workspace and both write Welcome into
  // the same room, where Yjs merges two copies of every block.
  const race = sandbox();
  const runs = await Promise.all([
    runUbAsync(["init", "--yes", "--no-mcp"], race),
    runUbAsync(["init", "--yes", "--no-mcp"], race),
  ]);
  // Both still succeed: the loser leaves the documents to the run that holds
  // the seed lock rather than failing over a lock it has no stake in.
  expect(runs.map((run) => run.status)).toEqual([0, 0]);

  // One group, not two: the starter group's id is a fixed constant, so two
  // runs that both got that far would write the same group rather than a
  // second one beside it.
  expect(sidebarFromLog(race).groups).toEqual([
    { id: STARTER_GROUP_ID, name: STARTER_GROUP_NAME, docs: PINS },
  ]);
  await withTools(async (call) => {
    const { docs } = await call("list_docs");
    expect(docs.map((doc: { title: string }) => doc.title)).toEqual([
      "How to Use It",
      "Welcome to Überblick",
    ]);
    for (const template of TEMPLATES) {
      const source = importMarkdown(
        readFileSync(join(PACKAGE_ROOT, "templates", template.file), "utf8"),
      );
      const doc = await call("get_doc", { uuid: source.uuid });
      expect(doc.blocks).toHaveLength(source.blocks.length);
    }
  }, race);
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
  // The packing manifest, not the checkout: a template `ub init` can only find
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

/** The identity a template carries, which is what makes a re-run idempotent. */
function uuidOf(file: string): string {
  const source = importMarkdown(
    readFileSync(join(PACKAGE_ROOT, "templates", file), "utf8"),
  );
  if (source.uuid === undefined) throw new Error(`${file}: no uuid`);
  return source.uuid;
}
