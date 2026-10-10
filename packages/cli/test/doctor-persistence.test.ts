/**
 * Doctor inspects the existing database without constructing a live replica.
 * Hub delivery, replay repair, compaction and migrations must leave the
 * diagnostic's stored state exactly as it was found.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Hub } from "@uberblick/hub";
import { createHub, silentLogger } from "@uberblick/hub";
import type { StoredHubLogin } from "@uberblick/hub/auth-store";
import { authenticationOrigin } from "@uberblick/hub/remote-url";
import { createMcpServer, resolveMcpConfig } from "@uberblick/mcp-server";
import {
  directoryRoom,
  initDoc,
  roomForDoc,
  setWorkspaceName,
  settingsRoom,
  sidebarRoom,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MirrorStore } from "../../mcp-server/src/store.js";
import type { Check, DoctorReport } from "../src/doctor.js";
import type { StatusReport } from "../src/status.js";
import type { Sandbox } from "./helpers.js";
import { DEAD_HUB_URL, pointAt, removeTempDirs, runUbAsync, sandbox, unboundSandbox } from "./helpers.js";

const WORKSPACE = "c4ee1905-90e4-42df-8a4c-ed6ce9cbe531";
const DOCUMENT = "13b04df6-1c7b-45f1-9ec9-5f22034f71d3";
const SECRET = "doctor-persistence-test-secret";
const REFUSED = "doctor fixture refuses update-log appends";
const hubs: Hub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDirs();
});

async function database(
  box: Sandbox,
  env: NodeJS.ProcessEnv = {},
): Promise<{ check: Check; report: DoctorReport; status: number | null }> {
  const run = await runUbAsync(["doctor", "--json"], box, {
    PORT: "1",
    HUB_HOST: "127.0.0.1",
    ...env,
  });
  const report = JSON.parse(run.stdout) as DoctorReport;
  const check = report.checks.find((one) => one.name === "database");
  if (check === undefined) throw new Error("doctor omitted the database check");
  return { check, report, status: run.status };
}

function emptyStore(databasePath: string, workspace = WORKSPACE): void {
  // The fixture creates the file explicitly; doctor must not create one itself.
  const store = new MirrorStore(databasePath, workspace);
  store.close();
}

function namedStore(databasePath: string): void {
  const store = new MirrorStore(databasePath, WORKSPACE);
  const settings = new Y.Doc();
  try {
    setWorkspaceName(settings, "Snapshot name");
    const state = Y.encodeStateAsUpdate(settings);
    const seq = store.appendUpdate(settingsRoom(WORKSPACE), state, "local");
    store.compact(settingsRoom(WORKSPACE), state, seq);
    setWorkspaceName(settings, "Local name");
    store.appendUpdate(settingsRoom(WORKSPACE), Y.encodeStateAsUpdate(settings), "local");
  } finally {
    settings.destroy();
    store.close();
  }
}

function deviceSandbox(): Sandbox {
  const principalId = randomUUID();
  const login: StoredHubLogin = {
    identity: { id: principalId, githubAccountId: "12345", githubUsername: "doctor-person" },
    credential: {
      record: { id: randomUUID(), principalId, deviceId: randomUUID(), workspaces: [WORKSPACE],
        issuedAt: Date.now(), revokedAt: null },
      key: Buffer.alloc(32, 1).toString("base64url"),
      workspaceNames: { [WORKSPACE]: "Credential name" },
    },
  };
  return sandbox({
    projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
    userConfig: { hubAdmissions: { [DEAD_HUB_URL]: "device" } },
    credentials: { hubLogins: { [authenticationOrigin(DEAD_HUB_URL)]: login } },
  });
}

/** Include schema and every table, so no changed cache or watermark escapes. */
function storedState(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const schema = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
    const tables = db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    ).all() as { name: string }[];
    const rows = Object.fromEntries(tables.map(({ name }) => [
      name,
      db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    ]));
    return { schema, rows, bytes: readFileSync(databasePath) };
  } finally {
    db.close();
  }
}

/** Give preservation fixtures both a snapshot and a pending watermark. */
function seedSnapshot(store: MirrorStore): void {
  const sidebar = new Y.Doc();
  try {
    sidebar.getMap("groups").set("fixture", "preserve this snapshot");
    const state = Y.encodeStateAsUpdate(sidebar);
    const seq = store.appendUpdate(sidebarRoom(WORKSPACE), state, "local");
    store.compact(sidebarRoom(WORKSPACE), state, seq);
  } finally {
    sidebar.destroy();
  }
}

async function waitUntil(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function seededHub(box: Sandbox): Promise<Hub> {
  const hub = await createHub({
    authSecret: SECRET,
    port: 0,
    databasePath: join(box.cwd, "hub.sqlite"),
    log: silentLogger,
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  });
  hubs.push(hub);
  // Seed through the existing replica/client flow rather than introducing
  // another token-minting site just for this fixture.
  const seed = createMcpServer({
    ...resolveMcpConfig({ ...box.env, WORKSPACE_ID: WORKSPACE }),
    databasePath: join(box.cwd, "seed.sqlite"),
    hubUrl: `ws://127.0.0.1:${hub.port}`,
    authSecret: SECRET,
  });
  try {
    await seed.replicas.settle();
    upsertDirectoryEntry(seed.replicas.directory().doc, {
      uuid: DOCUMENT,
      title: "Remote update",
      tags: [],
    });
    await waitUntil("the remote update to be acknowledged", () =>
      seed.replicas.isRoomQuiet(directoryRoom(WORKSPACE)));
  } finally {
    await seed.close();
  }
  return hub;
}

describe("ub doctor observational database reading", () => {
  it("reports no workspace without creating config, data or a database", async () => {
    const box = unboundSandbox();
    const { check } = await database(box);

    expect(check.status).toBe("skipped");
    expect(check.reason).toMatch(/no workspace/);
    expect(existsSync(box.configHome)).toBe(false);
    expect(existsSync(box.dataHome)).toBe(false);
    expect(readdirSync(box.cwd)).toEqual([]);
  });

  it("skips an absent database with a writable parent without creating its directories", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const configPath = join(box.cwd, ".uberblick.json");
    const config = readFileSync(configPath, "utf8");
    const databasePath = join(box.cwd, "absent", "nested", "mirror.sqlite");
    const { check } = await database(box, { UBERBLICK_DB: databasePath });

    expect(check.status).toBe("skipped");
    expect(check.reason).toContain(databasePath);
    expect(check.reason).toMatch(/does not exist/);
    expect(existsSync(join(box.cwd, "absent"))).toBe(false);
    expect(existsSync(box.dataHome)).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(config);
    expect(existsSync(box.configHome)).toBe(false);
  });

  it("reports a directory in place of a database without creating store files", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const databasePath = join(box.cwd, "directory.sqlite");
    mkdirSync(databasePath);
    const { check } = await database(box, { UBERBLICK_DB: databasePath });

    expect(check.status).toBe("fail");
    expect(check.reason).toContain(databasePath);
    expect(check.reason).toMatch(/not a database file/);
    expect(readdirSync(databasePath)).toEqual([]);
    expect(existsSync(box.dataHome)).toBe(false);
  });

  it("reports a corrupt existing store as a failed reading", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const databasePath = join(box.cwd, "corrupt.sqlite");
    const contents = "this is not a SQLite database";
    writeFileSync(databasePath, contents);
    const { check, status } = await database(box, { UBERBLICK_DB: databasePath });

    expect(check.status).toBe("fail");
    expect(check.reason).toContain(databasePath);
    expect(check.reason).toMatch(/not a database/);
    expect(check.fix).toMatch(/valid database/);
    expect(status).toBe(1);
    expect(readFileSync(databasePath, "utf8")).toBe(contents);
    expect(existsSync(box.dataHome)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0).each([0o000, 0o400, 0o200])(
    "fails an existing database without read and write permission (mode %i)",
    async (mode) => {
      const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
      const databasePath = join(box.cwd, "unreadable.sqlite");
      namedStore(databasePath);
      expect(existsSync(`${databasePath}-wal`)).toBe(false);
      expect(existsSync(`${databasePath}-shm`)).toBe(false);
      chmodSync(databasePath, mode);
      try {
        const { check } = await database(box, { UBERBLICK_DB: databasePath });
        expect(check.status).toBe("fail");
        expect(check.reason).toContain(databasePath);
        expect(check.fix).toMatch(/access|permission/i);
        expect(existsSync(`${databasePath}-wal`)).toBe(false);
        expect(existsSync(`${databasePath}-shm`)).toBe(false);
        expect(existsSync(box.dataHome)).toBe(false);
      } finally {
        chmodSync(databasePath, 0o600);
      }
    },
  );

  it("passes an existing healthy store without changing it", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const databasePath = join(box.cwd, "healthy.sqlite");
    emptyStore(databasePath);
    const before = storedState(databasePath);
    const { check, report } = await database(box, { UBERBLICK_DB: databasePath });

    expect(check.status).toBe("pass");
    expect(check.fix).toBeNull();
    expect(report.checks.find((one) => one.name === "hub")?.status).toBe("skipped");
    expect(storedState(databasePath)).toEqual(before);
  });

  it.each(["healthy", "unreadable document"])("reads the local workspace name before the credential name without changing stored state (%s)", async (kind) => {
    const box = deviceSandbox();
    const databasePath = join(box.cwd, "named.sqlite");
    namedStore(databasePath);
    if (kind === "unreadable document") {
      const store = new MirrorStore(databasePath, WORKSPACE);
      try {
        store.appendUpdate(roomForDoc(WORKSPACE, DOCUMENT), new Uint8Array([255]), "local");
      } finally {
        store.close();
      }
    }
    const before = storedState(databasePath);
    const files = readdirSync(box.cwd);
    const configPath = join(box.cwd, ".uberblick.json");
    const credentialPath = join(box.configHome, "uberblick", "credentials.json");
    const config = readFileSync(configPath);
    const credentials = readFileSync(credentialPath);
    const { check, report } = await database(box, { UBERBLICK_DB: databasePath });

    expect(check.status).toBe(kind === "healthy" ? "pass" : "fail");
    expect(report.checks.find((one) => one.name === "workspace")?.reason)
      .toBe(`Local name (${WORKSPACE}), from ${configPath}`);
    expect(storedState(databasePath)).toEqual(before);
    expect(readdirSync(box.cwd)).toEqual(files);
    expect(readFileSync(configPath)).toEqual(config);
    expect(readFileSync(credentialPath)).toEqual(credentials);
    expect(existsSync(box.dataHome)).toBe(false);
  });

  it.each(["absent", "unnamed"])("uses the credential's workspace name with an %s database without creating a store", async (kind) => {
    const box = deviceSandbox();
    const databasePath = kind === "absent"
      ? join(box.cwd, "absent", "nested", "mirror.sqlite")
      : join(box.cwd, "unnamed.sqlite");
    if (kind === "unnamed") emptyStore(databasePath);
    const before = kind === "unnamed" ? storedState(databasePath) : null;
    const files = readdirSync(box.cwd);
    const configPath = join(box.cwd, ".uberblick.json");
    const credentialPath = join(box.configHome, "uberblick", "credentials.json");
    const config = readFileSync(configPath);
    const credentials = readFileSync(credentialPath);
    const { check, report } = await database(box, { UBERBLICK_DB: databasePath });

    expect(check.status).toBe(kind === "absent" ? "skipped" : "pass");
    expect(report.checks.find((one) => one.name === "workspace")?.reason)
      .toBe(`Credential name (${WORKSPACE}), from ${configPath}`);
    if (before !== null) expect(storedState(databasePath)).toEqual(before);
    expect(readdirSync(box.cwd)).toEqual(files);
    expect(existsSync(join(box.cwd, "absent"))).toBe(false);
    expect(existsSync(box.dataHome)).toBe(false);
    expect(readFileSync(configPath)).toEqual(config);
    expect(readFileSync(credentialPath)).toEqual(credentials);
  });

  it.skipIf(process.getuid?.() === 0)("fails an absent database whose nearest parent is not writable", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const parent = join(box.cwd, "readonly");
    mkdirSync(parent);
    chmodSync(parent, 0o500);
    try {
      const databasePath = join(parent, "absent", "mirror.sqlite");
      const { check } = await database(box, { UBERBLICK_DB: databasePath });
      expect(check.status).toBe("fail");
      expect(check.reason).toContain(parent);
      expect(existsSync(join(parent, "absent"))).toBe(false);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  it.skipIf(process.getuid?.() === 0)("fails an existing database in a directory it cannot write", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const parent = join(box.cwd, "readonly");
    mkdirSync(parent);
    const databasePath = join(parent, "mirror.sqlite");
    namedStore(databasePath);
    expect(readdirSync(parent)).toEqual(["mirror.sqlite"]);
    chmodSync(parent, 0o500);
    try {
      const { check } = await database(box, { UBERBLICK_DB: databasePath });
      expect(check.status).toBe("fail");
      expect(check.reason).toContain(parent);
      expect(readdirSync(parent)).toEqual(["mirror.sqlite"]);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  it("fails a store recording another workspace without changing it", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const databasePath = join(box.cwd, "another-workspace.sqlite");
    const otherWorkspace = "45a02d23-8343-4c37-b0fb-a8db6eb5b6a7";
    emptyStore(databasePath, otherWorkspace);
    const before = storedState(databasePath);
    const { check } = await database(box, { UBERBLICK_DB: databasePath });

    expect(check.status).toBe("fail");
    expect(check.reason).toContain(otherWorkspace);
    expect(check.reason).toContain(WORKSPACE);
    expect(storedState(databasePath)).toEqual(before);
  });

  it.each(["snapshot", "update"])("fails an unreadable Yjs %s without changing it", async (kind) => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const databasePath = join(box.cwd, `${kind}.sqlite`);
    const store = new MirrorStore(databasePath, WORKSPACE);
    try {
      const room = directoryRoom(WORKSPACE);
      const invalid = new Uint8Array([255]);
      const seq = store.appendUpdate(room, invalid, "local");
      if (kind === "snapshot") store.compact(room, invalid, seq);
    } finally {
      store.close();
    }
    const before = storedState(databasePath);
    const { check } = await database(box, { UBERBLICK_DB: databasePath });

    expect(check.status).toBe("fail");
    expect(storedState(databasePath)).toEqual(before);
  });

  it("does not receive missing updates from a reachable hub into the database", async () => {
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: null },
      credentials: { signingSecret: SECRET },
    });
    const databasePath = join(box.cwd, "behind.sqlite");
    const store = new MirrorStore(databasePath, WORKSPACE);
    try {
      seedSnapshot(store);
      expect(store.hasRoom(directoryRoom(WORKSPACE))).toBe(false);
    } finally {
      store.close();
    }
    const hub = await seededHub(box);
    pointAt(box, `ws://127.0.0.1:${hub.port}`);
    const before = storedState(databasePath);
    const { check, report } = await database(box, {
      UBERBLICK_DB: databasePath,
      PORT: String(hub.port),
    });

    expect(check.status).toBe("pass");
    expect(report.checks.find((one) => one.name === "hub")?.status).toBe("skipped");
    // A hub probe is allowed; a replica behind it would receive the update.
    expect(report.checks.find((one) => one.name === "local hub")?.status).not.toBe("fail");
    expect(storedState(databasePath)).toEqual(before);
  });

  it("passes a pending directory title repair without repairing it", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const databasePath = join(box.cwd, "repair.sqlite");
    const store = new MirrorStore(databasePath, WORKSPACE);
    const directory = new Y.Doc();
    const document = new Y.Doc();
    try {
      seedSnapshot(store);
      upsertDirectoryEntry(directory, { uuid: DOCUMENT, title: "Old title", tags: [] });
      store.appendUpdate(directoryRoom(WORKSPACE), Y.encodeStateAsUpdate(directory), "local");
      initDoc(document, { uuid: DOCUMENT, title: "Current title" });
      store.appendUpdate(roomForDoc(WORKSPACE, DOCUMENT), Y.encodeStateAsUpdate(document), "local");
    } finally {
      store.close();
      directory.destroy();
      document.destroy();
    }
    const before = storedState(databasePath);
    const { check } = await database(box, { UBERBLICK_DB: databasePath });

    expect(check.status).toBe("pass");
    expect(storedState(databasePath)).toEqual(before);
  });

  it("passes a compactable directory log without snapshotting or pruning it", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const databasePath = join(box.cwd, "compaction.sqlite");
    const store = new MirrorStore(databasePath, WORKSPACE);
    const directory = new Y.Doc();
    try {
      seedSnapshot(store);
      directory.on("update", (update: Uint8Array) => {
        store.appendUpdate(directoryRoom(WORKSPACE), update, "local");
      });
      for (let index = 0; index < 500; index++) {
        upsertDirectoryEntry(directory, {
          uuid: DOCUMENT,
          title: `Directory update ${index}`,
          tags: [],
        });
      }
      expect(store.updateCount(directoryRoom(WORKSPACE))).toBe(500);
    } finally {
      store.close();
      directory.destroy();
    }
    const before = storedState(databasePath);
    const { check } = await database(box, { UBERBLICK_DB: databasePath });

    expect(check.status).toBe("pass");
    expect(storedState(databasePath)).toEqual(before);
  });

  it("passes an old supported schema without adopting or migrating it", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const databasePath = join(box.cwd, "old.sqlite");
    const store = new MirrorStore(databasePath, WORKSPACE);
    try {
      seedSnapshot(store);
    } finally {
      store.close();
    }
    const old = new DatabaseSync(databasePath);
    try {
      old.exec(
        "DROP TABLE meta;" +
        "ALTER TABLE pending_rooms RENAME TO current_pending_rooms;" +
        "CREATE TABLE pending_rooms (room TEXT PRIMARY KEY);" +
        "INSERT INTO pending_rooms SELECT room FROM current_pending_rooms;" +
        "DROP TABLE current_pending_rooms;" +
        "ALTER TABLE doc_index DROP COLUMN description;" +
        "ALTER TABLE doc_index_seq DROP COLUMN catalog_through_seq;" +
        "ALTER TABLE doc_index_seq DROP COLUMN github_refs_indexed;",
      );
    } finally {
      old.close();
    }
    const before = storedState(databasePath);
    const { check } = await database(box, { UBERBLICK_DB: databasePath });

    expect(check.status).toBe("pass");
    expect(storedState(databasePath)).toEqual(before);
  });

  it("keeps status's refused-append diagnosis without repairing the trigger", async () => {
    const box = sandbox({
      projectBinding: { workspaceId: WORKSPACE, hubUrl: null },
      credentials: { signingSecret: SECRET },
    });
    const databasePath = join(box.cwd, "refusing.sqlite");
    emptyStore(databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TRIGGER refuse_updates BEFORE INSERT ON updates " +
      `BEGIN SELECT RAISE(ABORT, '${REFUSED}'); END`,
    );
    database.close();
    const hub = await seededHub(box);
    pointAt(box, `ws://127.0.0.1:${hub.port}`);
    const env = { UBERBLICK_DB: databasePath, UB_TEST_MAX_WAIT_MS: "2000" };

    const status = await runUbAsync(["status", "--json"], box, env);
    const snapshot = JSON.parse(status.stdout) as StatusReport;
    expect(status.status).toBe(0);
    expect(snapshot.persistence?.room).toBe(directoryRoom(WORKSPACE));
    expect(snapshot.persistence?.message).toContain(REFUSED);
    expect(snapshot.hub.status).toBe("quarantined");

    const human = await runUbAsync(["status"], box, env);
    expect(human.status).toBe(0);
    expect(human.stdout).toMatch(/1 detected failure.*ub doctor/);
    expect(human.stdout).not.toContain(directoryRoom(WORKSPACE));
    expect(human.stdout).not.toContain(REFUSED);

    const observed = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(observed.prepare("SELECT COUNT(*) AS count FROM updates").get()?.count).toBe(0);
      expect(observed.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").get()?.name)
        .toBe("refuse_updates");
    } finally {
      observed.close();
    }
  });
});
