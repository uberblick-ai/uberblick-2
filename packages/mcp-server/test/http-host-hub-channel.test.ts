import { once } from "node:events";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
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
