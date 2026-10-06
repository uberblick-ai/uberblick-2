/**
 * Device logins live only in the owner-only credential store. This reader is
 * shared by auth commands and future credential consumers; it never resolves a
 * login into configuration or a child process's environment.
 */
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { validateWorkspaceName } from "@uberblick/schema";
import { credentialsPath } from "./storage.js";
export { CREDENTIALS_FILE, credentialsPath } from "./storage.js";
import { acquireInitLock } from "./init-lock.js";
import { publishOwnerOnly, writeTempBeside } from "./safe-write.js";

export interface StoredHubLogin {
  identity: {
    id: string;
    githubAccountId: string;
    githubUsername: string;
  };
  credential: {
    record: {
      id: string;
      principalId: string;
      deviceId: string;
      workspaces: string[];
      issuedAt: number;
      revokedAt: number | null;
    };
    key: string;
    /** Optional display data, replaced with each issued credential. */
    workspaceNames?: Record<string, string>;
  };
}

export interface HubLogins {
  path: string;
  state: "missing" | "unreadable" | "refused" | "usable";
  logins: Record<string, StoredHubLogin>;
  /** Malformed entries do not hide valid logins for other hubs. */
  unreadableHubs: string[];
  /** Safe to print: a file or shape diagnostic, never stored contents. */
  diagnostic?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Bad display data never invalidates a credential or adds workspace authority. */
export function sanitizeWorkspaceNames(
  value: unknown,
  workspaces: readonly string[],
  credentialKey: string,
  collectionSecret?: string,
): Record<string, string> | undefined {
  if (!object(value)) return undefined;
  const names: Record<string, string> = {};
  for (const workspace of workspaces) {
    if (!Object.hasOwn(value, workspace)) continue;
    const name = value[workspace];
    if (typeof name !== "string" || name.includes(credentialKey) ||
        (collectionSecret !== undefined && name.includes(collectionSecret))) continue;
    try {
      if (validateWorkspaceName(name) === name) names[workspace] = name;
    } catch { /* Unsafe names remain unnamed. */ }
  }
  return Object.keys(names).length === 0 ? undefined : names;
}

/** Validate exactly the identity and issued credential that collection supplies. */
export function isHubLogin(value: unknown): value is StoredHubLogin {
  if (!object(value) || !object(value.identity) || !object(value.credential)) return false;
  const { identity, credential } = value;
  const record = credential.record;
  if (!object(record) || !uuid(identity.id) ||
      typeof identity.githubAccountId !== "string" || !/^[1-9][0-9]*$/.test(identity.githubAccountId) ||
      typeof identity.githubUsername !== "string" || identity.githubUsername.length < 1 ||
      !uuid(record.id) || !uuid(record.principalId) || record.principalId !== identity.id ||
      !uuid(record.deviceId) || !Array.isArray(record.workspaces) ||
      !record.workspaces.every(uuid) || !timestamp(record.issuedAt) ||
      (record.revokedAt !== null && !timestamp(record.revokedAt)) ||
      typeof credential.key !== "string") return false;
  const bytes = Buffer.from(credential.key, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === credential.key &&
    !identity.githubUsername.includes(credential.key);
}

function authOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" && url.password === "" && url.origin === value;
  } catch {
    return false;
  }
}

interface Store extends HubLogins {
  raw: Record<string, unknown> | null;
}

function readStore(env: NodeJS.ProcessEnv): Store {
  const path = credentialsPath(env);
  const empty = { path, logins: {}, unreadableHubs: [], raw: null };
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ...empty, state: "missing" };
    if (code === "ELOOP") return { ...empty, state: "refused", diagnostic: `refusing credential store ${path}: it must be a regular file you own; move it aside and run \`ub auth login\` again` };
    return { ...empty, state: "unreadable", diagnostic: `could not read credential store ${path}` };
  }
  let raw: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid())) {
      return { ...empty, state: "refused", diagnostic: `refusing credential store ${path}: it must be a regular file you own; move it aside and run \`ub auth login\` again` };
    }
    const permissions = stat.mode & 0o777;
    if ((permissions & 0o077) !== 0) {
      return { ...empty, state: "refused", diagnostic: `refusing credential store ${path}: mode ${permissions.toString(8).padStart(4, "0")} lets other users access it; fix it with: chmod 600 ${path}` };
    }
    // Permissions and contents are read from the same descriptor. A replaced
    // path cannot turn a checked owner-only file into an exposed credential.
    raw = JSON.parse(readFileSync(fd, "utf8"));
  } catch {
    return { ...empty, state: "unreadable", diagnostic: `could not read credential store ${path}: expected a readable JSON object; repair that file before logging in` };
  } finally {
    closeSync(fd);
  }
  if (!object(raw)) {
    return { ...empty, state: "unreadable", diagnostic: `could not read credential store ${path}: expected a readable JSON object; repair that file before logging in` };
  }
  const entries = raw.hubLogins;
  if (entries !== undefined && !object(entries)) {
    return { ...empty, state: "unreadable", diagnostic: `could not read hub logins in credential store ${path}: expected a JSON object; repair that file before logging in` };
  }
  const logins: Record<string, StoredHubLogin> = {};
  const unreadableHubs: string[] = [];
  for (const [origin, login] of Object.entries(entries ?? {})) {
    // Invalid origin keys may be future fields or misplaced secrets. Preserve
    // them on write, but never use them as names in output.
    if (!authOrigin(origin)) continue;
    if (isHubLogin(login)) {
      const names = sanitizeWorkspaceNames(login.credential.workspaceNames,
        login.credential.record.workspaces, login.credential.key);
      const { workspaceNames: _workspaceNames, ...credential } = login.credential;
      logins[origin] = { ...login, credential: {
        ...credential, ...(names === undefined ? {} : { workspaceNames: names }),
      } };
    }
    else unreadableHubs.push(origin);
  }
  return { path, state: "usable", logins, unreadableHubs, raw };
}

/** Offline reader: refused and unreadable files never return a credential. */
export function readHubLogins(env: NodeJS.ProcessEnv = process.env): HubLogins {
  const { raw: _raw, ...result } = readStore(env);
  return result;
}

function editableStore(env: NodeJS.ProcessEnv): Store {
  const store = readStore(env);
  if (store.state === "refused" || store.state === "unreadable") throw new Error(store.diagnostic);
  return store;
}

function fsFailure(path: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  return new Error(`could not write credential store ${path}${code === undefined ? "" : ` (${code})`}; check that its directory is writable`);
}

/** Probe the actual staging directory without changing an existing credential. */
export function preflightHubLoginStore(env: NodeJS.ProcessEnv = process.env): string {
  const { path } = editableStore(env);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const probe = writeTempBeside(path, "{}\n");
    unlinkSync(probe);
    return path;
  } catch (error) {
    throw fsFailure(path, error);
  }
}

function publish(store: Store, hubLogins: Record<string, unknown>, command: string): void {
  try {
    mkdirSync(dirname(store.path), { recursive: true, mode: 0o700 });
    publishOwnerOnly(store.path, `${JSON.stringify({ ...store.raw, hubLogins }, null, 2)}\n`, command);
  } catch (error) {
    throw fsFailure(store.path, error);
  }
}

/** Only the collection fields owned by this contract may enter the store. */
export function projectLoginFields(login: StoredHubLogin, collectionSecret?: string): StoredHubLogin {
  const { identity, credential } = login;
  const { record } = credential;
  const workspaceNames = sanitizeWorkspaceNames(credential.workspaceNames, record.workspaces,
    credential.key, collectionSecret);
  return {
    identity: {
      id: identity.id,
      githubAccountId: identity.githubAccountId,
      githubUsername: identity.githubUsername,
    },
    credential: {
      record: {
        id: record.id,
        principalId: record.principalId,
        deviceId: record.deviceId,
        workspaces: [...record.workspaces],
        issuedAt: record.issuedAt,
        revokedAt: record.revokedAt,
      },
      key: credential.key,
      ...(workspaceNames === undefined ? {} : { workspaceNames }),
    },
  };
}

/** Store the new login and return the replaced login for the caller to revoke. */
export async function writeHubLogin(
  origin: string,
  login: StoredHubLogin,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<StoredHubLogin | null> {
  if (!authOrigin(origin) || !isHubLogin(login)) throw new Error("cannot store an invalid hub login");
  signal?.throwIfAborted();
  // Share the configuration writers' lock, and read only after acquiring it:
  // atomic publication alone can lose another login or a signing-secret update.
  // Browser approval and network waits never hold this lock.
  const lock = await acquireInitLock(env, { command: "ub auth login" });
  try {
    signal?.throwIfAborted();
    const store = editableStore(env);
    const entries = (store.raw?.hubLogins ?? {}) as Record<string, unknown>;
    const replaced = store.logins[origin] ?? null;
    publish(store, { ...entries, [origin]: projectLoginFields(login) }, "ub auth login");
    return replaced;
  } finally {
    lock.release();
  }
}

/** Local removal only; the caller handles revocation before discarding the key. */
export async function removeHubLogin(origin: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!authOrigin(origin)) throw new Error("cannot remove a login for an invalid hub origin");
  const lock = await acquireInitLock(env, { command: "ub auth logout" });
  try {
    const store = editableStore(env);
    const entries = { ...(store.raw?.hubLogins as Record<string, unknown> | undefined) };
    if (!Object.hasOwn(entries, origin)) return false;
    delete entries[origin];
    publish(store, entries, "ub auth logout");
    return true;
  } finally {
    lock.release();
  }
}

/** Renewal cannot overwrite a newer login or restore one removed by logout. */
export async function replaceHubLogin(
  origin: string,
  expected: StoredHubLogin,
  replacement: StoredHubLogin,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!authOrigin(origin) || !isHubLogin(replacement)) throw new Error("cannot store an invalid hub login");
  const lock = await acquireInitLock(env, { command: "ub auth login", ...(signal === undefined ? {} : { signal }) });
  try {
    signal?.throwIfAborted();
    const store = editableStore(env);
    const current = store.logins[origin];
    if (current?.credential.record.id !== expected.credential.record.id ||
      current.credential.key !== expected.credential.key) return false;
    const entries = (store.raw?.hubLogins ?? {}) as Record<string, unknown>;
    // Renewal owns only the credential. Preserve the stored identity and any
    // unrelated fields, including fields this build does not understand.
    publish(store, { ...entries, [origin]: {
      ...(entries[origin] as Record<string, unknown>),
      credential: projectLoginFields(replacement).credential,
    } }, "ub auth login");
    return true;
  } finally {
    lock.release();
  }
}
