/** Host-only operator control. No TCP listener and no second SQLite writer. */
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { relative, resolve } from "node:path";
import { parseWorkspaceId } from "@uberblick/schema";
import type { HubDatabase } from "./persistence.js";
import type { OperatorControls, OperatorRequest } from "./operator-control.js";

export function adminSocketPath(databasePath: string): string {
  const absolute = `${resolve(databasePath)}.admin/control.sock`;
  const local = relative(process.cwd(), absolute);
  return Buffer.byteLength(local) < Buffer.byteLength(absolute) ? local : absolute;
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

export async function startOperatorSocket(options: {
  database: HubDatabase;
  operator: OperatorControls;
}): Promise<{ path: string; stop(): Promise<void> }> {
  const { database } = options;
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
  const sessions = new Map<Socket, () => void>();
  const operations = new Set<Promise<void>>();
  const server = createServer((socket) => {
    let started = false;
    let ended = false;
    let input = "";
    const abort = new AbortController();
    const fence = () => {
      ended = true;
      abort.abort();
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
    // Bound idle clients and give an online backup time to finish.
    socket.setTimeout(16 * 60_000, () => finish({ status: "failed", error: "hub control socket timed out" }));

    const operatorRequest = (message: Record<string, unknown>): boolean => {
      const operator = options.operator;
      if (started) return false;
      let request: OperatorRequest;
      if (Object.keys(message).length === 1 &&
          (message.action === "hub-status" || message.action === "hub-doctor" || message.action === "backup")) {
        request = { action: message.action };
      } else if (message.action === "hub-admin-add" && Object.keys(message).length === 2 &&
          typeof message.account === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(message.account)) {
        request = { action: "hub-admin-add", account: message.account };
      } else if (message.action === "hub-admin-add" && Object.keys(message).length === 2 &&
          typeof message.accountId === "string" && /^[1-9][0-9]{0,99}$/.test(message.accountId)) {
        request = { action: "hub-admin-add", accountId: message.accountId };
      } else if (message.action === "workspace-admin-add" && Object.keys(message).length === 3 &&
          typeof message.workspaceId === "string" && parseWorkspaceId(message.workspaceId).uuid === message.workspaceId &&
          typeof message.account === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(message.account)) {
        request = { action: "workspace-admin-add", workspaceId: message.workspaceId, account: message.account };
      } else if (message.action === "workspace-admin-add" && Object.keys(message).length === 3 &&
          typeof message.workspaceId === "string" && parseWorkspaceId(message.workspaceId).uuid === message.workspaceId &&
          typeof message.accountId === "string" && /^[1-9][0-9]{0,99}$/.test(message.accountId)) {
        request = { action: "workspace-admin-add", workspaceId: message.workspaceId, accountId: message.accountId };
      } else return false;
      started = true;
      const operation = operator.run(request, abort.signal)
        .then(value => { if (!ended) finish(value); })
        .catch(error => { if (!ended) finish({ status: "failed", error: String(error) }); });
      operations.add(operation);
      void operation.finally(() => operations.delete(operation));
      return true;
    };

    const handleMessage = (line: string): void => {
      try {
        const message = JSON.parse(line);
        if (message === null || typeof message !== "object" || Array.isArray(message)) throw new Error();
        if (!operatorRequest(message)) throw new Error();
      } catch { finish({ status: "invalid-request" }); }
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
        handleMessage(line);
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
      // Closing sessions fences operator operations before the database closes.
      for (const [socket, fence] of sessions) { fence(); socket.destroy(); }
      await Promise.all(operations);
      await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
    },
  };
}
