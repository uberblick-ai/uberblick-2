/**
 * One database, one workspace (#199).
 *
 * The derived index has no workspace column and the update log's room keys are
 * opaque, so the file is the whole boundary between two corpora — and
 * `UBERBLICK_DB` overrides the per-workspace default path silently. Two servers
 * pinned to different workspaces at one file would union their corpora in
 * `search` and `backlinks` while the room prefix still kept the *documents*
 * apart, which is a leak nobody would see as one.
 *
 * So the file records the workspace it holds, and the second server to open it
 * with a different one refuses to start. A database written before that row
 * existed has exactly one workspace it can belong to, so it is adopted once
 * rather than stranded.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MirrorStore } from "../src/store.js";
import {
  PACKAGE_ROOT,
  mainTsProcess,
  removeTempDirs,
  startServer,
  tempDatabasePath,
  testConfig,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const ALPHA = "1a5e7c30-9d64-4b12-8f7a-2c0b6e9d4a11";
const BETA = "b2d9e4c7-5a13-4f80-8e6b-71c0a9d35f2e";
const DOC = "6f0c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f";

const stores: MirrorStore[] = [];
const rigs: Rig[] = [];

function open(databasePath: string, workspaceId: string): MirrorStore {
  const opened = new MirrorStore(databasePath, workspaceId);
  stores.push(opened);
  return opened;
}

/** The workspace the file itself says it holds. */
function recordedWorkspace(databasePath: string): string | undefined {
  const db = new DatabaseSync(databasePath);
  try {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'workspace'")
      .get() as { value: string } | undefined;
    return row?.value;
  } finally {
    db.close();
  }
}

/** The database file itself, so a refused open can be shown to touch nothing. */
function checksum(databasePath: string): string {
  return createHash("sha256").update(readFileSync(databasePath)).digest("hex");
}

/** The tables the file has, in the order SQLite lists them. */
function tables(databasePath: string): string[] {
  const db = new DatabaseSync(databasePath);
  try {
    return (
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
  for (const opened of stores.splice(0)) opened.close();
  removeTempDirs();
});

describe("the replica database", () => {
  it("records its workspace when created, and reopens for the same one", () => {
    const databasePath = tempDatabasePath();
    open(databasePath, ALPHA).close();
    expect(recordedWorkspace(databasePath)).toBe(ALPHA);

    // The ordinary case: same workspace, same file, nothing to say about it.
    expect(() => open(databasePath, ALPHA)).not.toThrow();
  });

  it("refuses to open under a different workspace, without touching the file", () => {
    const databasePath = tempDatabasePath();
    const alpha = open(databasePath, ALPHA);
    alpha.appendUpdate(`${ALPHA}/${DOC}`, new Uint8Array([1, 2, 3]), "local");
    alpha.close();
    // A derived table dropped, as a database from before that table existed
    // would be: bootstrapping the schema here would rebuild it — in a file this
    // server has no business writing to at all.
    const db = new DatabaseSync(databasePath);
    db.exec("DROP TABLE doc_links");
    db.close();
    const before = checksum(databasePath);

    expect(() => open(databasePath, BETA)).toThrow(
      new RegExp(`${ALPHA}[\\s\\S]*${BETA}`),
    );
    expect(() => open(databasePath, BETA)).toThrow(databasePath);
    // Refused means untouched: no table created, no migration run, no claim
    // overwritten. The file is byte-for-byte what alpha left behind.
    expect(tables(databasePath)).not.toContain("doc_links");
    expect(checksum(databasePath)).toBe(before);
    expect(recordedWorkspace(databasePath)).toBe(ALPHA);
  });

  it("makes the server process exit non-zero when UBERBLICK_DB is another workspace's", async () => {
    // The whole interface is the environment an MCP client hands the process,
    // and stdout is the JSON-RPC transport: the complaint goes to stderr.
    const databasePath = tempDatabasePath();
    open(databasePath, ALPHA).close();

    const { command, args } = mainTsProcess();
    const child = spawn(command, args, {
      cwd: PACKAGE_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        WORKSPACE_ID: BETA,
        UBERBLICK_DB: databasePath,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", resolve);
    });

    expect(code).not.toBe(0);
    expect(stderr).toContain(ALPHA);
    expect(stderr).toContain(BETA);
    expect(stderr).toContain(databasePath);
  }, 30_000);

  it("keeps two pinned workspaces out of each other's search when they share UBERBLICK_DB", async () => {
    // The review scenario: one exported UBERBLICK_DB, two `.mcp.json` entries
    // pinned to different workspaces. The second server never opens the file,
    // so neither corpus can appear in the other's index.
    const shared = tempDatabasePath();
    const alpha = await startServer(
      testConfig({ workspaceId: ALPHA, databasePath: shared }),
    );
    rigs.push(alpha);
    await alpha.ok("create_doc", {
      title: "Alpha plan",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "a shared word: corpus" }],
    });

    await expect(
      startServer(testConfig({ workspaceId: BETA, databasePath: shared })),
    ).rejects.toThrow(new RegExp(`${ALPHA}[\\s\\S]*${BETA}`));

    // Beta gets its own file, as it always should have, and the two corpora
    // are disjoint in the one place a shared file would have merged them.
    const beta = await startServer(
      testConfig({ workspaceId: BETA, databasePath: tempDatabasePath() }),
    );
    rigs.push(beta);
    await beta.ok("create_doc", {
      title: "Beta plan",
      description: "A test document.",
      blocks: [{ type: "paragraph", text: "a shared word: corpus" }],
    });

    const fromAlpha = await alpha.ok("search", { query: "corpus" });
    const fromBeta = await beta.ok("search", { query: "corpus" });
    expect(fromAlpha.hits.map((hit: { title: string }) => hit.title)).toEqual([
      "Alpha plan",
    ]);
    expect(fromBeta.hits.map((hit: { title: string }) => hit.title)).toEqual([
      "Beta plan",
    ]);
  }, 30_000);

  it("adopts a database that predates the meta row, once", () => {
    const databasePath = tempDatabasePath();
    open(databasePath, ALPHA).close();
    // A file written before this row existed: everything else, none of it.
    const db = new DatabaseSync(databasePath);
    db.exec("DROP TABLE meta");
    db.close();

    open(databasePath, BETA).close();
    expect(recordedWorkspace(databasePath)).toBe(BETA);
    // Adopted, not adoptable again.
    expect(() => open(databasePath, ALPHA)).toThrow(
      new RegExp(`${BETA}[\\s\\S]*${ALPHA}`),
    );
  });
});
