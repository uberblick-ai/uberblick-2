/** Observe this client's socket without rendering text supplied by a peer. */
import { AsyncLocalStorage } from "node:async_hooks";
import { subscribe } from "node:diagnostics_channel";
import { isIP } from "node:net";
import { CERTIFICATE_CODES, type HubFailureCause } from "./hub-failure.js";

interface Failure {
  cause: HubFailureCause;
  detail: string;
}

interface Attempt {
  host: string;
  port: number;
  endpoint: string;
  pending: boolean;
  opened: boolean;
  startedAt: number;
  failure: Failure | undefined;
}

// The dispatcher handler is Node's own WebSocket handler. Forward all its
// hooks; only observe the error and the status, without replacing its behavior.
interface Handler {
  onResponseError?: (controller: unknown, error: unknown) => void;
  onResponseStart?: (controller: unknown, status: number, ...rest: unknown[]) => void;
}
interface Dispatcher {
  dispatch(options: unknown, handler: Handler): boolean;
}

const dispatchAttempt = new AsyncLocalStorage<{ attempt: Attempt; active: boolean }>();
const requests = new WeakMap<object, Attempt>();
subscribe("undici:request:create", (message) => {
  const context = dispatchAttempt.getStore();
  const { request } = message as { request: object };
  if (context?.active) requests.set(request, context.attempt);
});
subscribe("undici:client:sendHeaders", (message) => {
  const { request, socket } = message as {
    request: object;
    socket: { remoteAddress?: string; remotePort?: number };
  };
  const attempt = requests.get(request);
  if (attempt && socket.remoteAddress && isIP(socket.remoteAddress) && socket.remotePort === attempt.port) {
    attempt.endpoint = endpoint(socket.remoteAddress, attempt.port);
  }
});

function endpoint(address: string, port: number): string {
  return `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function errorFailure(error: unknown, attempt: Attempt, timeoutMs: number): Failure | undefined {
  const fields = record(error);
  // Node's multiple-address connector puts the actual refused endpoints in
  // errors[], not on the AggregateError. Report a classified dial from it.
  if (Array.isArray(fields.errors)) {
    for (const nested of fields.errors) {
      const failure = errorFailure(nested, attempt, timeoutMs);
      if (failure) return failure;
    }
  }
  const code = fields.code;
  if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(code)) return undefined;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || fields.syscall === "getaddrinfo") {
    return { cause: "dns", detail: `${code} ${attempt.host}` };
  }
  const address = typeof fields.address === "string" && isIP(fields.address) ? fields.address : undefined;
  const target = address ? endpoint(address, attempt.port) : attempt.endpoint;
  if (code === "ECONNREFUSED" && address) {
    return { cause: "refused", detail: `${code} ${target}` };
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
    return { cause: "timeout", detail: `${timeoutMs / 1000} ${target} ${code}` };
  }
  if (code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") || CERTIFICATE_CODES.has(code)) {
    return { cause: "tls", detail: `${code} ${attempt.host}` };
  }
  return undefined;
}

export class HubConnection {
  private current: Attempt | undefined;
  private latest: Failure | undefined;

  constructor(private readonly timeoutMs: number) {}

  /** A fresh observer for each native WebSocket, including provider retries. */
  websocket() {
    const observer = this;
    // Access initializes Node's lazy undici global dispatcher. No global
    // dispatcher is replaced; fetches and other replicas keep their own paths.
    const NativeWebSocket = WebSocket;
    const globals = globalThis as unknown as Record<symbol, Dispatcher>;
    const nativeDispatcher = globals[Symbol.for("undici.globalDispatcher.2")] ?? globals[Symbol.for("undici.globalDispatcher.1")];
    if (nativeDispatcher === undefined) return NativeWebSocket;
    const dispatcher: Dispatcher = nativeDispatcher;
    const NodeWebSocket = NativeWebSocket as unknown as {
      new(url: string, init: { dispatcher: Dispatcher }): WebSocket;
    };
    return class extends NodeWebSocket {
      constructor(url: string) {
        const target = new URL(url);
        const host = target.hostname;
        const port = Number(target.port || (target.protocol === "wss:" ? 443 : 80));
        const attempt: Attempt = { host, port, endpoint: `${host}:${port}`, pending: true, opened: false, startedAt: Date.now(), failure: undefined };
        observer.current = attempt;
        super(url, { dispatcher: {
          dispatch(options, handler) {
            const observed: Handler = {
              ...handler,
              onResponseError(controller, error) {
                // A refused HTTP upgrade is aborted by the native handler;
                // that secondary error must not erase the observed status.
                if (attempt.failure?.cause !== "http") {
                  attempt.failure = errorFailure(error, attempt, observer.timeoutMs);
                }
                attempt.pending = false;
                if (observer.current === attempt) observer.latest = attempt.failure;
                handler.onResponseError?.call(this, controller, error);
              },
              onResponseStart(controller, status, ...rest) {
                if (Number.isInteger(status) && status >= 200 && status <= 599 && status !== 101) {
                  attempt.failure = { cause: "http", detail: `${status} ${host}` };
                }
                handler.onResponseStart?.call(this, controller, status, ...rest);
              },
            };
            const context = { attempt, active: true };
            return dispatchAttempt.run(context, () => {
              // Request construction is synchronous in dispatch. Async work
              // inherits ALS, but must not attribute a later fetch to us.
              try {
                return dispatcher.dispatch(options, observed);
              } finally {
                context.active = false;
              }
            });
          },
        } });
        this.addEventListener("open", () => {
          attempt.opened = true;
          attempt.pending = false;
          attempt.failure = undefined;
          if (observer.current === attempt) observer.latest = undefined;
        });
        this.addEventListener("close", (event) => {
          attempt.pending = false;
          if (attempt.opened) attempt.failure = undefined;
          // These reserved codes are synthesized, never sent in a close frame.
          if (event.code !== 1006 && event.code !== 1005 && event.code !== 1015 && Number.isInteger(event.code)) {
            attempt.failure = { cause: "closed", detail: String(event.code) };
          }
          if (observer.current === attempt) observer.latest = attempt.failure;
        });
      }
    };
  }

  failure(connectGraceExpired: boolean): Failure | undefined {
    const attempt = this.current;
    if (!attempt || attempt.opened) return this.latest;
    // A new retry does not become a timeout just because the overall connect
    // grace already expired. It must itself have spent that long pending.
    if (attempt.pending && connectGraceExpired && Date.now() - attempt.startedAt >= this.timeoutMs) {
      return { cause: "timeout", detail: `${this.timeoutMs / 1000} ${attempt.endpoint}` };
    }
    return this.latest;
  }
}
