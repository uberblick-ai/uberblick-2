/**
 * The starter corpus: what `ub init` leaves in a workspace it just created.
 *
 * The writer is the real binary in a throwaway XDG home; the readers are two,
 * deliberately. An in-process MCP server over the same database with no secret
 * and therefore no hub reads the documents — the seed has to survive as a
 * document an ordinary MCP client can list, read and export, and it has to
 * happen offline, which is the only state a machine being initialised is
 * reliably in. The sidebar is read straight out of the update log instead,
 * without constructing a server at all, because the MCP server runs a boot-time
 * migration that would build a sidebar of its own: a broken `ub init` would
 * pass every test that let that migration run first, and the web client — the
 * first thing a new user opens — runs no migration at all.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createMcpServer,
  importSeedDir,
  resolveMcpConfig,
} from "@uberblick/mcp-server";
import {
  importMarkdown,
  isSidebarSeeded,
  readSidebar,
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
  DEAD_HUB_URL,
  PACKAGE_ROOT,
  removeTempDirs,
  runUb,
  runUbAsync,
  sandbox,
} from "./helpers.js";
import type { Run, Sandbox } from "./helpers.js";

afterAll(removeTempDirs);

/** The shipped templates, in the order the sidebar pins them. */
const TEMPLATES = [
  {
    file: "welcome-to-uberblick.md",
    title: "Welcome to Überblick",
    uuid: "2d56b281-5614-43bd-b8d8-edd1c270a85a",
  },
  {
    file: "how-to-use-it.md",
    title: "How to Use It",
    uuid: "d7ddd0b1-fee9-4ef0-8f1e-42882f925c31",
  },
];

/** The two starter uuids in pin order. */
const PINS = TEMPLATES.map((template) => template.uuid);

let box: Sandbox;

/** A workspace id for the half-seeded case, which starts from a config file. */
const HALF_WORKSPACE = "5f2b7c48-9d31-4a6e-8c05-3e7a1b9d4f62";

/** And one for a workspace that is already somebody's. */
const OWNED_WORKSPACE = "b7e9c130-6a48-4f21-9d3c-8e05a2b6f741";

/** One for a workspace whose documents landed but whose sidebar did not. */
const UNPINNED_WORKSPACE = "c4a1e582-70b3-4d9f-8a26-1fb3d0c95e84";

/** `ub init` on a machine with no hub and nothing to install. */
function init(target: Sandbox = box): Run {
  const run = runUb(["init", "--yes", "--no-mcp"], target, {
    HUB_URL: DEAD_HUB_URL,
  });
  expect(run.status, run.output).toBe(0);
  return run;
}

function workspace(target: Sandbox = box): string {
  const path = join(target.configHome, "uberblick", "config.json");
  return JSON.parse(readFileSync(path, "utf8")).workspace;
}

/**
 * The workspace's sidebar, replayed from the update log alone.
 *
 * No MCP server is constructed and no hub is dialled: this opens the SQLite
 * mirror read-only, applies what the log holds for the `_sidebar` room to a
 * bare Y.Doc, and reads it with the same schema functions every client uses.
 * That is the state a first-ever web client would sync down, which is exactly
 * what `ub init` has to have written by the time it returns.
 */
function sidebarFromLog(target: Sandbox = box): {
  groups: SidebarGroup[];
  seeded: boolean;
} {
  const config = resolveMcpConfig({
    WORKSPACE_ID: workspace(target),
    XDG_DATA_HOME: target.dataHome,
  });
  const doc = new Y.Doc();
  const db = new DatabaseSync(config.databasePath, { readOnly: true });
  try {
    const room = sidebarRoom(config.workspaceId);
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

it("seeds exactly the two starter documents, with their uuids, tags and links", async () => {
  await withTools(async (call) => {
    const { docs } = await call("list_docs");
    expect(docs.map((doc: { title: string }) => doc.title)).toEqual([
      "How to Use It",
      "Welcome to Überblick",
    ]);
    for (const template of TEMPLATES) {
      const doc = await call("get_doc", { uuid: template.uuid });
      expect(doc.title).toBe(template.title);
      // Metadata, not navigation: the tag stays, and the sidebar is what the
      // reader is actually shown.
      expect(doc.tags).toEqual(["start-here"]);
      // Each starter document points at the other, by uuid.
      expect(doc.links).toEqual([
        PINS.find((uuid) => uuid !== template.uuid),
      ]);
    }
  });
});

it("is adopted by an MCP server started afterwards, with no second group", async () => {
  // The server's boot-time migration turns the legacy `start-here` tag into a
  // "Start here" group. An explicit sidebar is exactly what it must not do that
  // to: it adopts what it finds.
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
  const half = sandbox({ userConfig: { workspace: HALF_WORKSPACE } });
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
  const unpinned = sandbox({ userConfig: { workspace: UNPINNED_WORKSPACE } });
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
  const owned = sandbox({ userConfig: { workspace: OWNED_WORKSPACE } });
  await withTools(
    async (call) =>
      call("create_doc", {
        title: "Real work",
        description: "A test document.",
        tags: ["feature"],
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

it("leaves an archived starter document archived, and re-pins nothing", async () => {
  // A tombstone is sticky, so a document the user threw away must not read as
  // "missing" — re-seeding it would be refused every time and complained about
  // every time. Uses the workspace the first cases seeded.
  const before = sidebarFromLog();
  await withTools(async (call) =>
    call("archive_doc", { uuid: uuidOf(TEMPLATES[0]!.file) }),
  );

  const run = init();

  // Nothing was attempted at all: no import to refuse, so no warning about a
  // document the importer had to skip and none about an incomplete seed.
  expect(run.output).not.toContain("skipping a seed document");
  expect(run.output).not.toContain("starter documents");
  // The sidebar is what it was: archiving is not unpinning, and `ub init` is
  // not a repair crew for a workspace that already has its layout.
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
    runUbAsync(["init", "--yes", "--no-mcp"], race, { HUB_URL: DEAD_HUB_URL }),
    runUbAsync(["init", "--yes", "--no-mcp"], race, { HUB_URL: DEAD_HUB_URL }),
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

it("seeds the workspace this machine ends up configured for, or none", async () => {
  // What to seed is decided when the seed lock is taken, not remembered from
  // the write phase: an `ub init --workspace` joining a workspace by id can
  // publish it in between, and the starter documents would then land in a
  // workspace nothing on this machine points at — invisible to every tool,
  // and never finished by a later run.
  //
  // The gap is made observable rather than waited out. `ub init` runs `mise
  // trust` between releasing the init lock and taking the seed lock, so a
  // `mise` on PATH that reports when it starts and waits to be let go holds
  // the run open exactly there.
  const box = sandbox({ checkout: true });
  const bin = join(box.cwd, "bin");
  const trusting = join(box.cwd, "trusting");
  const release = join(box.cwd, "release");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "mise"),
    `#!/bin/sh\ntouch "${trusting}"\nwhile [ ! -f "${release}" ]; do sleep 0.02; done\n`,
  );
  chmodSync(join(bin, "mise"), 0o755);

  const running = runUbAsync(["init", "--yes", "--no-mcp"], box, {
    HUB_URL: DEAD_HUB_URL,
    PATH: `${bin}:/usr/bin:/bin`,
  });
  while (!existsSync(trusting)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Somebody joins a workspace by id while this run is held there.
  writeFileSync(
    join(box.configHome, "uberblick", "config.json"),
    `${JSON.stringify({ workspace: OWNED_WORKSPACE }, null, 2)}\n`,
  );
  writeFileSync(release, "");

  const run = await running;
  expect(run.status, run.output).toBe(0);
  // The machine is configured for the workspace that was joined, and nothing
  // was written into the one this run had settled on a moment earlier.
  expect(workspace(box)).toBe(OWNED_WORKSPACE);
  const stored = join(box.dataHome, "uberblick");
  const databases = existsSync(stored)
    ? readdirSync(stored).filter((file) => file.endsWith(".sqlite"))
    : [];
  expect(databases).toEqual([]);
  expect(run.stderr).toContain("no starter documents were written");
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
      `---\nuuid: ${template.uuid}\ntitle: ${template.title}\ntags:\n  - start-here\nlinks:\n  - ${other?.uuid}\n---\n\n${COPY[template.file]}`,
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
