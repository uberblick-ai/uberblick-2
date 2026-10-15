import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { cleanUpResources, ownChild, ownListener } from "./teardown.js";

describe("test resource teardown", () => {
  it("finishes each group in order and continues after a rejected close", async () => {
    const order: string[] = [];
    const failure = new Error("client close failed");
    await expect(cleanUpResources(
      [async () => { order.push("client"); throw failure; }],
      [async () => { order.push("peer"); }],
      [async () => { order.push("hub"); }],
      [() => { order.push("directory"); }],
    )).rejects.toMatchObject({ errors: [failure] });
    expect(order).toEqual(["client", "peer", "hub", "directory"]);
  });

  it.each(["ECONNRESET", "EPIPE"])("closes accepted sockets and reports only unexpected %s errors", async (code) => {
    const server = createServer();
    const close = ownListener(server);
    const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no listener port");
    const client = createConnection({ host: "127.0.0.1", port: address.port });
    const failures: unknown[] = [];
    client.on("error", (error) => failures.push(error));
    const clientClosed = new Promise<void>((resolve) => client.once("close", resolve));
    try {
      const socket = await accepted;
      const failure = Object.assign(new Error(code), { code });
      socket.emit("error", failure);
      if (code === "ECONNRESET") await close();
      else await expect(close()).rejects.toMatchObject({ errors: [failure] });
      expect(socket.closed).toBe(true);
    } finally {
      client.destroy();
      await clientClosed;
    }
    expect(failures).toEqual([]);
  });

  it("waits for a killed child's close event before the hub step", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const close = ownChild(child);
    let closed = false;
    child.once("close", () => { closed = true; });
    await cleanUpResources([close], [() => { expect(closed).toBe(true); }]);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("keeps socket error handling after an HTTP upgrade", async () => {
    const server = createHttpServer();
    const close = ownListener(server);
    const upgraded = new Promise<Duplex>((resolve) => server.once("upgrade", (_request, socket) => resolve(socket)));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no listener port");
    const client = createConnection({ host: "127.0.0.1", port: address.port });
    const failures: unknown[] = [];
    client.on("error", (error) => failures.push(error));
    const clientClosed = new Promise<void>((resolve) => client.once("close", resolve));
    client.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    try {
      const socket = await upgraded;
      const failure = Object.assign(new Error("unexpected upgrade error"), { code: "EPIPE" });
      socket.emit("error", failure);
      await expect(close()).rejects.toMatchObject({ errors: [failure] });
      expect(socket.closed).toBe(true);
    } finally {
      client.destroy();
      await clientClosed;
    }
    expect(failures).toEqual([]);
  });
});
