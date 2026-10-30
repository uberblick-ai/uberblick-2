import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpHostConfig } from "../src/host-config.js";
import { builtSource, PACKAGE_ROOT } from "./process-helpers.js";
import { cleanupTestResources, closeChild, tempDir, trackChild, WORKSPACE } from "./shared.js";

const ISSUER = "https://hub.example.com";
const TOKEN = "host-entry-test-token";
const children: ChildProcess[] = [];

function configEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { XDG_DATA_HOME: "/unused-test-data", ...overrides };
}

describe("host configuration", () => {
  it("uses the shared public-origin parser and denies origins by default", () => {
    expect(resolveMcpHostConfig(configEnv()).issuer).toBeUndefined();
    expect(resolveMcpHostConfig(configEnv()).allowedOrigins).toEqual([]);
    expect(resolveMcpHostConfig(configEnv({ HUB_PUBLIC_URL: "HTTPS://HUB.EXAMPLE.COM:443/" })).issuer)
      .toBe(ISSUER);
    expect(resolveMcpHostConfig(configEnv({ HUB_PUBLIC_URL: "http://127.0.0.1:8080/" })).issuer)
      .toBe("http://127.0.0.1:8080");
    expect(resolveMcpHostConfig(configEnv({ MCP_ALLOWED_ORIGINS: " https://one.example, ,https://two.example " })).allowedOrigins)
      .toEqual(["https://one.example", "https://two.example"]);
  });

  it.each(["http://hub.example.com", "https://hub.example.com/path", "https://user@hub.example.com", "https://hub.example.com?query"])(
    "refuses invalid public issuer %s", issuer => {
      expect(() => resolveMcpHostConfig(configEnv({ HUB_PUBLIC_URL: issuer }))).toThrow("HUB_PUBLIC_URL");
    },
  );
});

function startHost(overrides: NodeJS.ProcessEnv = {}, args: string[] = []) {
  const directory = tempDir();
  const child = trackChild(spawn(process.execPath, [builtSource(join(PACKAGE_ROOT, "src/host-main.ts")), ...args], {
    cwd: PACKAGE_ROOT,
    env: {
      PATH: process.env.PATH ?? "", MCP_HOST: "127.0.0.1", MCP_PORT: "0",
      MCP_DATA_DIR: directory, HUB_PUBLIC_URL: "HTTPS://HUB.EXAMPLE.COM:443/", ...overrides,
    },
    timeout: 20_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"],
  }));
  children.push(child);
  let stderr = "";
  let stdout = "";
  let buffer = "";
  let listening!: (port: number) => void;
  const port = new Promise<number>(resolve => { listening = resolve; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const address = line.match(/MCP host listening (\{.*\})$/)?.[1];
      if (address === undefined) continue;
      const record = JSON.parse(address) as { address: { port: number } };
      listening(record.address.port);
    }
  });
  return {
    child, closed, directory,
    output: () => stdout + stderr,
    url: Promise.race([
      port.then(value => `http://127.0.0.1:${value}`),
      closed.then(result => { throw new Error(`host exited before listening (${JSON.stringify(result)}): ${stderr}`); }),
    ]),
  };
}

afterEach(async () => {
  await cleanupTestResources({ clients: children.splice(0).map(child => () => closeChild(child)) });
});

async function response(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  const result = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
  // Consume every response before shutdown so the client owns no pending body.
  await result.text();
  expect([...result.headers.keys()].some(name => name.startsWith("access-control-"))).toBe(false);
  return result;
}

it("keeps the real entry unavailable despite stub arguments and environment, with discovery and refusal order intact", async () => {
  const host = startHost({
    NODE_ENV: "test", MCP_TOKEN_CHECK: "stub", MCP_STUB_TOKEN: TOKEN,
    MCP_AUTH_TOKEN: TOKEN, HUB_AUTH_TOKEN: TOKEN,
    MCP_ALLOWED_ORIGINS: " https://allowed.example, https://second.example ",
  }, ["--token-check=stub", `--stub-token=${TOKEN}`, "--allow-all-tokens"]);
  const base = await host.url;
  const path = `/mcp/${WORKSPACE}`;

  for (const method of ["POST", "GET", "DELETE"]) {
    expect((await response(base, path, { method, headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(503);
    expect((await response(base, path, {
      method, headers: { Authorization: `Bearer ${TOKEN}`, "Mcp-Session-Id": "unknown-session" },
    })).status).toBe(503);
    const unauthorized = await response(base, `${path}?access_token=${TOKEN}`, { method });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate"))
      .toBe(`Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource${path}", scope="docs:read docs:write"`);
  }
  for (const origin of ["https://allowed.example", "https://second.example"]) {
    expect((await response(base, path, { headers: { Origin: origin, Authorization: `Bearer ${TOKEN}` } })).status).toBe(503);
  }
  for (const origin of ["null", "https://ALLOWED.example", "https://allowed.example/", "https://denied.example"]) {
    for (const authorization of [undefined, `Bearer ${TOKEN}`]) {
      expect((await response(base, path, { headers: {
        Origin: origin, ...(authorization === undefined ? {} : { Authorization: authorization }),
      } })).status).toBe(403);
    }
  }
  for (const id of [`team-${WORKSPACE}`, WORKSPACE.toUpperCase(), "bad-id", `${WORKSPACE}/`]) {
    expect((await response(base, `/mcp/${id}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
  }
  const metadata = await fetch(`${base}/.well-known/oauth-protected-resource${path}`);
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toEqual({
    resource: `${ISSUER}${path}`, authorization_servers: [ISSUER],
    scopes_supported: ["docs:read", "docs:write"], bearer_methods_supported: ["header"],
  });
  expect((await response(base, path, { method: "OPTIONS" })).status).toBe(405);
  expect(readdirSync(host.directory)).toEqual([]);
  host.child.kill("SIGTERM");
  expect(await host.closed).toEqual({ code: 0, signal: null });
  expect(host.output()).not.toContain(TOKEN);
});

it("denies every present Origin by default and exits cleanly on SIGINT", async () => {
  const host = startHost();
  const base = await host.url;
  const path = `/mcp/${WORKSPACE}`;
  expect((await response(base, path, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(503);
  for (const origin of ["null", "https://allowed.example"]) {
    expect((await response(base, path, { headers: { Origin: origin, Authorization: `Bearer ${TOKEN}` } })).status).toBe(403);
  }
  host.child.kill("SIGINT");
  expect(await host.closed).toEqual({ code: 0, signal: null });
});
