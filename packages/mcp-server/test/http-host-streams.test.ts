import { once } from "node:events";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { CredentialProvider } from "../src/credential-provider.js";
import { createMcpHost } from "../src/http-host.js";
import type { McpHostTokenResult } from "../src/host-token-check.js";
import * as serverModule from "../src/server.js";
import { cleanupTestResources, tempDir, WORKSPACE } from "./helpers.js";

const hosts: ReturnType<typeof createMcpHost>[] = [];
const requests: ClientRequest[] = [];
const positive: McpHostTokenResult = {
  status: "positive", grantId: "stream-grant", principal: "person", workspace: WORKSPACE,
  scope: "docs:read docs:write", expiresAt: 2_000_000_000_000,
};
const credentialProvider: CredentialProvider = {
  read: () => ({ status: "hub-down", origin: "http://127.0.0.1:1", message: "Test hub is unavailable" }),
  async ensure() { return this.read(); },
};

afterEach(async () => {
  for (const outgoing of requests.splice(0)) outgoing.destroy();
  vi.useRealTimers();
  await cleanupTestResources({ peers: hosts.splice(0).map(host => () => host.close()) });
  vi.restoreAllMocks();
});

async function fixture() {
  const createRuntime = serverModule.createMcpRuntime;
  vi.spyOn(serverModule, "createMcpRuntime").mockImplementation((config, options) =>
    createRuntime({ ...config, localWorkspace: true }, options));
  const checkToken = vi.fn(async (_token: string): Promise<McpHostTokenResult> => positive);
  const host = createMcpHost({
    issuer: "https://hub.example", allowedOrigins: [], hubUrl: "ws://127.0.0.1:1", databaseDirectory: tempDir(),
  }, { checkToken, credentialsForGrant: async () => ({ credentialProvider, agentName: "Stream grant" }) });
  hosts.push(host);
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  const address = host.server.address();
  if (address === null || typeof address === "string") throw new Error("Missing host port");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp/${WORKSPACE}`);
  const initialized = await fetch(url, {
    method: "POST", headers: { Authorization: "Bearer initial", Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stream-test", version: "1" },
    } }),
  });
  expect(initialized.status).toBe(200);
  const sessionId = initialized.headers.get("mcp-session-id")!;
  await initialized.text();
  checkToken.mockClear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });

  async function send(method: string, token: string) {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = request(url, { method, headers: {
        Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": "2025-11-25",
        Accept: "application/json, text/event-stream", "Content-Type": "application/json",
      } }, resolve);
      requests.push(outgoing);
      outgoing.once("error", reject);
      outgoing.end(method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) : undefined);
    });
    let ended = false;
    const end = new Promise<void>((resolve, reject) => {
      response.once("end", () => { ended = true; resolve(); });
      response.once("error", reject);
    });
    void end.catch(() => {});
    response.resume();
    return { response, end, ended: () => ended };
  }
  return { host, checkToken, send };
}

it("checks the opening token despite a renewed-token POST and preserves the session after closing only its stream", async () => {
  const rig = await fixture();
  const stream = await rig.send("GET", "opening-token");
  expect(stream.response.statusCode).toBe(200);
  const post = await rig.send("POST", "renewed-token");
  await post.end;
  expect(post.response.statusCode).toBe(200);
  rig.checkToken.mockImplementation(async token => token === "opening-token" ? { status: "negative" } : positive);
  await vi.advanceTimersByTimeAsync(25_000);
  await stream.end;
  expect(rig.checkToken.mock.calls).toEqual([["opening-token"], ["renewed-token"], ["opening-token"]]);

  const successor = await rig.send("GET", "renewed-token");
  expect(successor.response.statusCode).toBe(200);
  const duplicate = await rig.send("GET", "duplicate-token");
  await duplicate.end;
  expect(duplicate.response.statusCode).toBe(409);
  rig.checkToken.mockResolvedValue({ status: "negative" });
  await vi.advanceTimersByTimeAsync(25_000);
  await successor.end;
  expect(rig.checkToken.mock.calls.at(-1)).toEqual(["renewed-token"]);
});

it.each(["negative", "unavailable", "workspace", "throw"])("closes an open stream on a %s recheck", async reason => {
  const rig = await fixture();
  const stream = await rig.send("GET", "opening-token");
  if (reason === "throw") rig.checkToken.mockRejectedValue(new Error("secret-opening-token"));
  else rig.checkToken.mockResolvedValue(reason === "workspace"
    ? { ...positive, workspace: "00000000-0000-0000-0000-000000000000" }
    : { status: reason as "negative" | "unavailable" });
  await vi.advanceTimersByTimeAsync(25_000);
  await stream.end;
});

it("bounds a pending recheck and keeps checks 25 seconds apart despite a slow positive answer", async () => {
  const rig = await fixture();
  const stream = await rig.send("GET", "opening-token");
  let answer!: (value: McpHostTokenResult) => void;
  rig.checkToken.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  await vi.advanceTimersByTimeAsync(25_000);
  expect(rig.checkToken).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(4_000);
  answer(positive);
  await vi.advanceTimersByTimeAsync(21_000);
  expect(rig.checkToken).toHaveBeenCalledTimes(3);
  expect(stream.ended()).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  await stream.end;
  expect(performance.now()).toBe(55_000);
});

it("fences a pending check when a stream disconnects and cancels polling at host shutdown", async () => {
  const rig = await fixture();
  const original = await rig.send("GET", "opening-token");
  let answer!: (value: McpHostTokenResult) => void;
  rig.checkToken.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  await vi.advanceTimersByTimeAsync(25_000);
  original.response.destroy();
  await once(original.response, "close");
  // Let the server observe the disconnection before the replacement GET.
  const barrier = await rig.send("POST", "renewed-token");
  await barrier.end;
  const successor = await rig.send("GET", "renewed-token");
  expect(successor.response.statusCode).toBe(200);
  answer({ status: "negative" });
  await vi.advanceTimersByTimeAsync(0);
  expect(successor.ended()).toBe(false);
  await rig.host.close();
  await successor.end;
  const calls = rig.checkToken.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(rig.checkToken).toHaveBeenCalledTimes(calls);
});
