/**
 * Where `ub` gets its configuration.
 *
 * **The endpoint has one authority: this machine's `config.json`.** There is no
 * ambient layer above it — a `HUB_URL` in the environment is not read, and not
 * passed on to anything this spawns. That layer is what silently redirected a
 * workspace bound to a remote hub at whatever a checkout happened to export
 * (#376, #385), and an endpoint is not the kind of thing two sources may
 * disagree about. `WORKSPACE_ID` and `HUB_AUTH_TOKEN` keep theirs: a repository
 * binds itself to a workspace by pinning `WORKSPACE_ID` in its project MCP
 * entry (see `install.ts`), and `fnox exec` supplies the signing secret. When
 * such a layer names something *different* from the file below it, the
 * environment still wins — that is the point of it — and the disagreement is
 * reported rather than left to whoever notices the wrong corpus: see
 * {@link ShadowedLayer}.
 *
 * *Where* that `config.json` is belongs to `@uberblick/hub/storage`:
 * `$XDG_CONFIG_HOME/uberblick`, or `~/.config/uberblick` — one layout on every
 * platform. This module reads and writes whichever root that resolves to and
 * never picks one itself.
 *
 * What this module produces is an **environment**, not a config object. The MCP
 * server's interface is environment variables and nothing else (see
 * `packages/mcp-server/src/config.ts`), and that contract is what lets `ub mcp
 * serve` stay the one stable spawn line an MCP client is pointed at. So
 * resolution ends by naming `WORKSPACE_ID`, `HUB_URL` and `HUB_AUTH_TOKEN`, and
 * both consumers read them back through `resolveMcpConfig` — one definition of
 * the defaults, of the database path, and of the workspace rule, for the server
 * and for `ub status` alike. A workspace id is a uuid (optionally
 * slug-decorated); schema owns that parse and this module applies it to every
 * layer, environment and files alike. `ub env -- <command…>` hands that same
 * environment to any command, which is how the checkout's mise tasks consume
 * this configuration instead of keeping a parallel copy of it.
 *
 * Absent files are a default, never an error: nothing here requires `ub init` to
 * have run. A file that exists but cannot be read, parsed, or believed is a
 * warning, and warnings go to stderr — in the `ub mcp serve` path stdout is the
 * JSON-RPC transport.
 *
 * `HUB_AUTH_TOKEN` holds the hub's HMAC **signing secret**, not a token (see
 * `packages/hub/src/token.ts`). It remains in `credentials.json` for loopback
 * hubs, is passed to a child only for loopback sync, and is never printed. A `credentials.json` other users
 * can read is refused rather than used — see {@link credentialsAreExposed}. The
 * endpoint comes from `config.json`; remote clients read the login for its
 * authentication origin from the private store themselves.
 */


import { isLoopbackEndpoint } from "@uberblick/hub/remote-url";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StoragePaths } from "@uberblick/hub/storage";
import { resolveStorage } from "@uberblick/hub/storage";
import { parseWorkspaceId } from "@uberblick/schema";
import { CREDENTIALS_FILE, credentialsPath } from "@uberblick/hub/auth-store";
export { CREDENTIALS_FILE, credentialsPath } from "@uberblick/hub/auth-store";
import {
  publishOwnerOnly,
  publishStaged,
  writeTempBeside,
} from "./safe-write.js";

/** Per-user identity, default workspace, remote endpoint. Not committed. */
export const USER_CONFIG_FILE = "config.json";

/** The key holding the hub's HMAC signing secret in `credentials.json`. */
const SIGNING_SECRET_KEY = "signingSecret";

/** Which layer a resolved value came from. Stable strings: `--json` prints them. */
export type Origin = "environment" | "user config" | "default";

/** Where a signing secret came from, or null when none is configured. */
export type CredentialOrigin = "environment" | "credentials file";

/**
 * A layer that named a value, and lost to a *different* one above it.
 *
 * Precedence is deliberate — a repository binds itself to a workspace by
 * pinning `WORKSPACE_ID` in its project MCP entry, and that pin is meant to
 * outrank this machine's default — but an ambient layer that silently
 * disagrees with a file is the failure #376/#385 removed for the endpoint:
 * `ub doctor` endorsed a workspace as healthy while `config.json` named
 * another one. So a disagreement is reported and nothing else: the same layer
 * still wins, and no disagreement is ever fatal.
 *
 * The layer above is the environment in both cases — it is the only one there
 * is — so the winner is the origin already reported for that setting. An entry
 * means the layers were compared and found to name different things: a value
 * that could not be read as a workspace id at all is a warning and no entry,
 * because nothing proves it names a *different* workspace.
 */
export interface ShadowedLayer {
  /** The setting the layers disagree about. */
  setting: "workspace" | "credential";
  /** The layer that lost. */
  layer: Origin | CredentialOrigin;
}

export interface ResolvedConfig {
  /**
   * The environment the MCP server is handed: the process environment with what
   * we resolved written over it. Feed it to `resolveMcpConfig`, or to a spawn.
   */
  env: NodeJS.ProcessEnv;
  origins: {
    workspace: Origin;
    hubUrl: Origin;
    /**
     * Null when no signing secret is in force — none configured, or the file
     * holding it refused for its mode. Either way: local-only, by design.
     */
    credential: CredentialOrigin | null;
  };
  /** The files consulted, whether or not they exist. */
  paths: {
    userConfig: string;
    credentials: string;
  };
  /**
   * The roots those paths came out of, and the hub and workspace database
   * directories that go with them.
   */
  storage: StoragePaths;
  /**
   * Layers a higher one overrode with a different value. Empty is the norm —
   * agreeing layers, and a layer nothing competes with, are not a conflict.
   */
  shadowed: ShadowedLayer[];
  /** Everything questionable about the configuration. For stderr, never stdout. */
  warnings: string[];
}

/**
 * The directory `ub`'s own files live in: `$XDG_CONFIG_HOME/uberblick`, or
 * `~/.config/uberblick`. `@uberblick/hub/storage` resolves that, for the hub
 * and the MCP server as well as for this one — one layout, decided in one
 * place.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveStorage({ env }).configDir;
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), USER_CONFIG_FILE);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
}

/**
 * Read a JSON object, or nothing. A missing file is silent; anything else wrong
 * with it is a warning and the layer is skipped — one broken file must not stop
 * `ub` from running with the layers below it.
 *
 * No parser output reaches a warning, for any of these files. Node's
 * `JSON.parse` errors quote the source around the syntax error, so the message
 * for a file someone pasted a bare secret into *is* the secret — and that is not
 * only `credentials.json`: a secret misplaced in `config.json` is exactly the
 * mistake {@link warnAboutMisplacedSecret} exists to catch, and a file that does
 * not parse never reaches it. An `ub` warning may
 * land in an MCP client's log, a screen-shared terminal or a CI transcript, so
 * the file's name is the whole of what is said about it.
 */
function readJsonObject(
  path: string,
  warnings: string[],
): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // An fs error names the path and the errno, never the file's contents.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`ignoring ${path}: ${message(error)}`);
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warnings.push(`ignoring ${path}: invalid JSON`);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(`ignoring ${path}: expected a JSON object`);
    return null;
  }
  return parsed as Record<string, unknown>;
}

function stringField(
  source: Record<string, unknown> | null,
  key: string,
  path: string,
  warnings: string[],
): string | null {
  if (source === null || !(key in source)) {
    return null;
  }
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    warnings.push(`ignoring "${key}" in ${path}: expected a non-empty string`);
    return null;
  }
  return value.trim();
}

interface Layer {
  origin: Origin;
  value: string | null;
  /** How to name this layer in an error message. */
  label: string;
}

/** The highest layer that has a value, or the built-in default. */
function pick(layers: Layer[]): { value: string | null; origin: Origin; label: string } {
  for (const layer of layers) {
    if (layer.value !== null) {
      return { value: layer.value, origin: layer.origin, label: layer.label };
    }
  }
  return { value: null, origin: "default", label: "the built-in default" };
}

/**
 * What `config.json` may hold. `ub init` writes it; {@link resolveConfig} reads
 * the two fields that resolve into an environment, and the identity fields ride
 * along for the awareness name and colour a client publishes.
 */
export interface UserConfig {
  // `| undefined` explicitly, under `exactOptionalPropertyTypes`: a field the
  // file does not carry reads as undefined rather than being absent.
  workspace?: string | undefined;
  hubUrl?: string | undefined;
  /** Awareness display name. */
  displayName?: string | undefined;
  /** Awareness colour, 6-digit hex — the only form y-prosemirror accepts. */
  color?: string | undefined;
}

/**
 * Read `config.json` for editing rather than for resolution.
 *
 * `ub init` has to preserve what it did not ask about — a `hubUrl` from
 * `ub remote join`, a field a later version writes — so it gets the raw object
 * back as well as the fields it understands. Resolution stays in
 * {@link resolveConfig}, which needs origins and per-layer labels this does not.
 */
export function readUserConfig(env: NodeJS.ProcessEnv = process.env): {
  /** The file as parsed, or null when it is absent or unusable. */
  raw: Record<string, unknown> | null;
  config: UserConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const path = userConfigPath(env);
  const raw = readJsonObject(path, warnings);
  return {
    raw,
    config: {
      workspace: stringField(raw, "workspace", path, warnings) ?? undefined,
      hubUrl: stringField(raw, "hubUrl", path, warnings) ?? undefined,
      displayName: stringField(raw, "displayName", path, warnings) ?? undefined,
      color: stringField(raw, "color", path, warnings) ?? undefined,
    },
    warnings,
  };
}

/**
 * Write `config.json`, and return its path.
 *
 * Owner-only, like `credentials.json` beside it: nothing in here is a secret,
 * but it is one user's configuration and no other account has business reading
 * or — the part that matters — writing the hub URL a signed token is sent to.
 *
 * Written by {@link publishOwnerOnly}, exactly like `credentials.json` beside it:
 * one rule for how this CLI puts a file on disk, rather than a weaker one for
 * the file that happens not to hold the secret.
 */
export function writeUserConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = userConfigPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  publishOwnerOnly(path, serialize(config));
  return path;
}

/**
 * A signing secret in a file that is not `credentials.json` is a mistake worth
 * naming: `config.json` is the file `ub` will happily print fields from, and it
 * is not written with the mode a secret needs.
 */
function warnAboutMisplacedSecret(
  source: Record<string, unknown> | null,
  path: string,
  warnings: string[],
): void {
  if (source !== null && SIGNING_SECRET_KEY in source) {
    warnings.push(
      `ignoring "${SIGNING_SECRET_KEY}" in ${path}: the hub signing secret ` +
        `belongs in ${CREDENTIALS_FILE} (mode 0600), never here`,
    );
  }
}

/**
 * Say when the environment's workspace and the file's are different
 * workspaces. True when they are.
 *
 * **Identity, not spelling.** `<slug>-<uuid>` and the bare uuid are one
 * workspace, so both sides are parsed and their uuids compared; otherwise
 * every legitimately decorated pin would report a conflict it does not have.
 *
 * The losing layer is parsed *here* — resolution validates only the winner, so
 * a malformed `config.json` under a valid pin is tolerated today and stays
 * tolerated. Hence the try/catch: this warns, it never throws. Workspace ids
 * are not secrets and both are named, but a value that did not parse is not,
 * because the mistake this catches in the field is a pasted secret.
 */
function warnAboutShadowedWorkspace(
  winner: { value: string; uuid: string },
  loser: { value: string; path: string },
  warnings: string[],
): boolean {
  let uuid: string;
  try {
    uuid = parseWorkspaceId(loser.value, `"workspace" in ${loser.path}`).uuid;
  } catch {
    warnings.push(
      `WORKSPACE_ID in the environment is in force (${winner.value}); ` +
        `"workspace" in ${loser.path} is not a workspace id, so the two ` +
        "could not be compared — fix that file, or unset one",
    );
    return false;
  }
  if (uuid === winner.uuid) {
    return false;
  }
  // Informative, not alarmed: a repository pin exists *because* it differs
  // from the machine default, and whoever set one sees this at every start.
  warnings.push(
    `WORKSPACE_ID in the environment is in force (${winner.value}); ` +
      `${loser.path} names a different workspace (${loser.value}) — expected ` +
      "for a pinned checkout, otherwise unset one",
  );
  return true;
}

/** True when the file exists and no other user can read it. */
export function isOwnerOnly(path: string): boolean {
  try {
    return (statSync(path).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * The signing secret is the one value in this layout another user on the machine
 * must not be able to read, so a file anyone else can read is refused, not
 * merely complained about — ssh's contract for a private key. Warning and then
 * using the secret anyway would leave the exposure in place and call it handled.
 *
 * Refusing is only the file layer: `HUB_AUTH_TOKEN` still wins and still works,
 * and with neither this machine is local-only, which is a supported state.
 */
function credentialsAreExposed(path: string, warnings: string[]): boolean {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return false;
  }
  const permissions = mode & 0o777;
  if ((permissions & 0o077) === 0) {
    return false;
  }
  warnings.push(
    `refusing ${path}: mode ${permissions.toString(8).padStart(4, "0")} lets ` +
      "other users read the hub signing secret, so the secret in it was not " +
      `used — fix it with: chmod 600 ${path}`,
  );
  return true;
}

/**
 * Read `credentials.json`.
 *
 * **`signingSecret` is the file's value whether or not the file is exposed.**
 * Anything *resolving* configuration must treat an exposed file as absent — see
 * {@link credentialsAreExposed} and how {@link resolveConfig} uses this. The
 * value is still returned because `ub init` repairs the mode of such a file by
 * rewriting it, and rewriting it means keeping what it held: regenerating would
 * cut this machine off from every other client already holding that secret.
 */
export function readCredentials(env: NodeJS.ProcessEnv = process.env): {
  path: string;
  /** The file as parsed, or null when it is absent or unusable. */
  raw: Record<string, unknown> | null;
  signingSecret: string | null;
  /** True when the file exists and other users can read it. */
  exposed: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  const path = credentialsPath(env);
  const exposed = credentialsAreExposed(path, warnings);
  const raw = readJsonObject(path, warnings);
  return {
    path,
    raw,
    signingSecret: stringField(raw, SIGNING_SECRET_KEY, path, warnings),
    exposed,
    warnings,
  };
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
}

export function resolveConfig(options: ResolveOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env;
  const storage = resolveStorage({ env });
  const warnings: string[] = [];
  const shadowed: ShadowedLayer[] = [];

  const paths = {
    userConfig: join(storage.configDir, USER_CONFIG_FILE),
    credentials: join(storage.configDir, CREDENTIALS_FILE),
  };

  const userConfig = readJsonObject(paths.userConfig, warnings);
  warnAboutMisplacedSecret(userConfig, paths.userConfig, warnings);

  const workspaceFromEnv = trimmed(env.WORKSPACE_ID);
  const workspaceFromFile = stringField(
    userConfig,
    "workspace",
    paths.userConfig,
    warnings,
  );
  const workspace = pick([
    {
      origin: "environment",
      value: workspaceFromEnv,
      label: "WORKSPACE_ID",
    },
    {
      origin: "user config",
      value: workspaceFromFile,
      label: `"workspace" in ${paths.userConfig}`,
    },
  ]);
  let workspaceUuid: string | null = null;
  if (workspace.value !== null) {
    // The same rule the MCP server applies, applied to file-sourced values too.
    // The value is kept as typed — a `<slug>-<uuid>` spelling is stored and
    // shown the way its owner wrote it; only what reaches a room, a token or
    // the database is the bare uuid, and that parse happens where it is used.
    workspaceUuid = parseWorkspaceId(workspace.value, workspace.label).uuid;
  }
  // Both layers name a workspace, so the file's is being overridden — say
  // which, and by what. Only a value the file actually supplied: a field of the
  // wrong type was warned about above and is no layer at all. (The environment
  // is the winner whenever it has a value, so `workspaceUuid` is its uuid; the
  // null check is how the types say so.)
  if (
    workspaceFromEnv !== null &&
    workspaceFromFile !== null &&
    workspaceUuid !== null
  ) {
    const differs = warnAboutShadowedWorkspace(
      { value: workspaceFromEnv, uuid: workspaceUuid },
      { value: workspaceFromFile, path: paths.userConfig },
      warnings,
    );
    if (differs) {
      shadowed.push({ setting: "workspace", layer: "user config" });
    }
  }

  // One layer, and deliberately one: `hubUrl` in this machine's `config.json`,
  // or the built-in default. Nothing ambient outranks it — see the module note.
  const hubUrl = pick([
    {
      origin: "user config",
      value: stringField(userConfig, "hubUrl", paths.userConfig, warnings),
      label: `"hubUrl" in ${paths.userConfig}`,
    },
  ]);

  // Credentials are read last and from one file only: every layer above is one
  // the user set on their own machine, so the secret applies to whichever
  // endpoint they chose. An exposed file is refused outright — its one
  // actionable message is the mode.
  const credentials = readCredentials(env);
  warnings.push(...credentials.warnings);
  const secretFromFile = credentials.exposed ? null : credentials.signingSecret;
  const secretFromEnv = trimmed(env.HUB_AUTH_TOKEN);
  // **That** they differ, and nothing else: not either value, not a length, not
  // a prefix. Compared after the exposure refusal above, so a file nobody may
  // read costs one warning — its mode — rather than two.
  if (
    (hubUrl.value === null || isLoopbackEndpoint(hubUrl.value)) &&
    secretFromEnv !== null &&
    secretFromFile !== null &&
    secretFromEnv !== secretFromFile
  ) {
    // `ub init` refuses this outright when a hub is in force; everywhere else
    // it is a warning. The same sentence, so the two tell one story.
    warnings.push(
      `HUB_AUTH_TOKEN in the environment is in force; ${paths.credentials} ` +
        "holds a different signing secret — make them equal, or unset one",
    );
    shadowed.push({ setting: "credential", layer: "credentials file" });
  }

  let secret: string | null = secretFromEnv;
  let credentialOrigin: CredentialOrigin | null =
    secretFromEnv === null ? null : "environment";
  if (secret === null && secretFromFile !== null) {
    secret = secretFromFile;
    credentialOrigin = "credentials file";
  }

  const resolvedEnv: NodeJS.ProcessEnv = { ...env };
  if (workspace.value !== null) {
    resolvedEnv.WORKSPACE_ID = workspace.value;
  }
  // Written when there is one and *removed* when there is not: this map is
  // handed to every child `ub` spawns (`ub mcp serve`, `ub env`), and leaving an
  // inherited `HUB_URL` in it would smuggle the ambient endpoint back in
  // through the child that reads it.
  if (hubUrl.value === null) {
    delete resolvedEnv.HUB_URL;
  } else {
    resolvedEnv.HUB_URL = hubUrl.value;
  }
  if (hubUrl.value !== null && !isLoopbackEndpoint(hubUrl.value)) {
    delete resolvedEnv.HUB_AUTH_TOKEN;
    credentialOrigin = null;
  } else if (secret !== null) {
    resolvedEnv.HUB_AUTH_TOKEN = secret;
  }

  return {
    env: resolvedEnv,
    origins: {
      workspace: workspace.origin,
      hubUrl: hubUrl.origin,
      credential: credentialOrigin,
    },
    paths,
    storage,
    shadowed,
    warnings,
  };
}

/** What `credentials.json` may hold today. Remote tokens arrive with #84. */
export interface Credentials {
  /** The hub's HMAC signing secret — not a token. */
  signingSecret?: string;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write `credentials.json` with mode 0600, and return its path.
 *
 * The writer lives next to the reader because the mode is the point: this file
 * holds the secret every hub token is signed with, so it must never be readable
 * by another user on the machine. Every guarantee about how that is done — the
 * descriptor tightened before anything is written, symlinks refused rather than
 * followed — belongs to {@link publishOwnerOnly}, which is also what writes
 * `config.json`.
 */
export function writeCredentials(
  credentials: Credentials,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = credentialsPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  publishOwnerOnly(path, serialize(credentials));
  return path;
}

/**
 * Put a signing secret in `credentials.json` and return the one now on disk —
 * which is not necessarily the candidate.
 *
 * This is the race `ub init` must not lose. Two fresh runs (a `mise run setup`
 * and an editor's MCP client starting at the same moment) would each generate a
 * secret, and last-write-wins leaves one of them convinced of a value that is no
 * longer there. So the claim is exclusive: exactly one process can publish the
 * file, and every loser adopts the winner's secret rather than its own.
 *
 * **Written first, published second.** The mechanism is `link`, not an exclusive
 * `open`. `open(O_CREAT|O_EXCL)` is atomic about the *name* but not about the
 * contents: between the create and the write there is an instant where the file
 * exists and is empty, and a loser that reads it then finds no secret and
 * concludes there is none — which is the whole bug, one syscall further along.
 * `link` publishes a name and complete contents in a single atomic step, and
 * fails with EEXIST if anything already holds that name. There is therefore no
 * moment at which `credentials.json` exists and is not readable, and no lock
 * file is needed to say so.
 *
 * The remaining case is a `credentials.json` that already exists *without* a
 * signing secret in it (a remote token from #84, say). Adding one there is an
 * ordinary read-modify-write of a file this user already owns, and two of those
 * can still interleave. That is accepted: it is not the security-bearing race —
 * no two secrets can exist after this function — and callers re-read the file
 * before deriving anything from it, so they converge on what the last writer
 * left.
 */
export function claimSigningSecret(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = credentialsPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const staged = writeTempBeside(
    path,
    serialize({ [SIGNING_SECRET_KEY]: candidate }),
  );
  if (publishStaged(staged, path, "absent")) {
    return candidate;
  }

  // Somebody else holds the name. Their secret is the one every other client on
  // this machine will use, so it becomes ours.
  const existing = readCredentials(env);
  if (existing.signingSecret !== null) {
    return existing.signingSecret;
  }
  // `link` leaves no empty window, so a file with no secret in it genuinely has
  // none. One re-read anyway, and only when the file did not parse at all — the
  // shape a half-written file would have if some other writer ever produced one.
  if (existing.raw === null) {
    const second = readCredentials(env);
    if (second.signingSecret !== null) {
      return second.signingSecret;
    }
  }
  writeCredentials({ ...existing.raw, [SIGNING_SECRET_KEY]: candidate }, env);
  return candidate;
}
