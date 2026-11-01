import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { parseWorkspaceId } from "@uberblick/schema";
import { isTokenScope } from "@uberblick/schema/token";
import type { AgentGrantRegistry } from "./agent-grants.js";
import type { CredentialRecord, CredentialRegistry } from "./credentials.js";
import type { HubAdminRegistry } from "./hub-admins.js";
import type { OAuthAuthorizations } from "./oauth-authorizations.js";

export const MCP_SOCKET_TIMEOUT_MS = 5000;
const MAX_FRAME_BYTES = 65_536;

export type HubMcpTokenResult =
  | { status: "positive"; grantId: string; principal: string; workspace: string; scope: string; expiresAt: number }
  | { status: "negative" }
  | { status: "unavailable" };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

function workspace(value: unknown): value is string {
  try { return typeof value === "string" && parseWorkspaceId(value).uuid === value; } catch { return false; }
}

function nonempty(value: unknown): value is string { return typeof value === "string" && value !== ""; }
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

/** Probe the existing inode before unlinking; a reachable hub always wins. */
async function clearStaleSocket(path: string): Promise<void> {
  let original: ReturnType<typeof lstatSync>;
  try {
    original = lstatSync(path);
    if (!original.isSocket()) throw new Error("hub MCP: configured path is not a socket");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("hub MCP: existing socket did not answer"));
    }, MCP_SOCKET_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("hub MCP: another hub owns the configured socket"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code !== "ECONNREFUSED" && error.code !== "ENOENT") {
        reject(new Error("hub MCP: cannot probe the configured socket"));
        return;
      }
      try {
        const current = lstatSync(path);
        if (current.ino !== original.ino || current.dev !== original.dev) {
          throw new Error("hub MCP: configured socket changed during startup");
        }
        unlinkSync(path);
        resolve();
      } catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException).code === "ENOENT") resolve();
        else reject(cleanup);
      }
    });
  });
}

export async function startMcpChannel(options: {
  path: string;
  authorizations: OAuthAuthorizations;
  grants: AgentGrantRegistry;
  admins: HubAdminRegistry;
  credentials: CredentialRegistry;
}): Promise<{ stop(): Promise<void> }> {
  const { path, authorizations, grants, admins, credentials } = options;
  if (path === "" || path.includes("\0") || Buffer.byteLength(path) > 103) {
    throw new Error("hub MCP: configured socket path must be nonempty and at most 103 bytes without NUL");
  }
  const directory = dirname(path);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const owner = lstatSync(directory);
  if (!owner.isDirectory() || owner.uid !== process.getuid?.() || (owner.mode & 0o077) !== 0) {
    throw new Error("hub MCP: socket directory must be owned by the hub user with no group or other access");
  }
  await clearStaleSocket(path);
  let stopped = false;
  const sessions = new Set<Socket>();
  const server = createServer(socket => {
    if (stopped) { socket.destroy(); return; }
    sessions.add(socket);
    let input = "";
    let ended = false;
    const finish = (value: unknown) => {
      if (ended) return;
      ended = true;
      socket.end(`${JSON.stringify(value)}\n`);
    };
    const timer = setTimeout(() => { ended = true; socket.destroy(); }, MCP_SOCKET_TIMEOUT_MS);
    socket.on("error", () => { ended = true; });
    socket.on("close", () => { ended = true; clearTimeout(timer); sessions.delete(socket); });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (ended || stopped) return;
      input += chunk;
      if (Buffer.byteLength(input) > MAX_FRAME_BYTES) { finish({ status: "invalid-request" }); return; }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try {
        const message: unknown = JSON.parse(input.slice(0, newline));
        if (!object(message) || input.slice(newline + 1) !== "") throw new Error();
        if (message.action === "introspect" && fields(message, ["action", "token"]) && typeof message.token === "string") {
          const token = authorizations.getAccessToken(message.token);
          const grant = token === null ? null : grants.get(token.grantId);
          if (token === null || grant === null || !grants.isLive(grant.id) || admins.isSuspended(grant.workspaceId)) {
            finish({ status: "negative" });
          } else {
            finish({ status: "positive", grantId: grant.id, principal: grant.principalId, workspace: grant.workspaceId,
              scope: token.scope, expiresAt: token.expiresAt });
          }
        } else if (message.action === "issue-credential" && fields(message, ["action", "grantId", "publicKey"]) &&
          nonempty(message.grantId) && typeof message.publicKey === "string" && /^[A-Za-z0-9_-]{43}$/.test(message.publicKey)) {
          const publicKey = Buffer.from(message.publicKey, "base64url");
          if (publicKey.byteLength !== 32 || publicKey.toString("base64url") !== message.publicKey) throw new Error();
          const issued = credentials.issueForGrant(message.grantId, publicKey);
          finish(issued === null ? { status: "refused" } : { status: "issued", credential: issued.record });
        } else finish({ status: "invalid-request" });
      } catch { finish({ status: "failed" }); }
    });
  });
  server.maxConnections = 100;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    chmodSync(path, 0o600);
  } catch (error) {
    stopped = true;
    for (const socket of sessions) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const socket of sessions) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

/** The absolute timer includes connection and all bytes, even a trickling reply. */
async function request(path: string, message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let input = "";
    let completed = false;
    const finish = (value: unknown, failed: boolean) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      socket.destroy();
      if (failed) reject(new Error("hub MCP channel unavailable"));
      else resolve(value);
    };
    const timer = setTimeout(() => finish(undefined, true), MCP_SOCKET_TIMEOUT_MS);
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (completed) return;
      input += chunk;
      if (Buffer.byteLength(input) > MAX_FRAME_BYTES) { finish(undefined, true); return; }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try {
        if (input.slice(newline + 1) !== "") throw new Error();
        finish(JSON.parse(input.slice(0, newline)), false);
      } catch { finish(undefined, true); }
    });
    socket.on("error", () => finish(undefined, true));
    socket.on("close", () => finish(undefined, true));
  });
}

export async function introspectMcpToken(socketPath: string, token: string): Promise<HubMcpTokenResult> {
  try {
    const reply = await request(socketPath, { action: "introspect", token });
    if (!object(reply)) throw new Error();
    if (reply.status === "negative" && fields(reply, ["status"])) return { status: "negative" };
    if (reply.status === "positive" && fields(reply, ["status", "grantId", "principal", "workspace", "scope", "expiresAt"]) &&
      nonempty(reply.grantId) && nonempty(reply.principal) && workspace(reply.workspace) &&
      (reply.scope === "docs:read" || reply.scope === "docs:read docs:write") && timestamp(reply.expiresAt)) {
      return { status: "positive", grantId: reply.grantId, principal: reply.principal, workspace: reply.workspace,
        scope: reply.scope, expiresAt: reply.expiresAt };
    }
  } catch { /* Transport and parse failures have the same token-free answer. */ }
  return { status: "unavailable" };
}

function credential(value: unknown): value is CredentialRecord {
  if (!object(value) || !fields(value, ["id", "principalId", "deviceId", "workspaces", "issuedAt", "revokedAt", "replacedAt", "ceiling"]) ||
    !nonempty(value.id) || !nonempty(value.principalId) || !nonempty(value.deviceId) ||
    !Array.isArray(value.workspaces) || !value.workspaces.every(workspace) || !timestamp(value.issuedAt) ||
    (value.revokedAt !== null && !timestamp(value.revokedAt)) || (value.replacedAt !== null && !timestamp(value.replacedAt))) return false;
  const ceiling = value.ceiling;
  return object(ceiling) && fields(ceiling, ["grantId", "workspaceId", "scope"]) && nonempty(ceiling.grantId) &&
    workspace(ceiling.workspaceId) && isTokenScope(ceiling.scope);
}

export async function requestMcpCredential(socketPath: string, grantId: string, publicKey: Uint8Array): Promise<CredentialRecord | null> {
  try {
    if (publicKey.byteLength !== 32) throw new Error();
    const reply = await request(socketPath, { action: "issue-credential", grantId, publicKey: Buffer.from(publicKey).toString("base64url") });
    if (object(reply)) {
      if (reply.status === "refused" && fields(reply, ["status"])) return null;
      if (reply.status === "issued" && fields(reply, ["status", "credential"]) && credential(reply.credential)) return reply.credential;
    }
  } catch { /* Do not expose requests or transport errors to host logs. */ }
  throw new Error("hub MCP channel unavailable");
}
