import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

const configuredHost = process.env.MCP_HOST ?? "127.0.0.1";
const hosts = configuredHost === "::" ? ["::1"]
  : configuredHost === "0.0.0.0" ? ["127.0.0.1"]
    : configuredHost === "localhost" ? ["127.0.0.1", "::1"]
      : isIP(configuredHost) !== 0 ? [configuredHost]
        : [...new Set(Object.values(networkInterfaces()).flatMap(addresses => addresses ?? []).map(address => address.address))];
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 4_000);

function probeMcp(host) {
  return new Promise((resolve, reject) => {
    // An unissued token exercises real introspection; an unavailable socket produces 503.
    const probe = httpRequest({ host, port: process.env.MCP_PORT ?? "3001",
      path: "/mcp/00000000-0000-4000-8000-000000000000",
      headers: { Authorization: "Bearer mcp-healthcheck" }, agent: false, signal: controller.signal });
    probe.once("response", response => {
      response.destroy();
      if (response.statusCode === 401) resolve();
      else reject(new Error("MCP listener or hub socket is unavailable"));
    });
    probe.once("error", reject);
    probe.end();
  });
}

function probeHub() {
  return new Promise((resolve, reject) => {
    const url = new URL(process.env.HUB_URL ?? "ws://localhost:1234");
    if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.username || url.password) {
      reject(new Error("HUB_URL must name a credential-free WebSocket endpoint"));
      return;
    }
    const request = url.protocol === "wss:" ? httpsRequest : httpRequest;
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    const key = randomBytes(16).toString("base64");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const probe = request(url, { agent: false, signal: controller.signal, headers: {
      Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key,
    } });
    probe.once("upgrade", (response, socket) => {
      socket.destroy();
      if (response.statusCode === 101 && response.headers.upgrade?.toLowerCase() === "websocket" &&
        response.headers["sec-websocket-accept"] === accept &&
        response.headers.connection?.split(",").some(value => value.trim().toLowerCase() === "upgrade")) resolve();
      else reject(new Error("Hub WebSocket handshake failed"));
    });
    probe.once("response", response => {
      response.destroy();
      reject(new Error("Hub refused the WebSocket upgrade"));
    });
    probe.once("error", reject);
    probe.end();
  });
}

try {
  await Promise.all([Promise.any(hosts.map(probeMcp)), probeHub()]);
} catch {
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  controller.abort();
}
