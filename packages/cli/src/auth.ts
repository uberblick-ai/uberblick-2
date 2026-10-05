/** Remote sign-in stores a device credential; live sync still uses its existing auth. */
import { setTimeout as delay } from "node:timers/promises";
import { parseWorkspaceId } from "@uberblick/schema";
import {
  type StoredHubLogin,
  isHubLogin,
  preflightHubLoginStore,
  readHubLogins,
  removeHubLogin,
  writeHubLogin,
} from "./auth-store.js";
import { budget } from "./budget.js";
import { resolveProjectBinding } from "./project-binding.js";
import { openBrowser } from "./browser.js";
import type { Io } from "./io.js";
import { authenticationOrigin } from "@uberblick/hub/remote-url";
export { authenticationOrigin } from "@uberblick/hub/remote-url";

export const AUTH_HELP = `usage: ub auth <command>

commands:
  login [hub]            sign in to a remote hub with GitHub
  status [hub]           show this machine's stored login
  logout [hub]           remove this machine's stored login

options:
  -h, --help             show this help; after a command, that command's help
`;

export const AUTH_LOGIN_HELP = `usage: ub auth login [hub]

Sign in to the given hub, or the hub selected by this project's binding.
The hub can be a bare host, an http(s) address or a ws(s) endpoint.
Approve the displayed GitHub URL and code in a browser on any machine;
this command completes automatically and never asks for keyboard input.
In a local terminal, the approval page opens automatically after the guidance.
Over SSH or when stdout is not a terminal, only the URL and code are displayed.
BROWSER names the opener command; BROWSER=none skips automatic opening.
GitHub's approval page shows the app's name, not the hub. Approve only a
login you started for the displayed hub; the app does not vouch for it.
Store the issued device credential privately on this machine for remote sync. A replacement does not revoke the previous device.
Local-only work needs no login. The machine's binding stays unchanged.
On a fresh, unclaimed hub, the first GitHub account to complete approval
claims its default workspace as administrator. Claiming is one-time; this
command reports whether this login claimed it and the workspace UUID.

options:
  -h, --help             show this help
`;

export const AUTH_STATUS_HELP = `usage: ub auth status [hub]

Show the locally recorded GitHub identity and credential workspace limits
for the given hub, or the hub selected by this project's binding.
The hub can be a bare host, an http(s) address or a ws(s) endpoint.
No network is used; this cannot establish whether the hub accepts the device.
Other stored hubs are named too. The machine's binding stays unchanged.

options:
  -h, --help             show this help
`;

export const AUTH_LOGOUT_HELP = `usage: ub auth logout [hub]

Remove this machine's login for the given hub, or the hub selected by the project binding.
The hub can be a bare host, an http(s) address or a ws(s) endpoint.
No network is used. The device keeps hub access until revoked through device
management; logout never revokes it. The machine's binding stays unchanged.

options:
  -h, --help             show this help
`;

interface Selection {
  origin: string;
  bound: boolean;
  workspace: string | undefined;
}

const GITHUB_APPROVAL_URL = "https://github.com/login/device";

function selectHub(hub: string | undefined, io: Io): Selection | number {
  // An explicit authentication target works before any project is bound.
  // Resolve a binding only for the implicit target, or to describe membership.
  let binding: ReturnType<typeof resolveProjectBinding>["binding"] = null;
  try {
    binding = resolveProjectBinding().binding;
  } catch (error) {
    if (hub === undefined) {
      io.err(`ub auth: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
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
  io.out(`Hub: ${origin}\n`);
  let bound = false;
  if (binding?.hubUrl != null) {
    try { bound = authenticationOrigin(binding.hubUrl) === origin; } catch { /* Invalid binding is never rewritten. */ }
  }
  if (!bound) io.out("This project's hub and workspace binding is unchanged.\n");
  return { origin, bound, workspace: binding?.workspaceId };
}

function describeLogin(login: StoredHubLogin, io: Io): void {
  // A hub-supplied username is display data, so control characters stay quoted.
  io.out(`GitHub username recorded at sign-in: ${JSON.stringify(login.identity.githubUsername)}\n`);
  const workspaces = login.credential.record.workspaces;
  io.out(workspaces.length === 0
    ? "Credential covers no workspaces. Sign-in grants no membership.\n"
    : `Credential covers workspaces: ${workspaces.join(", ")}\n`);
}

function describeMissingWorkspace(selection: Selection, login: StoredHubLogin, io: Io): boolean {
  if (!selection.bound || selection.workspace === undefined) return false;
  let workspace: string;
  try { workspace = parseWorkspaceId(selection.workspace).uuid; } catch {
    io.err("ub auth: the bound workspace is invalid; fix workspaceId in the project binding.\n");
    return true;
  }
  if (login.credential.record.workspaces.includes(workspace)) return false;
  io.out(`The bound workspace ${workspace} is absent from the recorded credential. Remote sync renews this login to discover current memberships; ask a workspace administrator for access if it remains unavailable.\n`);
  return false;
}

function status(selection: Selection, io: Io): number {
  const stored = readHubLogins();
  const others = Object.keys(stored.logins).filter(origin => origin !== selection.origin).sort();
  if (others.length > 0) io.out(`Other hubs with a stored login: ${others.join(", ")}\n`);
  io.out("Local state only; the hub's acceptance of this credential has not been checked.\n");
  const login = stored.logins[selection.origin];
  if (login === undefined) {
    const reason = stored.state === "refused" ? "stored login refused"
      : stored.state === "unreadable" || stored.unreadableHubs.includes(selection.origin) ? "stored login unreadable" : "no login stored";
    io.err(`ub auth: ${reason} for ${selection.origin}. ${stored.diagnostic ?? ""} Run \`ub auth login ${selection.origin}\`.\n`);
    return 1;
  }
  describeLogin(login, io);
  if (login.credential.record.revokedAt !== null) {
    io.err(`ub auth: this stored credential is recorded as revoked. Run \`ub auth login ${selection.origin}\`.\n`);
    return 1;
  }
  return describeMissingWorkspace(selection, login, io) ? 1 : 0;
}

async function logout(selection: Selection, io: Io): Promise<number> {
  try {
    const removed = await removeHubLogin(selection.origin);
    io.out(removed ? "Removed this machine's stored login.\n" : "No login stored for this hub.\n");
    io.out("The device keeps its hub access until revoked through device management. Logout revokes nothing.\n");
    return 0;
  } catch (error) {
    io.err(`ub auth: ${error instanceof Error ? error.message : "could not remove the stored login"}\n`);
    return 1;
  }
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
    if (unclaimed) io.out("This hub is unclaimed. The first GitHub account to complete approval becomes administrator of its default workspace.\n");
    io.out(`GitHub sign-in for ${selection.origin}\nApprove in a browser: ${started.verificationUri}\nCode: ${started.userCode}\n`);
    io.out(`GitHub's approval page shows the app's name, not the hub.\nApprove only if you started this login for ${selection.origin}; the app does not vouch for this hub.\nWaiting for GitHub approval…\n`);
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
      const credential = { identity: result.identity, credential: result.credential };
      if (!isHubLogin(credential) || credential.identity.githubUsername.includes(attempt.collectionSecret)) {
        throw new SignInFailure("the hub returned an invalid sign-in credential; run login again");
      }
      if (Object.hasOwn(result, "claimedWorkspaceId")) {
        if (typeof result.claimedWorkspaceId !== "string" || !UUID.test(result.claimedWorkspaceId) ||
            !credential.credential.record.workspaces.includes(result.claimedWorkspaceId)) {
          throw new SignInFailure("the hub returned an invalid sign-in claim result; run login again");
        }
        io.out(`This login claimed the hub. Default workspace: ${result.claimedWorkspaceId}\n`);
      }
      if (interrupted.signal.aborted) throw new SignInFailure("GitHub sign-in interrupted");
      let replaced: boolean;
      try { replaced = await writeHubLogin(selection.origin, credential, process.env, interrupted.signal); } catch (error) {
        if (interrupted.signal.aborted) throw new SignInFailure("GitHub sign-in interrupted");
        io.err(`ub auth: could not store login for ${selection.origin}: ${error instanceof Error ? error.message : "credential store write failed"}. The issued device remains on the hub; revoke it through device management if needed.\n`);
        return 1;
      }
      stored = true;
      io.out(`Stored login for ${selection.origin}.\n`);
      describeLogin(credential, io);
      if (replaced) io.out("The replaced device keeps its hub access until it is revoked through device management.\n");
      io.out("Remote sync uses this stored login. Run `ub open` to edit in this computer’s browser.\n");
      return 0;
    }
  } catch (error) {
    const message = interrupted.signal.aborted ? "GitHub sign-in interrupted"
      : deadline !== undefined && performance.now() >= deadline ? "GitHub sign-in expired; run login again"
      : error instanceof SignInFailure ? error.message : "the hub is unreachable or the sign-in request timed out";
    io.err(`ub auth: ${selection.origin}: ${message}.\n`);
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
  if (args.length > 1 || args.some(arg => arg.startsWith("-"))) {
    io.err(`ub auth ${sub}: expected at most one hub\n\n${help}`);
    return 2;
  }
  const selection = selectHub(args[0], io);
  if (typeof selection === "number") return selection;
  if (sub === "login") return await login(selection, io);
  if (sub === "status") return status(selection, io);
  return await logout(selection, io);
}
