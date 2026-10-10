/** Native socket failures retain safe codes and endpoints, never peer text. */
import { channel } from "node:diagnostics_channel";
import { afterEach, expect, it, vi } from "vitest";
import { HubConnection } from "../src/hub-connection.js";
import { formatHubFailure } from "../src/hub-failure.js";

interface NativeHandler {
  onResponseError(controller: unknown, error: unknown): void;
}
interface TestDispatcher {
  dispatch(options: unknown, handler: NativeHandler): boolean;
}

// The override belongs only to this isolated test worker and is always restored.
const NativeWebSocket = WebSocket;
const globals = globalThis as unknown as Record<symbol, unknown>;
const dispatcherSymbol = globals[Symbol.for("undici.globalDispatcher.2")]
  ? Symbol.for("undici.globalDispatcher.2")
  : Symbol.for("undici.globalDispatcher.1");
const originalDispatcher = globals[dispatcherSymbol];
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  globals[dispatcherSymbol] = originalDispatcher;
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function dial(dispatcher: TestDispatcher, url = "wss://hub.example") {
  let nativeHandler: NativeHandler | undefined;
  globals[dispatcherSymbol] = {
    dispatch(options: unknown, handler: NativeHandler) {
      nativeHandler = handler;
      return dispatcher.dispatch(options, handler);
    },
  };
  const observer = new HubConnection(1_500);
  const ObservedWebSocket = observer.websocket();
  const socket = new ObservedWebSocket(url);
  expect(socket).toBeInstanceOf(NativeWebSocket);
  socket.addEventListener("error", () => {});
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", () => {
      resolve();
    }, { once: true });
  });
  cleanup.push(async () => {
    if (socket.readyState !== NativeWebSocket.CLOSED) {
      if (nativeHandler) nativeHandler.onResponseError(null, new Error("finish the test socket"));
      else socket.close();
    }
    await closed;
  });
  return { observer, closed };
}

async function failedDial(error: Error, url?: string) {
  const { observer, closed } = dial({
    dispatch(_options, handler) {
      queueMicrotask(() => handler.onResponseError(null, error));
      return true;
    },
  }, url);
  await closed;
  return observer.failure(false);
}

it("records a native timeout errno before or after its address is known", async () => {
  const beforeAddress = await failedDial(Object.assign(new Error("private timeout text"), {
    code: "UND_ERR_CONNECT_TIMEOUT",
  }));
  expect(beforeAddress).toEqual({ cause: "timeout", detail: "1.5 hub.example:443 UND_ERR_CONNECT_TIMEOUT" });
  expect(formatHubFailure(beforeAddress ?? {})).toBe(
    "timed out after 1.5s connecting to hub.example:443 (UND_ERR_CONNECT_TIMEOUT)",
  );

  const afterAddress = await failedDial(Object.assign(new Error("private timeout text"), {
    code: "ETIMEDOUT", address: "203.0.113.7", port: 443,
  }));
  expect(afterAddress).toEqual({ cause: "timeout", detail: "1.5 203.0.113.7:443 ETIMEDOUT" });
});

it("takes a refused IPv6 endpoint from a nested multiple-address error", async () => {
  const refused = Object.assign(new Error("private refused text"), {
    code: "ECONNREFUSED", address: "2001:db8::7", port: 443,
  });
  const aggregate = Object.assign(new AggregateError([
    new Error("unclassified private text"),
    new AggregateError([refused], "private nested aggregate text"),
  ], "private aggregate text"), { code: "ECONNREFUSED" });
  const failure = await failedDial(aggregate);
  expect(failure).toEqual({ cause: "refused", detail: "ECONNREFUSED [2001:db8::7]:443" });
  expect(formatHubFailure(failure ?? {})).toBe("refused by [2001:db8::7]:443 (ECONNREFUSED)");
});

it.each(["ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED"])(
  "keeps only %s and the dialled host from certificate and URL secrets",
  async (code) => {
    const failure = await failedDial(Object.assign(new Error("private certificate subject and token"), {
      code,
      hostname: "private-error-host",
      reason: "private certificate reason",
      cert: { subject: { CN: "private-certificate-name" }, subjectaltname: "private-altname" },
    }), "wss://private-user:private-token@hub.example/private-path?private-query");
    expect(failure).toEqual({ cause: "tls", detail: `${code} hub.example` });
    expect(formatHubFailure(failure ?? {})).toBe(`TLS certificate not valid for hub.example (${code})`);
  },
);

it("leaves an unsafe unclassified error without a cause or detail", async () => {
  const failure = await failedDial(Object.assign(new Error("private failure text"), {
    code: "ERR_TLS_private token", address: "private-address:private-token", port: "private-port",
  }));
  expect(failure).toBeUndefined();
});

it("ignores an unrelated delayed request inheriting its dispatch context", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  let handler: NativeHandler | undefined;
  let finishUnrelated: (() => void) | undefined;
  const unrelatedFinished = new Promise<void>((resolve) => { finishUnrelated = resolve; });
  const { observer, closed } = dial({
    dispatch(_options, requestHandler) {
      handler = requestHandler;
      const request = {};
      channel("undici:request:create").publish({ request });
      channel("undici:client:sendHeaders").publish({
        request, socket: { remoteAddress: "203.0.113.7", remotePort: 443 },
      });
      queueMicrotask(() => {
        const unrelatedRequest = {};
        channel("undici:request:create").publish({ request: unrelatedRequest });
        channel("undici:client:sendHeaders").publish({
          request: unrelatedRequest, socket: { remoteAddress: "198.51.100.9", remotePort: 443 },
        });
        finishUnrelated?.();
      });
      return true;
    },
  });
  await unrelatedFinished;
  now.mockReturnValue(2_500);
  expect(observer.failure(true)).toEqual({ cause: "timeout", detail: "1.5 203.0.113.7:443" });
  handler?.onResponseError(null, new Error("close the pending test socket"));
  await closed;
});
