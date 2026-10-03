/**
 * GitHub App device flow, driven and collected by the requesting device.
 * Only the hub sees GitHub's device code or tokens. No background poll issues
 * a credential for an abandoned request, and no key is retained in this map.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CredentialRecord, CredentialRegistry } from "./credentials.js";
import { type HubLogger, stderrLogger } from "./log.js";
import type { MembershipRegistry } from "./memberships.js";
import type { PrincipalRecord, PrincipalRegistry } from "./principals.js";

export interface GithubSignInConfig {
  clientId: string;
  /** Test seams; production always uses the fixed github.com endpoints. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

const MAX_LIFETIME_MS = 15 * 60_000;
const MAX_REQUESTS = 100;
const MAX_TERMINAL_REQUESTS = 100;
type TerminalStatus = "denied" | "expired" | "abandoned" | "failed" | "collected";
interface SignInRequest {
  secret: string;
  deviceCode?: string;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
  polling: boolean;
  status: "pending" | TerminalStatus;
}

export type SignInCollection =
  | { status: "pending"; interval: number }
  | { status: TerminalStatus | "unknown-request" }
  | { status: "complete"; identity: PrincipalRecord; credential: { record: CredentialRecord; key: string } };

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}

function seconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error();
  return value;
}

/** Only fixed codes and HTTP status may cross the upstream logging boundary. */
class GithubFailure extends Error {
  constructor(
    readonly code: "http-error" | "device_flow_disabled" | "incorrect_client_credentials" | "provider-error",
    readonly status?: number,
  ) { super(); }
}

function providerFailure(error: unknown): GithubFailure {
  const code = error === "device_flow_disabled" || error === "incorrect_client_credentials"
    ? error : "provider-error";
  return new GithubFailure(code);
}

export class GithubSignIn {
  private readonly requests = new Map<string, SignInRequest>();
  private readonly closed = new AbortController();
  private starting = 0;
  private readonly now: () => number;
  private readonly fetch: typeof globalThis.fetch;

  constructor(
    private readonly config: GithubSignInConfig,
    private readonly principals: PrincipalRegistry,
    private readonly credentials: CredentialRegistry,
    private readonly memberships: MembershipRegistry,
    private readonly log: HubLogger = stderrLogger,
  ) {
    this.now = config.now ?? Date.now;
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  stop(): void {
    this.closed.abort();
    this.requests.clear();
  }

  async start() {
    if (this.closed.signal.aborted) return { status: "failed" } as const;
    // Active requests and retained outcomes have separate bounds. Outcomes
    // last at most another lifetime; oldest ones may be evicted at capacity.
    // There is no durable request/token record, and restart refuses requests.
    let pending = 0;
    let terminal = 0;
    for (const [id, request] of this.requests) {
      if (this.now() >= request.expiresAt + MAX_LIFETIME_MS) this.requests.delete(id);
      else if (this.active(request)) pending++;
      else terminal++;
    }
    for (const [id, request] of this.requests) {
      if (terminal <= MAX_TERMINAL_REQUESTS) break;
      if (request.status !== "pending") {
        this.requests.delete(id);
        terminal--;
      }
    }
    if (pending + this.starting >= MAX_REQUESTS) return { status: "busy" } as const;
    this.starting++;
    const startedAt = this.now();
    try {
      const result = await this.github("https://github.com/login/device/code", {
        method: "POST",
        body: new URLSearchParams({ client_id: this.config.clientId }),
      });
      if (this.closed.signal.aborted) throw new Error();
      if (result.error !== undefined) throw providerFailure(result.error);
      const expiresAt = startedAt + Math.min(seconds(result.expires_in) * 1000, MAX_LIFETIME_MS);
      const intervalMs = seconds(result.interval) * 1000;
      if (expiresAt <= this.now() || intervalMs > MAX_LIFETIME_MS ||
          typeof result.device_code !== "string" || result.device_code.length < 1 || result.device_code.length > 256 ||
          typeof result.user_code !== "string" || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(result.user_code) ||
          result.verification_uri !== "https://github.com/login/device") throw new Error();
      const requestId = crypto.randomUUID();
      const collectionSecret = randomBytes(32).toString("base64url");
      this.requests.set(requestId, {
        secret: collectionSecret, deviceCode: result.device_code, expiresAt,
        intervalMs, nextPollAt: this.now() + intervalMs, polling: false, status: "pending",
      });
      return {
        status: "pending", requestId, collectionSecret,
        verificationUri: result.verification_uri, userCode: result.user_code,
        expiresIn: Math.floor((expiresAt - this.now()) / 1000), interval: intervalMs / 1000,
      } as const;
    } catch (error) {
      // Never expose/log upstream bodies or exceptions: they can carry tokens.
      if (!this.closed.signal.aborted) this.logFailure("start", error);
      return { status: "failed" } as const;
    } finally {
      this.starting--;
    }
  }

  cancel(requestId: string, secret: string): SignInCollection {
    const request = this.lookup(requestId, secret);
    if (request === undefined) return { status: "unknown-request" };
    if (this.active(request)) this.finish(request, "abandoned");
    return { status: request.status as TerminalStatus };
  }

  async collect(requestId: string, secret: string): Promise<SignInCollection> {
    const request = this.lookup(requestId, secret);
    if (request === undefined) return { status: "unknown-request" };
    if (!this.active(request)) return { status: request.status as TerminalStatus };
    if (request.polling || this.now() < request.nextPollAt) return this.pending(request);
    request.polling = true;
    request.nextPollAt = this.now() + request.intervalMs;
    let step = "token";
    try {
      if (request.deviceCode === undefined) throw new Error();
      const result = await this.github("https://github.com/login/oauth/access_token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: this.config.clientId, device_code: request.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      if (!this.active(request)) return { status: request.status as TerminalStatus };
      if (result.error === "authorization_pending") return this.pending(request);
      if (result.error === "slow_down") {
        request.intervalMs = Math.max(request.intervalMs + 5000,
          typeof result.interval === "number" ? seconds(result.interval) * 1000 : 0);
        request.nextPollAt = this.now() + request.intervalMs;
        return this.pending(request);
      }
      if (result.error !== undefined) {
        const status = result.error === "access_denied" ? "denied"
          : result.error === "expired_token" ? "expired" : "failed";
        if (status === "failed") throw providerFailure(result.error);
        this.finish(request, status);
        return { status };
      }
      if (typeof result.access_token !== "string" || result.access_token.length < 1 ||
          result.token_type !== "bearer" || result.scope !== "") throw new Error();
      // Only /user's numeric durable ID and current login are read. Neither
      // access_token nor refresh_token is copied into any retained state.
      step = "identity";
      const identity = await this.github("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${result.access_token}` },
      });
      if (!this.active(request)) return { status: request.status as TerminalStatus };
      if (typeof identity.id !== "number" || !Number.isSafeInteger(identity.id) || identity.id < 1 ||
          typeof identity.login !== "string") throw new Error();
      step = "issuance";
      const principal = this.principals.identify(String(identity.id), identity.login);
      const issued = this.credentials.issue({
        principalId: principal.id, deviceId: crypto.randomUUID(),
        workspaces: this.memberships.workspacesFor(principal.id),
      });
      // Synchronous issuance and consumption: another collection cannot issue
      // or return a second key, including while token/identity reads yielded.
      this.finish(request, "collected");
      return {
        status: "complete", identity: principal,
        credential: { record: issued.record, key: Buffer.from(issued.keyBytes).toString("base64url") },
      };
    } catch (error) {
      if (this.active(request)) {
        this.logFailure(step, error);
        this.finish(request, "failed");
      }
      return { status: request.status as TerminalStatus };
    } finally {
      request.polling = false;
    }
  }

  private logFailure(step: string, error: unknown): void {
    this.log({
      event: "hub.github.sign-in.failed", step,
      code: error instanceof GithubFailure ? error.code : "request-failed",
      ...(error instanceof GithubFailure && error.status !== undefined ? { status: error.status } : {}),
    });
  }

  private lookup(id: string, secret: string): SignInRequest | undefined {
    const request = this.requests.get(id);
    if (request === undefined || typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
        !timingSafeEqual(Buffer.from(secret), Buffer.from(request.secret))) return undefined;
    return request;
  }

  private active(request: SignInRequest): boolean {
    if (request.status === "pending" && this.closed.signal.aborted) this.finish(request, "failed");
    if (request.status === "pending" && this.now() >= request.expiresAt) this.finish(request, "expired");
    return request.status === "pending";
  }

  private finish(request: SignInRequest, status: TerminalStatus): void {
    request.status = status;
    delete request.deviceCode;
  }

  private pending(request: SignInRequest): SignInCollection {
    return { status: "pending", interval: Math.max(1, Math.ceil((request.nextPollAt - this.now()) / 1000)) };
  }

  private async github(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.fetch(url, {
      ...init, redirect: "error",
      signal: AbortSignal.any([this.closed.signal, AbortSignal.timeout(10_000)]),
      headers: { Accept: "application/json", "User-Agent": "Uberblick-Hub", "X-GitHub-Api-Version": "2026-03-10", ...init.headers },
    });
    if (!response.ok) throw new GithubFailure("http-error", response.status);
    // Even a successful provider response is bounded before parsing. Only a
    // public identity or a small OAuth result is needed, never a large payload.
    if (response.body === null) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 65_536) throw new Error();
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }
}

/** HTTP bodies carry secrets; URLs, logs and browser configuration never do. */
export async function handleGithubSignIn(
  signIn: GithubSignIn | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const path = request.url ?? "";
  if (!path.startsWith("/auth/")) return false;
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  };
  if (!["/auth/github/start", "/auth/github/collect", "/auth/github/cancel"].includes(path)) {
    reply(404, { status: "unknown-request" });
    return true;
  }
  if (signIn === undefined) {
    reply(503, { status: "not-configured" });
    return true;
  }
  if (request.method !== "POST" || request.headers.authorization !== undefined ||
      request.headers["content-type"]?.split(";")[0] !== "application/json") {
    reply(400, { status: "invalid-request" });
    return true;
  }
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > 4096) throw new Error();
      chunks.push(bytes);
    }
    const body = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (path === "/auth/github/start") {
      if (Object.keys(body).length !== 0) throw new Error();
      const result = await signIn.start();
      reply(result.status === "failed" ? 502 : result.status === "busy" ? 429 : 200, result);
    } else {
      if (Object.keys(body).length !== 2 || typeof body.requestId !== "string" ||
          typeof body.collectionSecret !== "string") throw new Error();
      const result = path.endsWith("/cancel")
        ? signIn.cancel(body.requestId, body.collectionSecret)
        : await signIn.collect(body.requestId, body.collectionSecret);
      reply(result.status === "unknown-request" ? 404 : 200, result);
    }
  } catch {
    reply(400, { status: "invalid-request" });
  }
  return true;
}
