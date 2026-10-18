import { createConnection } from "node:net";
import { adminSocketPath } from "./admin-setup.js";
import type { OperatorRequest } from "./operator-control.js";

/** One bounded request over the deployment's private socket; never opens the database. */
export async function requestOperator(
  databasePath: string, request: "hub-status" | "hub-doctor" | "backup" | OperatorRequest, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const message = typeof request === "string" ? { action: request } : request;
  return new Promise((resolve, reject) => {
    const socket = createConnection(adminSocketPath(databasePath));
    let input = "";
    let completed = false;
    const fail = (error: unknown) => {
      if (completed) return;
      completed = true;
      socket.destroy();
      reject(error);
    };
    const abort = () => fail(new Error("command interrupted"));
    signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(message.action === "backup" ? 16 * 60_000 : 10_000,
      () => fail(new Error("hub control socket timed out")));
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input) > 65_536) { fail(new Error("invalid hub control response")); return; }
      const newline = input.indexOf("\n");
      if (newline < 0 || completed) return;
      try {
        const value = JSON.parse(input.slice(0, newline));
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid hub control response");
        completed = true;
        resolve(value);
        socket.end();
      } catch (error) { fail(error); }
    });
    socket.on("error", fail);
    socket.on("close", () => {
      signal?.removeEventListener("abort", abort);
      fail(new Error("hub control socket closed without a result"));
    });
  });
}
