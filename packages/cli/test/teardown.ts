import type { ChildProcess } from "node:child_process";
import type { Server, Socket } from "node:net";
import type { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { closeHubSocket } from "../../mcp-server/src/hub-connection.js";
import { drainWaits } from "../../mcp-server/test/lifecycle.js";

type Cleanup = () => unknown;

/** Finish every resource in order, then report every failure to its test. */
export async function cleanUpResources(...groups: readonly Cleanup[][]): Promise<void> {
  const failures: unknown[] = [];
  try {
    await drainWaits();
  } catch (error) {
    failures.push(error);
  }
  for (const group of groups) {
    for (const close of group) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "test resource cleanup failed");
}

/** Capture the native socket before Hocuspocus destroys its own listeners. */
export async function closeProvider(provider: HocuspocusProvider): Promise<void> {
  if (!provider.manageSocket) {
    // Shared transports close after every document provider has detached.
    provider.destroy();
    return;
  }
  await closeWebSocket(provider.configuration.websocketProvider, () => provider.destroy());
}

export async function closeWebSocket(
  provider: HocuspocusProviderWebsocket,
  destroy: () => void = () => provider.destroy(),
): Promise<void> {
  await closeHubSocket(provider.webSocket, destroy);
}

/** Own accepted sockets too: HTTP server.close does not await upgraded ones. */
export function ownListener(server: Server): () => Promise<void> {
  const sockets = new Set<Socket>();
  const failures: unknown[] = [];
  const accepted = (socket: Socket): void => {
    if (sockets.has(socket)) return;
    sockets.add(socket);
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET") failures.push(error);
    });
    socket.once("close", () => sockets.delete(socket));
  };
  server.on("connection", accepted);
  server.on("error", (error) => failures.push(error));
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= (async () => {
      const closedSockets = [...sockets].map((socket) => {
        const closed = socket.closed ? Promise.resolve() : new Promise<void>((resolve) => socket.once("close", resolve));
        socket.destroy();
        return closed;
      });
      await new Promise<void>((resolve) => {
        server.close((error) => {
          if (error !== undefined) failures.push(error);
          resolve();
        });
      });
      await Promise.all(closedSockets);
      if (failures.length > 0) throw new AggregateError(failures, "test listener failed");
    })();
    return closing;
  };
}

/** Observe close at spawn time, including children that exit before teardown. */
export function ownChild(child: ChildProcess): () => Promise<void> {
  const failures: unknown[] = [];
  child.on("error", (error) => failures.push(error));
  const closed = new Promise<void>((resolve) => child.once("close", resolve));
  return async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    if (failures.length > 0) throw new AggregateError(failures, "test child failed");
  };
}
