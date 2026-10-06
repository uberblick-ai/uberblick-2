/** Remote sign-in stores a device credential; live sync still uses its existing auth. */
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { isGithubUsername } from "@uberblick/hub";
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
import type { Io } from "./io.js";
import { authenticationOrigin } from "@uberblick/hub/remote-url";
import { manageRequest, ManagementResponseError } from "./access-management.js";
export { authenticationOrigin } from "@uberblick/hub/remote-url";

export const AUTH_HELP = `usage: ub auth [command]

commands:
  login [hub]      # Sign in to a hub with GitHub
  status [hub]     # Show who this computer is signed in as, and what it can reach
  logout [hub]     # Sign this computer out of a hub; --all-devices signs out all of yours
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
On a fresh, unclaimed hub, the first GitHub account to complete approval
claims its default workspace as administrator. Claiming is one-time; this
command reports the claim after storing the login, then lists the available
workspace UUIDs and any supplied names along with who signed in and the hub.

options:
  -h, --help             show this help
`;

export const AUTH_STATUS_HELP = `usage: ub auth status [hub]

Show who this computer is signed in as and the available workspace UUIDs and names
for the given hub, or the hub selected by this project's binding.
The hub can be a bare host, an http(s) address or a ws(s) endpoint.
Read only this computer's stored login, without using the network.
Run \`ub status\` to see whether the hub accepts that login now.

options:
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
  bound: boolean;
  workspace: string | undefined;
  bindingOrigin: ReturnType<typeof resolveProjectBinding>["origin"];
}

const GITHUB_APPROVAL_URL = "https://github.com/login/device";

function selectHub(hub: string | undefined, io: Io, describe = true): Selection | number {
  // An explicit authentication target works before any project is bound.
  // Resolve a binding only for the implicit target, or to describe membership.
  let resolved: ReturnType<typeof resolveProjectBinding> | undefined;
  try {
    resolved = resolveProjectBinding();
  } catch (error) {
    if (hub === undefined) {
      io.err(`ub auth: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  const binding = resolved?.binding;
  const selected = hub ?? binding?.hubUrl ?? undefined;
  if (selected === undefined) {
    io.err("ub auth: no hub given and none bound. Local-only work needs no login. Give a hub to `ub auth login <hub>`.\n");
    return 1;
  }
  let origin: string;
  try {
    origin = authenticationOrigin(selected);
  } catch {
    // Never echo an operand: it may be a pasted secret or a credential URL.
    io.err("ub auth: invalid hub; use a bare host, http(s) address or ws(s) endpoint without credentials, query or fragment.\n");
    return 2;
  }
  let bound = false;
  if (binding?.hubUrl != null) {
    try { bound = authenticationOrigin(binding.hubUrl) === origin; } catch { /* Invalid binding is never rewritten. */ }
  }
  if (describe) {
    authField(io, "hub", origin);
  }
  return { origin, bound, workspace: binding?.workspaceId, bindingOrigin: resolved?.origin ?? null };
}

function displayUsername(user: string): string {
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

function describeMissingWorkspace(selection: Selection, login: StoredHubLogin, io: Io): boolean {
  if (!selection.bound || selection.workspace === undefined) return false;
  let workspace: string;
  try { workspace = parseWorkspaceId(selection.workspace).uuid; } catch {
    io.err("ub auth: the bound workspace is invalid; fix workspaceId in the project binding.\n");
    return true;
  }
  if (login.credential.record.workspaces.includes(workspace)) return false;
  const source = selection.bindingOrigin === "environment" ? "UB_WORKSPACE_ID" : ".uberblick.json";
  const user = displayUsername(login.identity.githubUsername);
  io.out(`\nYou might have expected access to ${workspace} as per your ${source}.\n` +
    `But ${user} has no access to this workspace, or it simply doesn't exist on this hub.\n` +
    `Ask a workspace admin to grant you access: \`ub workspace member add ${user}\`\n`);
  return false;
}

function status(selection: Selection, io: Io): number {
  const stored = readHubLogins();
  const login = stored.logins[selection.origin];
  if (login === undefined) {
    const reason = stored.state === "refused" ? "stored login refused"
      : stored.state === "unreadable" || stored.unreadableHubs.includes(selection.origin) ? "stored login unreadable" : "no login stored";
    io.err(`ub auth: ${reason} for ${selection.origin}. ${stored.diagnostic ?? ""} Run \`ub auth login ${selection.origin}\`.\n`);
    return 1;
  }
  authField(io, "signed in", displayUsername(login.identity.githubUsername));
  describeWorkspaces(login, io);
  if (login.credential.record.revokedAt !== null) {
    io.err(`ub auth: this stored credential is recorded as revoked. Run \`ub auth login ${selection.origin}\`.\n`);
    return 1;
  }
  return describeMissingWorkspace(selection, login, io) ? 1 : 0;
}

class DeviceFailure extends Error {}

type DeviceAction = { operation: "list-devices" } | { operation: "revoke-device"; deviceId: string };

async function deviceRequest(origin: string, action: DeviceAction, login: StoredHubLogin, io: Io) {
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
    authField(io, "revoked", `${confirmed} devices of ${isGithubUsername(user) ? user : JSON.stringify(user)} on ${origin}, including this computer`);
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

/** Every byte and every network wait is bounded, including a stalled JSON body. */
async function post(
  origin: string, route: "start" | "collect" | "cancel", body: object,
  signal: AbortSignal, timeoutMs: number,
  received?: (result: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
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

async function login(selection: Selection, io: Io): Promise<number> {
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
    const unclaimed = await isUnclaimed(selection.origin, interrupted.signal);
    if (interrupted.signal.aborted) throw new SignInFailure("GitHub sign-in interrupted");
    // A start interrupted before its reply has no collection secret to cancel
    // with. Finish this bounded read so a late reply can still be abandoned.
    const started = await post(selection.origin, "start", {}, new AbortController().signal, REQUEST_MS, (result) => {
      // Valid authority permits cleanup even if the envelope or public fields
      // are malformed. Never display any of the private start fields.
      if (typeof result.requestId === "string" && UUID.test(result.requestId) &&
          typeof result.collectionSecret === "string" && /^[A-Za-z0-9_-]{43}$/.test(result.collectionSecret)) {
        attempt = { requestId: result.requestId, collectionSecret: result.collectionSecret };
      }
    });
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

export async function authCommand(argv: string[], io: Io): Promise<number> {
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
  try {
    const parsed = parseArgs({ args, options: sub === "logout" ? AUTH_LOGOUT_OPTIONS : {}, allowPositionals: true });
    if (parsed.positionals.length > 1) throw new Error();
    hub = parsed.positionals[0];
    allDevices = "all-devices" in parsed.values && parsed.values["all-devices"] === true;
  } catch {
    io.err(`ub auth ${sub}: expected at most one hub\n\n${help}`);
    return 2;
  }
  const selection = selectHub(hub, io, sub !== "logout");
  if (typeof selection === "number") return selection;
  if (sub === "login") return await login(selection, io);
  if (sub === "status") return status(selection, io);
  return await logout(selection, io, allDevices);
}
