import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { hostname } from "node:os";
import { isGithubUsername } from "@uberblick/schema/github-identity";
import { sanitizeDeviceName } from "@uberblick/schema/device-name";
import { parseWorkspaceId } from "@uberblick/schema";
import {
  type StoredHubLogin,
  isHubLogin,
  preflightHubLoginStore,
  projectLoginFields,
  readHubLogins,
  removeHubLogin,
  writeHubLogin,
} from "./auth-store.js";
import { budget } from "./budget.js";
import { resolveProjectBinding } from "./project-binding.js";
import { openBrowser } from "./browser.js";
import { type Io, shellArgument } from "./io.js";
import { assertHubTransport, authenticationOrigin, hubTransportProblem, normalizeRemoteUrl } from "@uberblick/mcp-server/remote-url";
import { SYNC_PROTOCOL_VERSION, protocolSkew, readProtocolMismatch, wrapToken } from "@uberblick/schema/protocol";
import { manageRequest, ManagementResponseError, sanitizeManagementReply } from "./access-management.js";
export { authenticationOrigin } from "@uberblick/mcp-server/remote-url";

export const AUTH_HELP = `usage: ub auth [command]

commands:
  login [hub]            # Sign in to a hub with GitHub
  status [hub] [--json]  # Check the stored login and current hub administration
  logout [hub]           # Sign this computer out of a hub; --all-devices signs out all of yours
`;

export const AUTH_LOGIN_HELP = `usage: ub auth login [hub]

Sign in to the given hub, or the hub selected by this project's binding.
The hub can be a bare host, an http(s) address or a ws(s) endpoint.
Open the displayed GitHub URL and approve the code in any browser;
this command completes automatically and never asks for keyboard input.
In a local terminal, the approval page opens automatically after the guidance.
Over SSH or when stdout is not a terminal, only the URL and code are displayed.
BROWSER names the opener command; BROWSER=none skips automatic opening.
GitHub's approval page shows the app's name, not the hub.
Approve only a code you just started yourself for the displayed hub.
Store the issued device credential privately on this machine for remote sync.
Signing in again stores the new login, then revokes the replaced device.
If that revocation is not confirmed, login still succeeds and warns that the
previous device is not revoked.
Local-only work needs no login. Login never changes the project binding.
Signing in grants no workspace membership, except for the first claim below.
On a fresh, unclaimed hub, the first GitHub account to complete approval
claims its default workspace as administrator. Claiming is one-time; this
command reports the claim after storing the login, then lists the available
workspace UUIDs and any supplied names along with who signed in and the hub.

options:
  -h, --help             show this help
`;

export const AUTH_STATUS_OPTIONS = { json: { type: "boolean" } } as const;

export const AUTH_STATUS_HELP = `usage: ub auth status [hub] [--json]

Check whether the given hub, or the hub selected by this project's binding,
currently accepts this computer's stored login and whether it is a hub admin.
The hub can be a bare host, an http(s) address or a ws(s) endpoint.
Make one read-only request bounded to a few seconds; never renew or write a login.
Label the account and available workspace UUIDs and cached names as stored.
When the hub cannot answer, current verification is unavailable, not non-admin.
With no hub selected, show local-only status; local work needs no login.
Exit 0 for a confirmed answer or local-only status, 1 when verification is
unavailable, and 2 for a usage error.

options:
  --json                print the same report as one JSON object
  -h, --help             show this help
`;

export const AUTH_LOGOUT_OPTIONS = { "all-devices": { type: "boolean" } } as const;

export const AUTH_LOGOUT_HELP = `usage: ub auth logout [--all-devices] [hub]

Revoke this computer at the given hub, then remove its login here.
Without a hub, use the hub selected by this project's binding.
The hub can be a bare host, an http(s) address or a ws(s) endpoint.
If revocation is not confirmed, the local login is still removed; exit 1.
Finish with \`ub auth logout --all-devices <hub>\` from a computer still signed in.
With --all-devices, revoke every device of your signed-in GitHub account on
that hub, this computer last. Failure keeps the local login; exit 1.
Retry needs a login the hub still accepts: run --all-devices again, or sign in
again with \`ub auth login <hub>\` or use another computer still signed in.
Workspace memberships, the project binding and local workspace copies stay.

options:
  --all-devices         revoke all of your devices on this hub
  -h, --help             show this help
`;

interface Selection {
  origin: string;
  endpoint: string;
  bound: boolean;
  workspace: string | undefined;
  bindingOrigin: ReturnType<typeof resolveProjectBinding>["origin"];
}

const GITHUB_APPROVAL_URL = "https://github.com/login/device";

interface SelectionFailure {
  outcome: "no-hub" | "binding-invalid" | "usage-error";
  guidance: string;
  exitCode: 1 | 2;
}

function selectHub(hub: string | undefined): Selection | SelectionFailure {
  // An explicit authentication target works before any project is bound.
  // Resolve a binding only for the implicit target, or to describe membership.
  let resolved: ReturnType<typeof resolveProjectBinding> | undefined;
  try {
    resolved = resolveProjectBinding();
  } catch (error) {
    if (hub === undefined) {
      return { outcome: "binding-invalid", exitCode: 1,
        guidance: error instanceof Error ? error.message : "cannot read the project binding" };
    }
  }
  const binding = resolved?.binding;
  const selected = hub ?? binding?.hubUrl ?? undefined;
  if (selected === undefined) {
    return { outcome: "no-hub", exitCode: 1,
      guidance: "no hub given and none bound. Local-only work needs no login. Give a hub to `ub auth login <hub>`." };
  }
  let origin: string;
  let endpoint: string;
  try {
    endpoint = normalizeRemoteUrl(selected);
    origin = authenticationOrigin(endpoint);
  } catch {
    // Never echo an operand: it may be a pasted secret or a credential URL.
    return { outcome: "usage-error", exitCode: 2,
      guidance: "invalid hub; use a bare host, http(s) address or ws(s) endpoint without credentials, query or fragment." };
  }
  let bound = false;
  if (binding?.hubUrl != null) {
    try { bound = authenticationOrigin(binding.hubUrl) === origin; } catch { /* Invalid binding is never rewritten. */ }
  }
  return { origin, endpoint, bound, workspace: binding?.workspaceId, bindingOrigin: resolved?.origin ?? null };
}

export function displayUsername(user: string): string {
  // JSON quoting escapes C0 controls; DEL and C1 also need terminal-safe escapes.
  return isGithubUsername(user) ? user : JSON.stringify(user).replace(/[\u007f-\u009f]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function describeWorkspaces(login: StoredHubLogin, io: Io): void {
  const workspaces = login.credential.record.workspaces;
  const names = login.credential.workspaceNames;
  io.out(workspaces.length === 0
    ? "available workspaces: none\n"
    : `available workspaces:\n${workspaces.map(workspace =>
      `  ${workspace}${names?.[workspace] === undefined ? "" : ` | ${names[workspace]}`}\n`).join("")}`);
}

type AuthStatusOutcome = "hub-admin" | "not-hub-admin" | "no-hub" | "binding-invalid" |
  "not-signed-in" | "credential-store" | "login-refused" | "hub-unsupported" |
  "update-required" | "hub-unreachable" | "hub-error";

interface StoredLoginReport {
  account: { login: string; provider: "github" };
  workspaces: { id: string; name?: string }[];
  boundWorkspace?: { id: string; source: ".uberblick.json" | "UB_WORKSPACE_ID"; note: string };
}

function storedLoginReport(selection: Selection, login: StoredHubLogin): StoredLoginReport {
  const report: StoredLoginReport = {
    account: { login: login.identity.githubUsername, provider: "github" },
    workspaces: login.credential.record.workspaces.map(id => ({ id,
      ...(login.credential.workspaceNames?.[id] === undefined ? {} : { name: login.credential.workspaceNames[id] }),
    })),
  };
  if (selection.bound && selection.workspace !== undefined) {
    const id = parseWorkspaceId(selection.workspace).uuid;
    if (!login.credential.record.workspaces.includes(id)) {
      report.boundWorkspace = { id,
        source: selection.bindingOrigin === "environment" ? "UB_WORKSPACE_ID" : ".uberblick.json",
        note: "The bound workspace is absent from the stored login. Ask a workspace admin about access or a hub admin about suspension.",
      };
    }
  }
  return report;
}

function describeStoredLogin(storedLogin: StoredLoginReport | null, io: Io): void {
  io.out(`stored account  ${storedLogin === null ? "none read" : `${displayUsername(storedLogin.account.login)} (github)`}\n`);
  if (storedLogin === null) return;
  io.out(storedLogin.workspaces.length === 0 ? "stored available workspaces: none\n"
    : `stored available workspaces:\n${storedLogin.workspaces.map(workspace =>
      `  ${workspace.id}${workspace.name === undefined ? "" : ` | ${workspace.name}`}\n`).join("")}`);
  if (storedLogin.boundWorkspace !== undefined) {
    const bound = storedLogin.boundWorkspace;
    io.out(`bound workspace (${bound.source})  ${bound.id}\n${bound.note}\n`);
  }
}

function printAuthStatus(
  hub: string | null, outcome: AuthStatusOutcome, storedLogin: StoredLoginReport | null,
  io: Io, json: boolean, guidance?: string,
): number {
  const confirmed = outcome === "hub-admin" || outcome === "not-hub-admin";
  const loginAccepted = confirmed ? true : outcome === "login-refused" ? false : null;
  const hubAdmin = confirmed ? outcome === "hub-admin" : null;
  if (json) io.out(`${JSON.stringify({ hub, outcome, loginAccepted, hubAdmin, storedLogin })}\n`);
  else {
    authField(io, "hub", hub ?? (outcome === "no-hub" ? "none (local-only)" : "not selected"));
    if (outcome === "no-hub") io.out("Local-only work needs no login.\n");
    else {
      describeStoredLogin(storedLogin, io);
      io.out("hub's current answer:\n");
      const unknown = `not verified (${outcome})`;
      io.out(`login (hub)  ${loginAccepted === null ? unknown : loginAccepted ? "accepted" : "refused"}\n`);
      io.out(`hub admin (hub)  ${hubAdmin === null ? unknown : hubAdmin ? "yes" : "no"}\n`);
    }
  }
  if (guidance !== undefined) io.err(`ub auth status: ${guidance}\n`);
  return confirmed || outcome === "no-hub" ? 0 : 1;
}

async function checkStoredLogin(origin: string, login: StoredHubLogin): Promise<{ outcome: AuthStatusOutcome; guidance?: string }> {
  const signIn = `Run \`ub auth login ${origin}\`.`;
  const action = { operation: "own-hub-role" } as const;
  let reply: Awaited<ReturnType<typeof manageRequest>>;
  let responseStatus: number | undefined;
  const unreachable = { outcome: "hub-unreachable", guidance: "the hub is unreachable or the request timed out; check the network or VPN, then retry." } as const;
  try {
    const response = await manageRequest(origin, action, login, {
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(budget(3_000)))), maxResponseBytes: 16_384,
    });
    responseStatus = response.status;
    reply = sanitizeManagementReply(action, response, login);
  } catch (error) {
    if (error instanceof ManagementResponseError) {
      if ([502, 503, 504].includes(error.status ?? responseStatus ?? 0)) return unreachable;
      if (error.updateRequired) {
        return { outcome: "hub-unsupported", guidance: "the hub has no supported management interface; ask whoever runs the hub to update or configure it." };
      }
      return { outcome: "hub-error", guidance: "the hub returned an invalid response; ask whoever runs the hub." };
    }
    return unreachable;
  }
  switch (reply.body.status) {
    case "ok": return { outcome: "hub-admin" };
    case "forbidden": return { outcome: "not-hub-admin" };
    case "sign-in-required": return { outcome: "login-refused", guidance: `the hub refuses this stored login. ${signIn}` };
    case "invalid-request":
    case "not-configured":
      return { outcome: "hub-unsupported", guidance: "the hub cannot check current hub administration; ask whoever runs the hub to update or configure it." };
    case "protocol-mismatch": {
      const version = readProtocolMismatch(String(reply.body.reason));
      return version === null
        ? { outcome: "hub-error", guidance: "the hub returned an invalid protocol response; ask whoever runs the hub." }
        : { outcome: "update-required", guidance: `${protocolSkew(version, SYNC_PROTOCOL_VERSION)}.` };
    }
    default: return { outcome: "hub-error", guidance: "the hub could not answer; ask whoever runs the hub." };
  }
}

async function status(selection: Selection, io: Io, json: boolean): Promise<number> {
  const stored = readHubLogins();
  const login = stored.logins[selection.origin];
  const signIn = `Run \`ub auth login ${selection.origin}\`.`;
  if (login === undefined) {
    const storeProblem = stored.state === "refused" || stored.state === "unreadable" || stored.unreadableHubs.includes(selection.origin);
    return printAuthStatus(selection.origin, storeProblem ? "credential-store" : "not-signed-in", null, io, json,
      `${storeProblem ? stored.diagnostic ?? "the stored login is unreadable." : "no login stored for this hub."} ${signIn}`);
  }
  const report = storedLoginReport(selection, login);
  if (login.credential.record.revokedAt !== null) {
    return printAuthStatus(selection.origin, "not-signed-in", report, io, json,
      `this stored credential is recorded as revoked. ${signIn}`);
  }
  const checked = await checkStoredLogin(selection.origin, login);
  return printAuthStatus(selection.origin, checked.outcome, report, io, json, checked.guidance);
}

class DeviceFailure extends Error {}

type DeviceAction = { operation: "list-devices" } | { operation: "revoke-device"; deviceId: string };

async function deviceRequest(origin: string, action: DeviceAction, login: StoredHubLogin, io: Io) {
  const transport = hubTransportProblem(origin);
  if (transport !== null) throw new DeviceFailure(`${transport.reason}; ${transport.fix}`);
  let reply: Awaited<ReturnType<typeof manageRequest>>;
  try { reply = await manageRequest(origin, action, login); } catch (error) {
    throw new DeviceFailure(error instanceof ManagementResponseError
      ? "the hub returned an invalid device-management response"
      : "the hub is unreachable or the device-management request timed out");
  }
  if (reply.status === 200 && reply.body.status === "ok") return reply.body;
  if (action.operation === "revoke-device" && reply.status === 500 &&
      reply.body.status === "closure-failed" && reply.body.applied === true) {
    io.err("ub auth: warning: revocation committed, but the hub could not close every active connection; repair the hub before relying on access closure.\n");
    return reply.body;
  }
  const refusals: Record<string, [number, string]> = {
    "sign-in-required": [401, "sign-in-required: the hub refuses this login"],
    forbidden: [403, "forbidden: the hub refused own-device management"],
    "device-not-found": [404, "device-not-found: the hub did not revoke this device"],
    "protocol-mismatch": [409, "protocol-mismatch: update the hub and client together"],
    "not-configured": [503, "not-configured: the hub does not support authenticated device management"],
    failed: [500, "the hub could not complete device management"],
  };
  const refusal = refusals[String(reply.body.status)];
  throw new DeviceFailure(refusal?.[0] === reply.status ? refusal[1] : "the hub returned an invalid device-management response");
}

function authField(io: Io, label: string, value: string): void {
  io.out(`${label.padEnd(11)}${value}\n`);
}

async function logout(selection: Selection, io: Io, allDevices: boolean): Promise<number> {
  const { origin } = selection;
  const stored = readHubLogins();
  const login = stored.logins[origin];
  const missing = stored.state === "refused" ? "stored login refused"
    : stored.state === "unreadable" || stored.unreadableHubs.includes(origin) ? "stored login unreadable" : "no login stored";
  let failure: string | undefined;
  if (allDevices) {
    if (login === undefined) {
      io.err(`ub auth: ${missing} for ${origin}. ${stored.diagnostic ?? ""} Run \`ub auth login ${origin}\`. Local login kept.\n`);
      return 1;
    }
    let devices: string[];
    try {
      const body = await deviceRequest(origin, { operation: "list-devices" }, login, io);
      if (!Array.isArray(body.devices)) throw new DeviceFailure("the hub returned an invalid device list");
      const seen = new Set<string>();
      devices = body.devices.map(device => {
        if (!object(device) || typeof device.deviceId !== "string" || device.deviceId.length === 0 ||
            typeof device.current !== "boolean" || seen.has(device.deviceId) ||
            device.current !== (device.deviceId === login.credential.record.deviceId)) {
          throw new DeviceFailure("the hub returned an invalid device list");
        }
        seen.add(device.deviceId);
        return device.deviceId;
      });
      if (!seen.has(login.credential.record.deviceId)) throw new DeviceFailure("the hub returned an invalid device list");
      // The key authorizes every request. Revoking its device first would
      // prevent the remaining requests from authenticating.
      devices = devices.filter(id => id !== login.credential.record.deviceId).concat(login.credential.record.deviceId);
    } catch (error) {
      io.err(`ub auth: ${error instanceof DeviceFailure ? error.message : "could not list devices"}. Local login kept.\n`);
      return 1;
    }
    let confirmed = 0;
    try {
      for (const deviceId of devices) {
        await deviceRequest(origin, { operation: "revoke-device", deviceId }, login, io);
        confirmed++;
      }
    } catch (error) {
      authField(io, "confirmed", `${confirmed} revocations on ${origin}`);
      authField(io, "kept", `login for ${origin} on this computer`);
      io.err(`ub auth: ${error instanceof DeviceFailure ? error.message : "device revocation failed"}. This computer's revocation is uncertain; the kept login may no longer work.\n`);
      io.err(`Run \`ub auth logout --all-devices ${origin}\` again with a login the hub still accepts. If the hub refuses this computer's login, sign in again with \`ub auth login ${origin}\` or use another computer still signed in.\n`);
      return 1;
    }
    const user = login.identity.githubUsername;
    authField(io, "revoked", `${confirmed} devices of ${displayUsername(user)} on ${origin}, including this computer`);
  } else if (login !== undefined) {
    try {
      await deviceRequest(origin, { operation: "revoke-device", deviceId: login.credential.record.deviceId }, login, io);
      authField(io, "revoked", `this computer on ${origin}`);
    } catch (error) {
      failure = error instanceof DeviceFailure ? error.message : "revocation not confirmed";
    }
  } else if (missing !== "no login stored") {
    failure = missing;
  }
  if (failure !== undefined) {
    io.err(`ub auth: this computer is not yet revoked on ${origin}: ${failure}.\n`);
    io.err(`To finish, run \`ub auth logout --all-devices ${origin}\` from a computer that is still signed in.\n`);
  }
  try {
    const removed = await removeHubLogin(origin);
    if (removed) authField(io, "removed", `login for ${origin} on this computer`);
    else io.out("No login stored for this hub.\n");
  } catch (error) {
    io.err(`ub auth: ${error instanceof Error ? error.message : "could not remove the stored login"}\n`);
    return 1;
  }
  if (allDevices) io.out(`sign in again on the computers you still use: ub auth login ${origin}\n`);
  return failure === undefined ? 0 : 1;
}

const REQUEST_MS = 10_000;
const CLAIM_STATE_MS = 2_000;
const CANCEL_MS = 2_000;
const MAX_LIFETIME_SECONDS = 900;
const MAX_RESPONSE_BYTES = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class SignInFailure extends Error {}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function seconds(value: unknown, allowZero = false): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1);
}

/** Every byte is bounded; the fetch signal also bounds a stalled JSON body. */
async function readResponse(
  response: Response, invalidResponse: (missingInterface?: boolean) => Error,
): Promise<Record<string, unknown>> {
  if (response.body === null) throw invalidResponse(true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_RESPONSE_BYTES) throw invalidResponse();
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  let result: unknown;
  try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    throw invalidResponse(true);
  }
  if (!object(result)) {
    throw invalidResponse();
  }
  return result;
}

async function isUnclaimed(origin: string, signal: AbortSignal): Promise<boolean> {
  assertHubTransport(origin);
  try {
    const response = await fetch(`${origin}/auth/claim-state`, {
      method: "GET", redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(budget(CLAIM_STATE_MS))]),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return false;
    }
    const result = await readResponse(response, () => new Error("invalid claim state"));
    // A failed or older interface is never evidence that the hub is unclaimed.
    return Object.keys(result).length === 2 && typeof result.unclaimed === "boolean" &&
      typeof result.canClaim === "boolean" && (!result.canClaim || result.unclaimed) && result.unclaimed;
  } catch { return false; }
}

/** Released sign-in hubs check version before the empty token, without changing state. */
async function checkSignInProtocol(origin: string, signal: AbortSignal): Promise<void> {
  assertHubTransport(origin);
  const response = await fetch(`${origin}/auth/credential/renew`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: wrapToken(""), redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]),
  });
  // Only a validated mismatch diagnoses skew. Leave unavailable sign-in or
  // an older interface to the existing start request and its diagnostics.
  if (response.status !== 409) {
    await response.body?.cancel();
    return;
  }
  let result: Record<string, unknown>;
  try { result = await readResponse(response, () => new Error("invalid protocol reply")); } catch { return; }
  if (result.status !== "protocol-mismatch" || typeof result.reason !== "string") return;
  const hubVersion = readProtocolMismatch(result.reason);
  if (hubVersion !== null) throw new SignInFailure(protocolSkew(hubVersion, SYNC_PROTOCOL_VERSION));
}

/** Every byte and every network wait is bounded, including a stalled JSON body. */
async function post(
  origin: string, route: "start" | "collect" | "cancel", body: object,
  signal: AbortSignal, timeoutMs: number,
  received?: (result: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  assertHubTransport(origin);
  const response = await fetch(`${origin}/auth/github/${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)))]),
  });
  // A proxy can answer while its hub is stopped or restarting. Valid hub
  // replies still distinguish an upstream failure or unconfigured sign-in.
  const invalidResponse = (missingInterface = false) => new SignInFailure(
    [502, 503, 504].includes(response.status)
      ? "the hub is unreachable or temporarily unavailable; try login again"
      : missingInterface ? "the hub does not offer a valid GitHub sign-in interface; update the hub"
      : "the hub returned an invalid GitHub sign-in response; update the hub",
  );
  const result = await readResponse(response, invalidResponse);
  received?.(result);
  if (typeof result.status !== "string") throw invalidResponse();
  const allowed = route === "start"
    ? ["pending", "failed", "busy", "not-configured", "invalid-request"]
    : ["pending", "complete", "denied", "expired", "abandoned", "failed", "collected", "unknown-request", "not-configured", "invalid-request"];
  if (!allowed.includes(result.status)) throw invalidResponse();
  const expectedCode = result.status === "not-configured" ? 503
    : result.status === "invalid-request" ? 400
    : result.status === "unknown-request" ? 404
    : route === "start" && result.status === "busy" ? 429
    : route === "start" && result.status === "failed" ? 502 : 200;
  if (response.status !== expectedCode) throw invalidResponse();
  return result;
}

function terminal(result: Record<string, unknown>): never {
  const messages: Record<string, string> = {
    denied: "GitHub sign-in was denied",
    expired: "GitHub sign-in expired; run login again",
    abandoned: "GitHub sign-in was abandoned",
    failed: "GitHub sign-in failed at the hub or GitHub",
    collected: "the sign-in credential was already collected; run login again",
    "unknown-request": "the sign-in attempt was lost at the hub (restart or eviction); run login again",
    "not-configured": "the hub is not configured for GitHub sign-in",
    busy: "the hub is busy with sign-in attempts; try again later",
    "invalid-request": "the hub refused the sign-in request; update the hub and client",
  };
  throw new SignInFailure(messages[String(result.status)] ?? "the hub returned an invalid GitHub sign-in response; update the hub");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This function predates the complexity limit.
async function login(selection: Selection, io: Io, nextAction: boolean): Promise<number> {
  try { preflightHubLoginStore(); } catch (error) {
    io.err(`ub auth: ${error instanceof Error ? error.message : "credential store is not writable"}\n`);
    return 1;
  }
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let attempt: { requestId: string; collectionSecret: string } | undefined;
  let deadline: number | undefined;
  let collected = false;
  let stored = false;
  let claimedWorkspaceId: string | undefined;
  try {
    await checkSignInProtocol(selection.origin, interrupted.signal);
    if (interrupted.signal.aborted) throw new SignInFailure("GitHub sign-in interrupted");
    const unclaimed = await isUnclaimed(selection.origin, interrupted.signal);
    if (interrupted.signal.aborted) throw new SignInFailure("GitHub sign-in interrupted");
    // A start interrupted before its reply has no collection secret to cancel
    // with. Finish this bounded read so a late reply can still be abandoned.
    let deviceName: string | undefined;
    try { deviceName = sanitizeDeviceName(hostname()); } catch { /* Hostname metadata must never prevent sign-in. */ }
    const start = (body: object) => post(selection.origin, "start", body, new AbortController().signal, REQUEST_MS, (result) => {
      // Valid authority permits cleanup even if the envelope or public fields
      // are malformed. Never display any of the private start fields.
      if (typeof result.requestId === "string" && UUID.test(result.requestId) &&
          typeof result.collectionSecret === "string" && /^[A-Za-z0-9_-]{43}$/.test(result.collectionSecret)) {
        attempt = { requestId: result.requestId, collectionSecret: result.collectionSecret };
      }
    });
    let started = await start(deviceName === undefined ? {} : { deviceName });
    // Older hubs require an empty start body. Only a validated refusal with
    // no attempt authority permits one unnamed retry; interrupted starts stop.
    if (deviceName !== undefined && started.status === "invalid-request" &&
        Object.keys(started).length === 1 && !interrupted.signal.aborted) {
      started = await start({});
    }
    if (started.status !== "pending") terminal(started);
    if (attempt === undefined ||
        started.verificationUri !== GITHUB_APPROVAL_URL ||
        typeof started.userCode !== "string" || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(started.userCode) ||
        !seconds(started.expiresIn, true) || started.expiresIn > MAX_LIFETIME_SECONDS ||
        !seconds(started.interval) || started.interval > MAX_LIFETIME_SECONDS) {
      throw new SignInFailure("the hub returned an invalid GitHub sign-in response; update the hub");
    }
    deadline = performance.now() + started.expiresIn * 1000;
    if (interrupted.signal.aborted) throw new SignInFailure("GitHub sign-in interrupted");
    io.out("approve only a code you just started yourself\n");
    if (unclaimed) io.out("this hub is unclaimed: the first account to approve becomes its admin\n");
    authField(io, "open", started.verificationUri);
    authField(io, "code", started.userCode);
    io.out("waiting for approval…\n");
    if (process.stdout.isTTY &&
        process.env.SSH_CONNECTION === undefined &&
        process.env.SSH_CLIENT === undefined &&
        process.env.SSH_TTY === undefined) {
      // Browser failures must never enter sign-in's cancellation path.
      try { openBrowser(GITHUB_APPROVAL_URL, process.env, io); } catch {
        io.err("ub auth: warning: could not open a browser; approve using the displayed URL and code.\n");
      }
    }
    let interval = started.interval;
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new SignInFailure("GitHub sign-in expired; run login again");
      await delay(Math.min(interval * 1000, remaining), undefined, { signal: interrupted.signal });
      const left = deadline - performance.now();
      if (left <= 0) throw new SignInFailure("GitHub sign-in expired; run login again");
      const result = await post(selection.origin, "collect", attempt, interrupted.signal, Math.min(REQUEST_MS, left));
      if (result.status === "pending" && seconds(result.interval)) { interval = result.interval; continue; }
      if (result.status !== "complete") terminal(result);
      collected = true;
      const supplied = { identity: result.identity, credential: result.credential };
      if (!isHubLogin(supplied) || supplied.identity.githubUsername.includes(attempt.collectionSecret)) {
        throw new SignInFailure("the hub returned an invalid sign-in credential; run login again");
      }
      const credential = projectLoginFields(supplied, attempt.collectionSecret);
      if (Object.hasOwn(result, "claimedWorkspaceId")) {
        if (typeof result.claimedWorkspaceId !== "string" || !UUID.test(result.claimedWorkspaceId) ||
            !credential.credential.record.workspaces.includes(result.claimedWorkspaceId)) {
          throw new SignInFailure("the hub returned an invalid sign-in claim result; run login again");
        }
        claimedWorkspaceId = result.claimedWorkspaceId;
      }
      if (interrupted.signal.aborted) throw new SignInFailure("GitHub sign-in interrupted");
      let replaced: StoredHubLogin | null;
      try { replaced = await writeHubLogin(selection.origin, credential, process.env, interrupted.signal); } catch (error) {
        if (interrupted.signal.aborted) throw new SignInFailure("GitHub sign-in interrupted");
        const claim = claimedWorkspaceId === undefined ? "" : ` The hub claimed default workspace (${claimedWorkspaceId}) for this account.`;
        io.err(`ub auth: could not store login for ${selection.origin}: ${error instanceof Error ? error.message : "credential store write failed"}.${claim} The issued device remains on the hub; revoke it through device management if needed.\n`);
        return 1;
      }
      stored = true;
      if (replaced !== null) {
        try {
          // Revoking a device revokes all its credentials, including renewals.
          // A malformed collection must never make cleanup revoke the new one.
          if (replaced.credential.record.deviceId === credential.credential.record.deviceId) {
            throw new DeviceFailure("the previous and new login name the same device");
          }
          await deviceRequest(selection.origin, {
            operation: "revoke-device", deviceId: replaced.credential.record.deviceId,
          }, replaced, io);
        } catch (error) {
          io.err(`ub auth: warning: the previous device is not revoked on ${selection.origin}: ${error instanceof DeviceFailure ? error.message : "revocation not confirmed"}. The new login is stored.\n`);
        }
      }
      authField(io, "signed in", `${displayUsername(credential.identity.githubUsername)} on ${selection.origin}`);
      if (claimedWorkspaceId !== undefined) authField(io, "claimed", `default workspace (${claimedWorkspaceId}), you are admin`);
      describeWorkspaces(credential, io);
      if (nextAction && claimedWorkspaceId !== undefined &&
          (!selection.bound || selection.workspace === undefined ||
            parseWorkspaceId(selection.workspace).uuid !== claimedWorkspaceId)) {
        io.out(`Use it here: ub workspace use ${shellArgument(`${selection.endpoint}/${claimedWorkspaceId}`)}\n`);
      }
      return 0;
    }
  } catch (error) {
    const message = interrupted.signal.aborted ? "GitHub sign-in interrupted"
      : deadline !== undefined && performance.now() >= deadline ? "GitHub sign-in expired; run login again"
      : error instanceof SignInFailure ? error.message : "the hub is unreachable or the sign-in request timed out";
    io.err(`ub auth: ${selection.origin}: ${message}.\n`);
    if (claimedWorkspaceId !== undefined && !stored) io.err(`ub auth: the hub claimed default workspace (${claimedWorkspaceId}) for this account.\n`);
    if (collected) io.err("ub auth: the issued device remains on the hub; revoke it through device management if needed.\n");
    return 1;
  } finally {
    if (attempt !== undefined && !stored) {
      try {
        const result = await post(selection.origin, "cancel", attempt, new AbortController().signal, CANCEL_MS);
        if (result.status === "collected" && !collected) {
          io.err("ub auth: the issued device remains on the hub; revoke it through device management if needed.\n");
        }
      } catch {
        if (!collected) io.err(`ub auth: ${selection.origin}: could not abandon the sign-in attempt at the hub; any pending attempt will expire. A device may have been issued; revoke it through device management if needed.\n`);
      }
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

export async function authCommand(argv: string[], io: Io, options: { loginNextAction?: boolean } = {}): Promise<number> {
  const [sub, ...args] = argv;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    io.out(AUTH_HELP);
    return 0;
  }
  let help: string;
  if (sub === "login") help = AUTH_LOGIN_HELP;
  else if (sub === "status") help = AUTH_STATUS_HELP;
  else if (sub === "logout") help = AUTH_LOGOUT_HELP;
  else { io.err(`ub auth: unknown command\n\n${AUTH_HELP}`); return 2; }
  if (args.includes("--help") || args.includes("-h")) { io.out(help); return 0; }
  let hub: string | undefined;
  let allDevices = false;
  let json = false;
  try {
    const parsed = parseArgs({ args, options: sub === "logout" ? AUTH_LOGOUT_OPTIONS : sub === "status" ? AUTH_STATUS_OPTIONS : {}, allowPositionals: true });
    if (parsed.positionals.length > 1) {
      io.err(`ub auth ${sub}: expected at most one hub\n\n${help}`);
      return 2;
    }
    hub = parsed.positionals[0];
    allDevices = "all-devices" in parsed.values && parsed.values["all-devices"] === true;
    json = "json" in parsed.values && parsed.values.json === true;
  } catch (error) {
    const unknown = error instanceof Error && "code" in error && error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION";
    io.err(`ub auth ${sub}: ${unknown ? "unknown option" : "invalid option usage"}\n\n${help}`);
    return 2;
  }
  const selection = selectHub(hub);
  if ("outcome" in selection) {
    if (sub === "status" && selection.outcome !== "usage-error") {
      return printAuthStatus(null, selection.outcome, null, io, json, selection.outcome === "no-hub"
        ? "name a hub to check it with `ub auth status <hub>`." : selection.guidance);
    }
    io.err(`ub auth: ${selection.guidance}\n`);
    return selection.exitCode;
  }
  const transport = hubTransportProblem(hub ?? selection.endpoint);
  if (transport !== null && (hub !== undefined || sub !== "logout")) {
    const guidance = `${transport.reason}; ${transport.fix}`;
    if (sub === "status" && hub === undefined) {
      return printAuthStatus(selection.origin, "binding-invalid", null, io, json, guidance);
    }
    io.err(`ub auth: ${guidance}\n`);
    return hub === undefined ? 1 : 2;
  }
  if (sub === "login") {
    authField(io, "hub", selection.origin);
    return await login(selection, io, options.loginNextAction !== false);
  }
  if (sub === "status") return await status(selection, io, json);
  return await logout(selection, io, allDevices);
}
