import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { resolveStorage } from "@uberblick/mcp-server/storage";
import { parseWorkspaceId } from "@uberblick/schema";
import { MAX_TOKEN_LIFETIME_SECONDS, importRootSecret, mintToken } from "@uberblick/schema/token";
import { readJsonObject } from "./open-access.js";

export const LAUNCH_LIFETIME_MS = 10 * 60_000;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60_000;
export const SESSION_HEADER = "x-uberblick-session";
const SESSION_PATH = "/api/session";
const ROOM_TOKEN_PATH = "/api/room-token";

const SECRET = /^[A-Za-z0-9_-]{43}$/;

function digest(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function owned(uid: number): boolean {
  return process.getuid === undefined || uid === process.getuid();
}

/** The fragment of the printed address; it admits one exchange for a session. */
export class LaunchSecret {
  readonly value = randomBytes(32).toString("base64url");
  private hash: Buffer | null = digest(this.value);
  private readonly expiresAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.expiresAt = now() + LAUNCH_LIFETIME_MS;
  }

  take(candidate: unknown): boolean {
    if (this.hash === null || typeof candidate !== "string" || !SECRET.test(candidate)) return false;
    if (this.now() >= this.expiresAt) {
      this.hash = null;
      return false;
    }
    if (!timingSafeEqual(digest(candidate), this.hash)) return false;
    this.hash = null;
    return true;
  }
}

/**
 * One owner-only file per session, named by the token's SHA-256, so open tabs
 * survive a restart and concurrent `ub open` runs never rewrite each other.
 */
export class BrowserSessions {
  private readonly directory: string;

  constructor(env: NodeJS.ProcessEnv, private readonly now: () => number = Date.now) {
    this.directory = join(resolveStorage({ env }).configDir, "browser-sessions");
  }

  issue(): string {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!this.trustedDirectory()) throw new Error(`${this.directory} must be an owner-only directory you own`);
    this.sweep();
    const token = randomBytes(32).toString("base64url");
    writeFileSync(this.path(token), `${this.now() + SESSION_LIFETIME_MS}\n`, { mode: 0o600, flag: "wx" });
    return token;
  }

  valid(token: unknown): boolean {
    if (typeof token !== "string" || !SECRET.test(token) || !this.trustedDirectory()) return false;
    const path = this.path(token);
    const expiresAt = this.expiry(path);
    if (expiresAt === null) return false;
    if (expiresAt > this.now()) return true;
    try { unlinkSync(path); } catch { /* another run removed it first */ }
    return false;
  }

  private path(token: string): string {
    return join(this.directory, digest(token).toString("hex"));
  }

  private trustedDirectory(): boolean {
    try {
      const stat = lstatSync(this.directory);
      return stat.isDirectory() && owned(stat.uid) && (stat.mode & 0o077) === 0;
    } catch {
      return false;
    }
  }

  private expiry(path: string): number | null {
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { return null; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || !owned(stat.uid) || (stat.mode & 0o077) !== 0 || stat.size > 32) return null;
      const contents = readFileSync(fd, "utf8");
      const expiresAt = Number(contents.trim());
      return /^\d+\n$/.test(contents) && Number.isSafeInteger(expiresAt) ? expiresAt : null;
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  private sweep(): void {
    let names: string[];
    try { names = readdirSync(this.directory); }
    catch { return; }
    for (const name of names) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const path = join(this.directory, name);
      const expiresAt = this.expiry(path);
      if (expiresAt !== null && expiresAt <= this.now()) {
        try { unlinkSync(path); } catch { /* another run removed it first */ }
      }
    }
  }
}

export interface BrowserAccess {
  launch: LaunchSecret;
  sessions: BrowserSessions;
  /** Room tokens for a served workspace, signed by its key, which stays here. */
  roomToken(workspace: string, subject: string): Promise<string | null>;
}

export async function createBrowserAccess(
  keys: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv,
): Promise<BrowserAccess> {
  const imported = new Map(await Promise.all([...keys].map(async ([id, key]) => [id, await importRootSecret(key)] as const)));
  return {
    launch: new LaunchSecret(),
    sessions: new BrowserSessions(env),
    async roomToken(workspace, subject) {
      const key = imported.get(workspace);
      if (key === undefined) return null;
      try {
        return await mintToken(key, {
          typ: "room", sub: subject, workspace, scope: "read-write", kid: null,
          lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
        });
      } catch {
        return null;
      }
    },
  };
}

export function hasSession(access: BrowserAccess, request: IncomingMessage): boolean {
  return access.sessions.valid(request.headers[SESSION_HEADER]);
}

type Reply = (status: number, body: object, headers?: Record<string, string>) => void;

/** Answer the launch exchange and room-token requests; false for any other path. */
export async function serveSessionRequest(
  access: BrowserAccess,
  request: IncomingMessage,
  pathname: string,
  expectedOrigin: string,
  reply: Reply,
): Promise<boolean> {
  if (pathname !== SESSION_PATH && pathname !== ROOM_TOKEN_PATH) return false;
  if (request.headers.origin !== expectedOrigin) {
    reply(403, { error: "origin_refused" });
    return true;
  }
  if (request.method !== "POST") {
    reply(405, { error: "method_not_allowed" }, { allow: "POST" });
    return true;
  }
  if (pathname === ROOM_TOKEN_PATH && !hasSession(access, request)) {
    reply(401, { error: "session_required" });
    request.resume();
    return true;
  }
  const body = await readJsonObject(request);
  if (body === null) {
    reply(400, { error: "invalid_request" }, { connection: "close" });
    request.resume();
    return true;
  }
  if (pathname === SESSION_PATH) {
    if (Object.keys(body).length !== 1 || !access.launch.take(body.launch)) {
      reply(401, { error: "launch_refused" });
      return true;
    }
    let session: string;
    try { session = access.sessions.issue(); }
    catch {
      reply(503, { error: "session_unavailable" });
      return true;
    }
    reply(200, { session });
    return true;
  }
  let workspace: string | null = null;
  try {
    if (typeof body.workspace === "string") workspace = parseWorkspaceId(body.workspace).uuid;
  } catch { /* refused below */ }
  const token = workspace === null || typeof body.subject !== "string" || Object.keys(body).length !== 2
    ? null : await access.roomToken(workspace, body.subject);
  if (token === null) reply(400, { error: "invalid_request" });
  else reply(200, { token });
  return true;
}
