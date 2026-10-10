/** Bounded GitHub device approval, shared by sign-in and host-only setup.
 * Requests/tokens stay in memory; the caller owns the synchronous completion.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { type HubLogger, stderrLogger } from "./log.js";

export interface GithubSignInConfig {
  clientId: string;
  /** Test seams; production always uses the fixed github.com endpoints. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Host setup's real wait between polls; GitHub's interval when absent. */
  setupPollMs?: number;
}

const MAX_LIFETIME_MS = 15 * 60_000;
const MAX_REQUESTS = 100;
const MAX_TERMINAL_REQUESTS = 100;
type TerminalStatus = "denied" | "expired" | "abandoned" | "failed" | "collected";
interface SignInRequest {
  secret: string;
  deviceCode?: string;
  deviceName?: string;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
  polling: boolean;
  status: "pending" | TerminalStatus;
}

export type DeviceFlowCollection<Result extends object> =
  | { status: "pending"; interval: number }
  | { status: TerminalStatus | "unknown-request" }
  | ({ status: "complete" } & Result);

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

export class GithubDeviceFlow<Result extends object> {
  private readonly requests = new Map<string, SignInRequest>();
  private readonly closed = new AbortController();
  private starting = 0;
  private readonly now: () => number;
  private readonly fetch: typeof globalThis.fetch;

  constructor(
    private readonly config: GithubSignInConfig,
    private readonly complete: (identity: { accountId: string; username: string }, deviceName?: string) => Result,
    private readonly log: HubLogger = stderrLogger,
    private readonly event = "hub.github.sign-in.failed",
  ) {
    this.now = config.now ?? Date.now;
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  stop(): void {
    this.closed.abort();
    this.requests.clear();
  }

  async start(deviceName?: string) {
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
        ...(deviceName === undefined ? {} : { deviceName }),
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

  cancel(requestId: string, secret: string): DeviceFlowCollection<Result> {
    const request = this.lookup(requestId, secret);
    if (request === undefined) return { status: "unknown-request" };
    if (this.active(request)) this.finish(request, "abandoned");
    return { status: request.status as TerminalStatus };
  }

  async collect(requestId: string, secret: string): Promise<DeviceFlowCollection<Result>> {
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
      const completed = this.complete({ accountId: String(identity.id), username: identity.login }, request.deviceName);
      // Completion is synchronous: cancellation/expiry cannot interleave with
      // the commit, and another collector cannot complete a second time.
      this.finish(request, "collected");
      return { status: "complete", ...completed };
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
      event: this.event, step,
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
    delete request.deviceName;
  }

  private pending(request: SignInRequest): DeviceFlowCollection<Result> {
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
