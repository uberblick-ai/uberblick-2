/** Machine settings hold identity and admission; only a complete binding selects a workspace. */

import { hubIdentity } from "./remote-url.js";
import { usesDeviceCredentials } from "./auth-store.js";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StoragePaths } from "./storage.js";
import { resolveStorage } from "./storage.js";
import { resolveProjectBinding, type ProjectBinding, NO_BINDING } from "./project-binding.js";
import { CREDENTIALS_FILE, credentialsPath } from "./auth-store.js";
export { credentialsPath } from "./auth-store.js";
import { trimmed } from "./strings.js";
import {
  publishOwnerOnly,
  publishStaged,
  writeTempBeside,
} from "./safe-write.js";

/** Per-user identity, endpoint admission, and legacy migration information. */
const USER_CONFIG_FILE = "config.json";

/** The key holding the hub's HMAC signing secret in `credentials.json`. */
const SIGNING_SECRET_KEY = "signingSecret";

/** Which layer a resolved value came from. Stable strings: `--json` prints them. */
export type Origin = "environment" | "project config" | "user config" | "default";

/** Signing-secret source labels. */
export type CredentialOrigin = "environment" | "credentials file";

/** A private credential source overridden by another explicit value. */
export interface ShadowedLayer {
  /** The setting the layers disagree about. */
  setting: "workspace" | "credential";
  /** The layer that lost. */
  layer: Origin | CredentialOrigin;
}

export interface ResolvedConfig {
  /** Resolved environment for MCP configuration and workspace-dependent children. */
  env: NodeJS.ProcessEnv;
  binding: ProjectBinding | null;
  bindingProblem?: string;
  origins: {
    workspace: Origin;
    hubUrl: Origin;
    /** Null when no signing secret is used, including device admission. */
    credential: CredentialOrigin | null;
  };
  /** The files consulted, whether or not they exist. */
  paths: {
    userConfig: string;
    credentials: string;
    projectConfig: string | null;
  };
  /** Storage roots and database directories shared with MCP. */
  storage: StoragePaths;
  /** Only disagreements count as shadowing; equal or unopposed values do not. */
  shadowed: ShadowedLayer[];
  /** Everything questionable about the configuration. For stderr, never stdout. */
  warnings: string[];
  credentialExposure: SigningSecretExposureError | null;
}

/** Recovery rotates a possibly leaked secret rather than trusting it again. */
export function exposedSigningSecretRemedy(path: string): string {
  return `delete ${path} so the next \`ub open\` makes a new secret; then restart running agents ` +
    "and run `ub auth login` again if the file held hub logins";
}

export class SigningSecretExposureError extends Error {
  constructor(readonly path: string, readonly permissions: string) {
    super(`refusing ${path}: mode ${permissions} lets other users read the hub signing secret, ` +
      `so its secret may have leaked — ${exposedSigningSecretRemedy(path)}`);
  }
}

export class BindingResolutionError extends Error {
  constructor(message: string, readonly reason: "invalid" | "missing" = "invalid") { super(message); }
}

/** CLI and MCP use the same storage layout. */
function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveStorage({ env }).configDir;
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), USER_CONFIG_FILE);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Missing files are silent; unusable files warn and skip this layer.
 * Parser errors can quote secrets, even in config files, so never print them.
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

/** Per-user identity plus legacy workspace fields, preserved for explicit migration. */
export interface UserConfig {
  // Explicit undefined permits parsed missing fields under exactOptionalPropertyTypes.
  workspace?: string | undefined;
  hubUrl?: string | undefined;
  /** Awareness display name. */
  displayName?: string | undefined;
  /** Awareness colour, 6-digit hex — the only form y-prosemirror accepts. */
  color?: string | undefined;
}

/** Admission metadata describes an endpoint; it never selects one. */
function hubAdmissions(
  source: Record<string, unknown> | null,
  path: string,
  warnings: string[],
): Record<string, "device"> {
  const result: Record<string, "device"> = {};
  const raw = source?.hubAdmissions;
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error(`Invalid hubAdmissions in ${path}: expected an endpoint-to-admission map`);
  }
  for (const [endpoint, admission] of Object.entries(raw ?? {})) {
    let normalized: string;
    try { normalized = hubIdentity(endpoint); }
    catch {
      warnings.push(`ignoring an invalid endpoint in hubAdmissions in ${path}`);
      continue;
    }
    // Unknown admission modes must not fall back to a local signing secret.
    if (admission !== "device") warnings.push(`unsupported hub admission in ${path}; using device credentials`);
    result[normalized] = "device";
  }
  return result;
}

/** The machine settings' problems, read without writing. */
export function userConfigWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const current = readUserConfig(env);
  const warnings = [...current.warnings];
  hubAdmissions(current.raw, userConfigPath(env), warnings);
  return warnings;
}

/** Save the verified endpoint's mode before publishing its project binding. */
export function writeHubAdmission(
  endpoint: string,
  device: boolean,
  env: NodeJS.ProcessEnv = process.env,
): { written: string[]; warnings: string[] } {
  const normalized = hubIdentity(endpoint);
  const current = readUserConfig(env);
  const path = userConfigPath(env);
  const warnings = [...current.warnings];
  const admissions = hubAdmissions(current.raw, path, warnings);
  if ((admissions[normalized] === "device") === device) return { written: [], warnings };
  if (device) admissions[normalized] = "device";
  else delete admissions[normalized];
  const updated: Record<string, unknown> = { ...current.raw, hubAdmissions: admissions };
  writeUserConfig(updated, env);
  return { written: [path], warnings };
}

/**
 * Return raw fields so writers preserve unrelated and unrecognized settings.
 * Full resolution, including origins, belongs to resolveConfig.
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

/** Owner-only publication also protects the endpoint to which signed tokens are sent. */
export function writeUserConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = userConfigPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  publishOwnerOnly(path, serialize(config));
  return path;
}

/** Configuration fields can be printed; misplaced signing secrets must be ignored. */
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

/** Exposure refusal applies to the file, not an explicit environment signing secret. */
function credentialsExposure(path: string): SigningSecretExposureError | null {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return null;
  }
  const permissions = mode & 0o777;
  if ((permissions & 0o077) === 0) {
    return null;
  }
  return new SigningSecretExposureError(path, permissions.toString(8).padStart(4, "0"));
}

/**
 * Return raw fields and signingSecret even when exposed, for preserving unrelated credentials.
 * Resolvers ignore an exposed secret; secret creation refuses the file without rewriting it.
 */
export function readCredentials(env: NodeJS.ProcessEnv = process.env): {
  path: string;
  /** The file as parsed, or null when it is absent or unusable. */
  raw: Record<string, unknown> | null;
  signingSecret: string | null;
  /** True when the file exists and other users can read it. */
  exposed: boolean;
  exposure: SigningSecretExposureError | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  const path = credentialsPath(env);
  const exposure = credentialsExposure(path);
  if (exposure !== null) warnings.push(exposure.message);
  const raw = readJsonObject(path, warnings);
  return {
    path,
    raw,
    signingSecret: stringField(raw, SIGNING_SECRET_KEY, path, warnings),
    exposed: exposure !== null,
    exposure,
    warnings,
  };
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Inventory callers can omit selection setup advice; other warnings remain. */
  warnLegacySelection?: boolean;
}

export function resolveConfig(options: ResolveOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env;
  let selection: ReturnType<typeof resolveProjectBinding>;
  try {
    selection = resolveProjectBinding(options);
  } catch (error) {
    throw new BindingResolutionError(message(error));
  }
  const storage = resolveStorage({ env });
  const warnings: string[] = [];
  const shadowed: ShadowedLayer[] = [];

  const paths = {
    userConfig: join(storage.configDir, USER_CONFIG_FILE),
    credentials: join(storage.configDir, CREDENTIALS_FILE),
    projectConfig: selection.path,
  };

  const userConfig = readJsonObject(paths.userConfig, warnings);
  warnAboutMisplacedSecret(userConfig, paths.userConfig, warnings);

  const workspace = { value: selection.binding?.workspaceId ?? null, origin: selection.origin ?? "default" } as const;
  const hubUrl = { value: selection.binding?.hubUrl ?? null, origin: selection.origin ?? "default" } as const;
  if (options.warnLegacySelection !== false && selection.binding === null &&
      (env.WORKSPACE_ID !== undefined || env.HUB_URL !== undefined ||
       userConfig?.workspace !== undefined || userConfig?.hubUrl !== undefined)) {
    warnings.push(`Legacy machine workspace/endpoint settings are not used. ${NO_BINDING}`);
  }

  // Read the single credential file after binding resolution; never use an exposed secret.
  const credentials = readCredentials(env);
  warnings.push(...credentials.warnings);
  const secretFromFile = credentials.exposed ? null : credentials.signingSecret;
  const secretFromEnv = trimmed(env.HUB_AUTH_TOKEN);
  const admissions = hubAdmissions(userConfig, paths.userConfig, warnings);
  const admissionEnv: NodeJS.ProcessEnv = { ...env };
  delete admissionEnv.HUB_ADMISSION;
  if (hubUrl.value !== null && admissions[hubIdentity(hubUrl.value)] === "device") admissionEnv.HUB_ADMISSION = "device";
  const device = hubUrl.value !== null && usesDeviceCredentials(hubUrl.value, admissionEnv);
  // Report disagreement without values, lengths or prefixes, only after exposure refusal.
  if (
    !device &&
    secretFromEnv !== null &&
    secretFromFile !== null &&
    secretFromEnv !== secretFromFile
  ) {
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

  const resolvedEnv: NodeJS.ProcessEnv = { ...admissionEnv };
  if (workspace.value !== null) {
    resolvedEnv.WORKSPACE_ID = workspace.value;
    resolvedEnv.UB_WORKSPACE_ID = workspace.value;
    resolvedEnv.UB_HUB_URL = hubUrl.value ?? "local";
  } else {
    delete resolvedEnv.WORKSPACE_ID;
    delete resolvedEnv.UB_WORKSPACE_ID;
    delete resolvedEnv.UB_HUB_URL;
  }
  // Remove an inherited HUB_URL when local so children cannot restore an ambient endpoint.
  if (hubUrl.value === null) {
    delete resolvedEnv.HUB_URL;
  } else {
    resolvedEnv.HUB_URL = hubUrl.value;
  }
  if (device) {
    delete resolvedEnv.HUB_AUTH_TOKEN;
    credentialOrigin = null;
  } else if (secret !== null) {
    resolvedEnv.HUB_AUTH_TOKEN = secret;
  }

  return {
    env: resolvedEnv,
    binding: selection.binding,
    ...(selection.bindingProblem === undefined ? {} : { bindingProblem: selection.bindingProblem }),
    origins: {
      workspace: workspace.origin,
      hubUrl: hubUrl.origin,
      credential: credentialOrigin,
    },
    paths,
    storage,
    shadowed,
    warnings,
    credentialExposure: credentials.exposure,
  };
}

/** Local-development credentials; remote device logins use the private auth store. */
export interface Credentials {
  /** The hub's HMAC signing secret — not a token. */
  signingSecret?: string;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** publishOwnerOnly tightens the descriptor before writing and refuses symlinks. */
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
 * Stage complete contents before exclusive link publication; losers adopt the winner's secret.
 * Creating the destination before writing would expose an empty file to concurrent readers.
 * Caller holds the shared config lock through existing-file read-modify-write,
 * preserving unrelated credentials and the winning secret.
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

  // Adopt the secret already published for this machine.
  const existing = readCredentials(env);
  if (existing.exposure !== null) {
    throw existing.exposure;
  }
  if (existing.signingSecret !== null) {
    return existing.signingSecret;
  }
  // Exclusive link publication has no empty window; retry only unparseable content once.
  if (existing.raw === null) {
    const second = readCredentials(env);
    if (second.signingSecret !== null) {
      return second.signingSecret;
    }
  }
  writeCredentials({ ...existing.raw, [SIGNING_SECRET_KEY]: candidate }, env);
  return candidate;
}

/**
 * Caller holds the config lock. Only workspace creation and local-hub startup create secrets;
 * configuration readers and the hub process never do.
 */
export function ensureLocalSigningSecret(env: NodeJS.ProcessEnv = process.env): {
  secret: string;
  created: boolean;
  path: string;
} {
  const path = credentialsPath(env);
  const fromEnv = trimmed(env.HUB_AUTH_TOKEN);
  if (fromEnv !== null) return { secret: fromEnv, created: false, path };
  const credentials = readCredentials(env);
  if (credentials.exposure !== null) {
    throw credentials.exposure;
  }
  if (credentials.signingSecret !== null) {
    return { secret: credentials.signingSecret, created: false, path };
  }
  const candidate = randomBytes(32).toString("hex");
  const secret = claimSigningSecret(candidate, env);
  return { secret, created: secret === candidate, path };
}

/** Refuse before opening a database or spawning a workspace-dependent child. */
export function requireBinding(resolved: ResolvedConfig): ProjectBinding {
  if (resolved.binding === null) throw new Error(resolved.bindingProblem === undefined
    ? NO_BINDING : `${resolved.bindingProblem} ${NO_BINDING}`);
  return resolved.binding;
}
