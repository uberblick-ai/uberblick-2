import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer, request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpHost } from "../src/http-host.js";
import { cleanupTestResources, tempDir, trackListener, WORKSPACE } from "./shared.js";

const ISSUER = "https://hub.example.com";
const PATH = `/mcp/${WORKSPACE}`;
const hosts: ReturnType<typeof createMcpHost>[] = [];
const listeners: ReturnType<typeof trackListener>[] = [];

afterEach(async () => {
  await cleanupTestResources({
    peers: hosts.splice(0).map(host => () => host.close()),
    hubs: listeners.splice(0).map(listener => () => listener.close()),
  });
});

async function hostAt(hubMcpSocket: string) {
  const credentialsForGrant = vi.fn(async () => { throw new Error("Admission must finish before opening credentials"); });
  const host = createMcpHost({ issuer: ISSUER, allowedOrigins: [], hubUrl: "ws://127.0.0.1:1",
    databaseDirectory: tempDir(), hubMcpSocket }, { credentialsForGrant });
  hosts.push(host);
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  const address = host.server.address();
  if (address === null || typeof address === "string") throw new Error("Missing host address");
  return { port: address.port, credentialsForGrant };
}

function send(port: number, method: string) {
  return new Promise<{ status: number; challenge: string | undefined; body: string }>((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port, method, path: PATH,
      headers: { Authorization: "Bearer presented-token", "Mcp-Session-Id": "unknown" } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!,
        challenge: response.headers["www-authenticate"], body }));
    });
    outgoing.on("error", reject);
    outgoing.setTimeout(10_000, () => outgoing.destroy(new Error("Host admission timed out")));
    outgoing.end();
  });
}

it("uses the configured hub socket afresh on every method and uniformly refuses changed authority", async () => {
  const path = join(tempDir(), "channel.sock");
  const positive = { status: "positive", grantId: "grant-one", principal: "person-one", workspace: WORKSPACE,
    scope: "docs:read", expiresAt: Date.now() + 60_000 };
  let answer: object = positive;
  const presented: unknown[] = [];
  const server = createServer(socket => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      input += chunk;
      if (!input.includes("\n")) return;
      presented.push(JSON.parse(input.slice(0, input.indexOf("\n"))));
      socket.end(`${JSON.stringify(answer)}\n`);
    });
  });
  listeners.push(trackListener(server));
  server.listen(path);
  await once(server, "listening");
  const host = await hostAt(path);
  for (const method of ["POST", "GET", "DELETE"]) {
    answer = positive;
    expect((await send(host.port, method)).status).toBe(404);
    answer = { status: "negative" };
    const negative = await send(host.port, method);
    expect(negative.status).toBe(401);
    answer = { ...positive, workspace: "00000000-0000-0000-0000-000000000000" };
    expect(await send(host.port, method)).toEqual(negative);
  }
  expect(presented).toHaveLength(9);
  expect(presented.every(value => (value as { token: string }).token === "presented-token")).toBe(true);
  expect(host.credentialsForGrant).not.toHaveBeenCalled();
});

it("returns 503 without handling requests when the configured hub socket is absent", async () => {
  const host = await hostAt(join(tempDir(), "missing.sock"));
  for (const method of ["POST", "GET", "DELETE"]) {
    const response = await send(host.port, method);
    expect(response).toEqual({ status: 503, challenge: undefined, body: "" });
  }
  expect(host.credentialsForGrant).not.toHaveBeenCalled();
});

it("rechecks the socket and hub WebSocket after recovery without restarting the MCP host or issuing a credential", async () => {
  const path = join(tempDir(), "readiness.sock");
  const messages: unknown[] = [];
  const channel = createServer(socket => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", chunk => {
      input += chunk;
      if (!input.includes("\n")) return;
      messages.push(JSON.parse(input.slice(0, input.indexOf("\n"))));
      socket.end('{"status":"negative"}\n');
    });
  });
  const privateListener = trackListener(channel);
  listeners.push(privateListener);
  channel.listen(path);
  await once(channel, "listening");
  const websocket = createHttpServer((_request, response) => response.writeHead(404).end());
  websocket.on("upgrade", (request, socket) => {
    expect(request.url).toBe("/ws");
    expect(request.headers.authorization).toBeUndefined();
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  const webListener = trackListener(websocket);
  listeners.push(webListener);
  websocket.listen(0, "127.0.0.1");
  await once(websocket, "listening");
  const address = websocket.address();
  if (address === null || typeof address === "string") throw new Error("Missing WebSocket address");
  const host = createMcpHost({ issuer: undefined, allowedOrigins: [], hubUrl: `ws://127.0.0.1:${address.port}/ws`,
    databaseDirectory: tempDir(), hubMcpSocket: path });
  hosts.push(host);
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  const hostAddress = host.server.address();
  if (hostAddress === null || typeof hostAddress === "string") throw new Error("Missing MCP address");
  const check = () => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../../mcp-healthcheck.mjs", import.meta.url))], {
      env: { MCP_HOST: "127.0.0.1", MCP_PORT: String(hostAddress.port), HUB_URL: `ws://127.0.0.1:${address.port}/ws` },
      stdio: "ignore", timeout: 6_000,
    });
    child.once("error", reject);
    child.once("close", resolve);
  });
  expect(await check()).toBe(0);
  expect(messages).toEqual([{ action: "introspect", token: "mcp-healthcheck" }]);
  await privateListener.close();
  expect(await check()).toBe(1);
  channel.listen(path);
  await once(channel, "listening");
  expect(await check()).toBe(0);
  await webListener.close();
  expect(await check()).toBe(1);
  websocket.listen(address.port, "127.0.0.1");
  await once(websocket, "listening");
  expect(await check()).toBe(0);
  expect(messages.every(message => (message as { action: string }).action === "introspect")).toBe(true);
  expect(host.server.listening).toBe(true);
});
