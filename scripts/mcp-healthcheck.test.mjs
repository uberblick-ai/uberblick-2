import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../mcp-healthcheck.mjs", import.meta.url));

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function run(port, hubPort, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, MCP_HOST: "0.0.0.0", MCP_PORT: String(port), HUB_URL: `ws://127.0.0.1:${hubPort}/ws`,
        HTTP_PROXY: "http://unreachable.invalid:1", NODE_USE_ENV_PROXY: "1", ...overrides },
      stdio: "ignore", timeout: 6_000,
    });
    child.once("error", reject);
    child.once("close", code => resolve(code));
  });
}

test("MCP readiness requires its listener and a completed credential-free hub WebSocket handshake", async () => {
  let listenerStatus = 401;
  const requests = [];
  const listener = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization, origin: request.headers.origin });
    response.writeHead(listenerStatus).end();
  });
  let upgrade = "valid";
  const hubRequests = [];
  const hub = createServer((_request, response) => response.writeHead(404).end());
  const sockets = new Set();
  hub.on("connection", socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  hub.on("upgrade", (request, socket) => {
    hubRequests.push({ path: request.url, authorization: request.headers.authorization });
    if (upgrade === "silent") return;
    if (upgrade === "refused") { socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); return; }
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${upgrade === "invalid" ? "invalid" : accept}\r\n\r\n`);
  });
  const port = await listen(listener);
  const hubPort = await listen(hub);
  try {
    assert.equal(await run(port, hubPort), 0);
    assert.deepEqual(requests[0], { path: "/mcp/00000000-0000-4000-8000-000000000000",
      authorization: "Bearer mcp-healthcheck", origin: undefined });
    assert.deepEqual(hubRequests[0], { path: "/ws", authorization: undefined });
    listenerStatus = 503;
    assert.equal(await run(port, hubPort), 1, "socket unavailability is an unhealthy host response");
    listenerStatus = 401;
    upgrade = "refused";
    assert.equal(await run(port, hubPort), 1);
    upgrade = "invalid";
    assert.equal(await run(port, hubPort), 1, "an HTTP 101 alone is not a completed WebSocket handshake");
    upgrade = "silent";
    assert.equal(await run(port, hubPort), 1, "the absolute deadline bounds a nonresponsive hub");
    upgrade = "valid";
    assert.equal(await run(port, hubPort), 0);
    await new Promise(resolve => listener.close(resolve));
    assert.equal(await run(port, hubPort), 1);
  } finally {
    listener.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => hub.close(resolve));
  }
});
