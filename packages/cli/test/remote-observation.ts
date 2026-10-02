/** Read-only preflight instrumentation for observe-remote-join.ts. */
import { channel } from "node:diagnostics_channel";
import { type McpConfig, inspectRemote } from "@uberblick/mcp-server";

export type Stage = "name-resolution" | "tcp" | "tls" | "websocket-upgrade" |
  "hub-authentication" | "directory-settle" | "unattributable";

interface Event {
  ms: number;
  kind: string;
  dial?: number;
  code?: number | string;
  stage?: Stage;
  local?: boolean;
}

// Only locally defined codes reach the record. Error messages, close reasons,
// headers and payloads can contain credentials (even echoed by a remote).
const ERROR_STAGES: Record<string, Stage> = {
  ENOTFOUND: "name-resolution",
  EAI_AGAIN: "name-resolution",
  ECONNREFUSED: "tcp",
  ENETUNREACH: "tcp",
  EHOSTUNREACH: "tcp",
  CERT_HAS_EXPIRED: "tls",
  CERT_NOT_YET_VALID: "tls",
  DEPTH_ZERO_SELF_SIGNED_CERT: "tls",
  SELF_SIGNED_CERT_IN_CHAIN: "tls",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls",
  ERR_TLS_CERT_ALTNAME_INVALID: "tls",
  ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE: "tls",
  "ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE": "tls",
};

function errorCodes(error: unknown): string[] {
  if (typeof error !== "object" || error === null) return [];
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown[] };
  return [
    ...(typeof value.code === "string" && Object.hasOwn(ERROR_STAGES, value.code)
      ? [value.code] : []),
    ...errorCodes(value.cause),
    ...(Array.isArray(value.errors) ? value.errors.flatMap(errorCodes) : []),
  ];
}

/**
 * One inspectRemote, with its own socket reconnects, never the CLI's extra
 * preflight. Run serially in a dedicated process: the WebSocket constructor
 * and diagnostics subscriptions are process-wide and restored on exit.
 */
export async function observePreflight(config: McpConfig) {
  const start = performance.now();
  const events: Event[] = [];
  const record = (event: Omit<Event, "ms">) => {
    events.push({ ms: Math.round(performance.now() - start), ...event });
  };
  const NativeWebSocket = globalThis.WebSocket;
  const sockets: WebSocket[] = [];
  const closed: Promise<void>[] = [];
  let observing = true;
  class ObservedWebSocket extends NativeWebSocket {
    private localClose = false;
    constructor(...args: ConstructorParameters<typeof NativeWebSocket>) {
      super(...args);
      const dial = sockets.push(this);
      record({ kind: "dial", dial });
      this.addEventListener("open", () => record({ kind: "websocket-open", dial }));
      this.addEventListener("error", (event) => {
        const codes = errorCodes(event.error);
        if (codes.length === 0) {
          record({ kind: "websocket-error", dial, stage: "unattributable" });
        }
        for (const code of new Set(codes)) {
          record({ kind: "websocket-error", dial, code, stage: ERROR_STAGES[code] ?? "unattributable" });
        }
      });
      closed.push(new Promise<void>((resolve) => {
        this.addEventListener("close", (event) => {
          record({
            kind: "websocket-close", dial, code: event.code, local: this.localClose,
            ...(!this.localClose ? { stage: "unattributable" as const } : {}),
          });
          resolve();
        }, { once: true });
      }));
    }
    override close(code?: number, reason?: string): void {
      this.localClose = true;
      super.close(code, reason);
    }
  }
  // Diagnostics are attempt-level evidence: connection events do not expose a
  // WebSocket identity, so do not guess which raw dial produced them.
  const subscriptions = [
    ["undici:client:beforeConnect", () => record({ kind: "connect-start" })],
    ["undici:client:connected", () => record({ kind: "transport-connected" })],
    ["undici:client:sendHeaders", () => record({ kind: "upgrade-request-sent" })],
    ["undici:client:connectError", (message: unknown) => {
      const codes = errorCodes((message as { error?: unknown }).error);
      if (codes.length === 0) record({ kind: "connect-error", stage: "unattributable" });
      for (const code of new Set(codes)) {
        record({ kind: "connect-error", code, stage: ERROR_STAGES[code] ?? "unattributable" });
      }
    }],
    ["undici:request:headers", (message: unknown) => {
      const status = (message as { response?: { statusCode?: unknown } }).response?.statusCode;
      if (typeof status === "number") record({ kind: "http-response", code: status });
    }],
  ] as const;
  const listeners = subscriptions.map(([name, listener]) => {
    const guarded = (message: unknown) => { if (observing) listener(message); };
    channel(name).subscribe(guarded);
    return { name, guarded };
  });
  globalThis.WebSocket = ObservedWebSocket;
  try {
    const result = await inspectRemote(config, { silent: true });
    const elapsedMs = Math.round(performance.now() - start);
    // Snapshot before asynchronous teardown events, which are cleanup rather
    // than failure evidence. A close requested locally is labelled above.
    const evidence = [...events];
    let stage: Stage | null = null;
    if (!result.complete) {
      stage = "unattributable";
      if (result.hub.status === "auth-failed" || result.hub.status === "update-required") {
        stage = "hub-authentication";
      } else if (!evidence.some(event => event.kind === "websocket-open")) {
        const errors = evidence.filter(event => event.kind === "connect-error");
        const stages = new Set(errors.map(event => event.stage));
        const starts = evidence.filter(event => event.kind === "connect-start").length;
        const connected = evidence.filter(event => event.kind === "transport-connected").length;
        if (stages.size === 1 && !evidence.some(event => event.kind === "transport-connected")) {
          stage = errors[0]?.stage ?? "unattributable";
        } else if (starts > 0 && connected === starts &&
          evidence.some(event => event.kind === "upgrade-request-sent") &&
          !evidence.some(event => event.kind === "connect-error")) {
          // An earlier connection cannot place a later, still pending connect
          // in the upgrade stage. These milestones have no dial identity.
          stage = "websocket-upgrade";
        }
      }
      // An open socket alone cannot distinguish pending authentication from
      // directory settle. Preserve that uncertainty rather than inventing it.
    }
    return {
      elapsedMs, status: result.hub.status, complete: result.complete,
      stage, dials: sockets.length, events: evidence,
    };
  } finally {
    observing = false;
    globalThis.WebSocket = NativeWebSocket;
    for (const { name, guarded } of listeners) channel(name).unsubscribe(guarded);
    for (const socket of sockets) {
      if (socket.readyState !== socket.CLOSED && socket.readyState !== socket.CLOSING) socket.close();
    }
    // inspectRemote destroys its provider. Drain native close events before
    // another attempt subscribes, with a finite cleanup budget.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(closed),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); }),
    ]);
    clearTimeout(timer);
  }
}
