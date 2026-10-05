/** Host-only first-admin setup. No TCP listener and no second SQLite writer. */
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { relative, resolve } from "node:path";
import { parseWorkspaceId } from "@uberblick/schema";
import { GithubDeviceFlow, type GithubSignInConfig } from "./github-device-flow.js";
import type { HubLogger } from "./log.js";
import type { MembershipRegistry } from "./memberships.js";
import type { HubDatabase } from "./persistence.js";
import type { PrincipalRecord, PrincipalRegistry } from "./principals.js";
import type { HubClaimState } from "./hub-claim.js";

export function adminSocketPath(databasePath: string): string {
  const absolute = `${resolve(databasePath)}.admin/control.sock`;
  const local = relative(process.cwd(), absolute);
  return Buffer.byteLength(local) < Buffer.byteLength(absolute) ? local : absolute;
}

export interface SetupGrant {
  status: "complete";
  setupId: string;
  workspaceId: string;
  identity: PrincipalRecord;
  hadDocuments: boolean;
}

type Completion = { grant: SetupGrant } | { refused: true };

/** A committed receipt survives lost output/restart and shares the grant's transaction. */
export class SetupReceipts {
  constructor(private readonly database: HubDatabase) {
    database.connection.exec(`CREATE TABLE IF NOT EXISTS hub_admin_setup_grants (
      setup_id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      github_account_id TEXT NOT NULL,
      github_username TEXT NOT NULL,
      had_documents INTEGER NOT NULL CHECK(had_documents IN (0, 1))
    )`);
  }

  find(setupId: string): SetupGrant | { status: "unknown"; setupId: string } {
    const row = this.database.connection.prepare("SELECT * FROM hub_admin_setup_grants WHERE setup_id = ?").get(setupId);
    if (row === undefined) return { status: "unknown", setupId };
    return {
      status: "complete", setupId, workspaceId: row.workspace_id as string,
      identity: { id: row.principal_id as string, githubAccountId: row.github_account_id as string,
        githubUsername: row.github_username as string }, hadDocuments: row.had_documents === 1,
    };
  }

  save(grant: SetupGrant): void {
    this.database.connection.prepare(`INSERT INTO hub_admin_setup_grants
      (setup_id, workspace_id, principal_id, github_account_id, github_username, had_documents)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(grant.setupId, grant.workspaceId, grant.identity.id, grant.identity.githubAccountId,
        grant.identity.githubUsername, grant.hadDocuments ? 1 : 0);
  }
}

/** Probe before removing a stale socket; a second hub must not unlink a live one. */
async function clearStaleSocket(path: string): Promise<void> {
  let original: ReturnType<typeof lstatSync>;
  try {
    original = lstatSync(path);
    if (!original.isSocket()) throw new Error("hub setup: control path is not a socket");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await new Promise<void>((accept, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error("hub setup: existing control socket did not answer"));
    });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("hub setup: another hub owns the control socket"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        try {
          const current = lstatSync(path);
          if (current.ino !== original.ino || current.dev !== original.dev) {
            reject(new Error("hub setup: control socket changed during startup"));
            return;
          }
          unlinkSync(path);
        } catch (cleanup) {
          if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") { reject(cleanup); return; }
        }
        accept();
      } else reject(error);
    });
  });
}

export async function startAdminSetup(options: {
  database: HubDatabase;
  principals: PrincipalRegistry;
  memberships: MembershipRegistry;
  github?: GithubSignInConfig | undefined;
  log: HubLogger;
  hasLiveDocuments: (workspaceId: string) => boolean;
  claims?: HubClaimState | undefined;
}): Promise<{ path: string; stop(): Promise<void> }> {
  const { database, principals, memberships, github, log } = options;
  const path = adminSocketPath(database.databasePath);
  // Linux sockaddr_un includes its trailing NUL. Refuse truncation/aliasing.
  if (Buffer.byteLength(path) > 103) throw new Error("hub setup: database path is too long for a Unix socket");
  const directory = `${resolve(database.databasePath)}.admin`;
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const owner = lstatSync(directory);
  if (!owner.isDirectory() || owner.uid !== process.getuid?.() || (owner.mode & 0o077) !== 0) {
    throw new Error("hub setup: control directory must be owned by the hub user at mode 0700");
  }
  await clearStaleSocket(path);
  const receipts = new SetupReceipts(database);
  const sessions = new Map<Socket, () => void>();
  const server = createServer((socket) => {
    let flow: GithubDeviceFlow<Completion> | undefined;
    let approval: { requestId: string; collectionSecret: string } | undefined;
    let timer: NodeJS.Timeout | undefined;
    let expiresAt = 0;
    let setupId: string | undefined;
    let started = false;
    let ended = false;
    let input = "";
    const fence = () => {
      ended = true;
      clearTimeout(timer);
      if (approval !== undefined) flow?.cancel(approval.requestId, approval.collectionSecret);
      flow?.stop();
    };
    sessions.set(socket, fence);
    const send = (value: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
    };
    const finish = (value: unknown) => {
      send(value);
      fence();
      socket.end();
    };
    socket.on("error", fence);
    socket.on("end", fence);
    socket.on("close", () => { fence(); sessions.delete(socket); });
    // Neither an idle host client nor an abandoned code can stay alive forever.
    socket.setTimeout(16 * 60_000, () => finish({ status: "abandoned", setupId }));

    const schedule = (intervalSeconds: number): void => {
      const wait = github?.setupPollMs ?? intervalSeconds * 1000;
      timer = setTimeout(() => { void poll().catch(() => finish({ status: "failed", setupId })); },
        Math.max(1, Math.min(wait, expiresAt - Date.now())));
    };

    const poll = async (): Promise<void> => {
      if (ended || approval === undefined || flow === undefined) return;
      const result = await flow.collect(approval.requestId, approval.collectionSecret);
      if (ended) return;
      if (result.status === "pending") {
        schedule(result.interval);
      } else if (result.status === "complete") {
        finish("grant" in result ? result.grant : { status: "workspace-has-membership", setupId });
      } else finish({ status: result.status, setupId });
    };

    const start = async (workspaceId: string): Promise<void> => {
      if (github === undefined) { finish({ status: "not-configured" }); return; }
      if (memberships.hasMembership(workspaceId)) { finish({ status: "workspace-has-membership", workspaceId }); return; }
      setupId = crypto.randomUUID();
      const id = setupId;
      send({ status: "starting", setupId, workspaceId });
      flow = new GithubDeviceFlow<Completion>(github, ({ accountId, username }) => {
        // No await between the guard and commit; all hub access uses this one
        // connection. The transaction also rolls back identity on refusal/error.
        const db = database.connection;
        db.exec("BEGIN IMMEDIATE");
        let grant: SetupGrant;
        try {
          if (memberships.hasMembership(workspaceId)) {
            db.exec("ROLLBACK");
            return { refused: true };
          }
          const identity = principals.identify(accountId, username);
          const prefix = `${workspaceId}/`;
          const hadDocuments = options.hasLiveDocuments(workspaceId) || db.prepare(
            "SELECT 1 FROM documents WHERE substr(name, 1, ?) = ? LIMIT 1",
          ).get(prefix.length, prefix) !== undefined;
          grant = { status: "complete", setupId: id, workspaceId, identity, hadDocuments };
          memberships.grant({ workspaceId, principalId: identity.id, role: "admin" });
          receipts.save(grant);
          options.claims?.close();
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        // Logging/output cannot undo or misreport an already committed grant.
        try { log({ event: "hub.admin-setup.granted", ...grant }); } catch { /* receipt is durable */ }
        return { grant };
      }, log, "hub.admin-setup.failed");
      const result = await flow.start();
      if (ended) return;
      if (result.status !== "pending") { finish({ status: result.status, setupId }); return; }
      approval = result;
      expiresAt = Date.now() + result.expiresIn * 1000;
      // GitHub device code and the flow's private collection secret never
      // reach even the host command; it receives only the public approval code.
      send({ status: "pending", setupId, workspaceId, verificationUri: result.verificationUri,
        userCode: result.userCode, expiresIn: result.expiresIn });
      schedule(result.interval);
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (ended) return;
      input += chunk;
      if (Buffer.byteLength(input) > 4096) { finish({ status: "invalid-request" }); return; }
      while (!ended) {
        const newline = input.indexOf("\n");
        if (newline < 0) break;
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message === null || typeof message !== "object" || Array.isArray(message)) throw new Error();
          if (message.action === "cancel" && Object.keys(message).length === 1 && started) {
            finish({ status: "cancelled", setupId });
          } else if (!started && message.action === "status" && Object.keys(message).length === 2 &&
              typeof message.setupId === "string" && /^[0-9a-f-]{36}$/.test(message.setupId)) {
            finish(receipts.find(message.setupId));
          } else if (!started && message.action === "start" && Object.keys(message).length === 2 &&
              typeof message.workspaceId === "string" && parseWorkspaceId(message.workspaceId).uuid === message.workspaceId) {
            started = true;
            void start(message.workspaceId).catch(() => finish({ status: "failed", setupId }));
          } else throw new Error();
        } catch { finish({ status: "invalid-request" }); }
      }
    });
  });
  server.maxConnections = 100;
  try {
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(path, accept);
    });
    chmodSync(path, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    path,
    async stop() {
      // Closing sessions fences the async flow before the database is closed.
      for (const [socket, fence] of sessions) { fence(); socket.destroy(); }
      await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
    },
  };
}
