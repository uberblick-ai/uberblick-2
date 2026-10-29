import { readFileSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import { createServer as createHttpServer } from "node:http";
import { Agent, createServer, request, type Server } from "node:https";
import { createConnection, type AddressInfo } from "node:net";
import { connect } from "node:tls";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetadataFetcher, isPublicMetadataAddress, METADATA_BODY_LIMIT, METADATA_FETCH_TIMEOUT_MS,
  parseMetadataClientId } from "../src/oauth-metadata-fetch.js";

const cert = readFileSync(new URL("./fixtures/oauth-metadata-cert.pem", import.meta.url));
const key = readFileSync(new URL("./fixtures/oauth-metadata-key.pem", import.meta.url));
const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

async function transport(handler: Parameters<typeof createServer>[1], hostname = "metadata.example") {
  const server = createServer({ cert, key }, handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const resolutions = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
  const connections: string[] = [];
  const fetch = createMetadataFetcher({ resolve: resolutions, request: (options, callback) => {
    expect(options.agent).toBeInstanceOf(Agent);
    expect((options.agent as Agent).options.proxyEnv).toEqual({});
    // Route the checked address to the fixture only after exercising the production pinned lookup.
    return request({ ...options, port, ca: cert, lookup: (host, lookupOptions, done) => {
      options.lookup!(host, lookupOptions, (error, address, family) => {
        expect(error).toBeNull();
        const selected = typeof address === "string" ? address : address[0]!.address;
        connections.push(selected);
        expect(selected).toBe("8.8.8.8");
        done(null, lookupOptions.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", family ?? 4);
      });
    } }, callback);
  } });
  return { fetch, url: new URL(`https://${hostname}/client.json`), resolutions, connections, server };
}

describe("metadata client URL validation before normalization", () => {
  it.each([
    "https://metadata.example", "https://metadata.example/", "https://metadata.example/?x=1",
    "http://metadata.example/client.json", "ftp://metadata.example/client.json", "registered-client",
    "https://user:pass@metadata.example/client.json", "https://@metadata.example/client.json",
    "https://metadata.example/client.json#", "https://metadata.example/client.json#fragment",
    "https://metadata.example/a/../client.json", "https://metadata.example/./client.json",
    "https://metadata.example/a/%2e%2E/client.json", "https://metadata.example/%2E/client.json",
    "https://metadata.example/.%2e/client.json", "https://metadata.example/%2e./client.json",
    " https://metadata.example/client.json", "https://metadata.example/cli\tent.json",
    "https://metadata.example\\private/client.json", "https://metadata.example/a\\..\\client.json",
  ])("refuses %s", value => { expect(parseMetadataClientId(value)).toBeNull(); });

  it.each(["https://metadata.example/client.json", "HTTPS://METADATA.EXAMPLE/client.json?x=1",
    "https://metadata.example/.well-known/client.json", "https://[2606:4700:4700::1111]/client.json"])("accepts %s", value => {
    expect(parseMetadataClientId(value)).toBeInstanceOf(URL);
  });
});

describe("metadata address policy", () => {
  it.each([
    "0.1.2.3", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1",
    "192.0.0.9", "192.0.2.1", "192.31.196.1", "192.52.193.1", "192.88.99.1", "192.168.1.1",
    "192.175.48.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:8.8.8.8", "::ffff:127.0.0.1", "64:ff9b::808:808", "64:ff9b:1::1",
    "100::1", "100:0:0:1::1", "2001::1", "2001:1::3", "2001:db8::1", "2002:0808:0808::1",
    "2620:4f:8000::1", "3fff::1", "5f00::1", "fc00::1", "fe80::1", "ff02::1", "4000::1", "garbage",
  ])("refuses special or nonpublic address %s", address => { expect(isPublicMetadataAddress(address)).toBe(false); });
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("permits public %s", address => {
    expect(isPublicMetadataAddress(address)).toBe(true);
  });

  it("refuses the whole answer if any resolved address is unsafe", async () => {
    const send = vi.fn();
    const fetch = createMetadataFetcher({ resolve: async () => [
      { address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 },
    ], request: send });
    await expect(fetch(new URL("https://metadata.example/client.json"))).rejects.toThrow("address refused");
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "[::1]", "2130706433", "0x7f000001"])("checks literal %s without DNS or connection", async host => {
    const resolve = vi.fn();
    const send = vi.fn();
    const fetch = createMetadataFetcher({ resolve, request: send });
    await expect(fetch(new URL(`https://${host}/client.json`))).rejects.toThrow("address refused");
    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("guarded metadata HTTPS transport", () => {
  it("keeps a public IPv6 literal as the TLS certificate identity without resolving it", async () => {
    const server = createServer({ cert, key }, (_incoming, response) => response.end('{"ok":true}'));
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const resolve = vi.fn();
    const fetch = createMetadataFetcher({ resolve, request: (options, callback) => {
      expect(options.hostname).toBe("2606:4700:4700::1111");
      const agent = options.agent as Agent;
      agent.createConnection = tlsOptions => {
        expect(tlsOptions.host).toBe("2606:4700:4700::1111");
        return connect({ host: tlsOptions.host ?? undefined, servername: tlsOptions.servername,
          ca: cert, socket: createConnection({ host: "127.0.0.1", port }) });
      };
      return request(options, callback);
    } });
    await expect(fetch(new URL("https://[2606:4700:4700::1111]/client.json"))).resolves.toEqual({ ok: true });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("pins the checked answer, retains TLS hostname verification and bypasses environment proxies", async () => {
    let proxyConnections = 0;
    const proxy = createHttpServer();
    proxy.on("connection", socket => { proxyConnections++; socket.destroy(); });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    try {
      vi.stubEnv("NODE_USE_ENV_PROXY", "1");
      vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
      vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
      const r = await transport((_incoming, response) => response.end('{"ok":true}'));
      r.resolutions.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
        .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      await expect(r.fetch(r.url)).resolves.toEqual({ ok: true });
      expect(r.resolutions).toHaveBeenCalledTimes(1);
      expect(r.connections).toEqual(["8.8.8.8"]);
      expect(proxyConnections).toBe(0);
      const mismatch = await transport((_incoming, response) => response.end("{}"), "wrong.example");
      await expect(mismatch.fetch(mismatch.url)).rejects.toThrow(/Hostname\/IP does not match certificate/);
    } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); }
  });

  it.each([201, 301, 302, 307, 308, 404, 500])("refuses HTTP %s without following a redirect", async status => {
    let hits = 0;
    const r = await transport((_incoming, response) => {
      hits++; response.writeHead(status, { Location: "https://127.0.0.1/private" }); response.end("{}");
    });
    await expect(r.fetch(r.url)).rejects.toThrow("response refused");
    expect(hits).toBe(1);
  });

  it.each([
    ["identity", (body: Buffer) => body], ["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync],
  ] as const)("enforces the expanded body limit for %s", async (encoding, compress) => {
    let body = Buffer.from(JSON.stringify("x".repeat(METADATA_BODY_LIMIT - 2)));
    const r = await transport((_incoming, response) => {
      response.setHeader("Content-Encoding", encoding); response.end(compress(body));
    });
    await expect(r.fetch(r.url)).resolves.toBe("x".repeat(METADATA_BODY_LIMIT - 2));
    body = Buffer.from(JSON.stringify("x".repeat(METADATA_BODY_LIMIT)));
    await expect(r.fetch(r.url)).rejects.toThrow("body too large");
    body = Buffer.from(JSON.stringify("x".repeat(4 * 1024 * 1024)));
    await expect(r.fetch(r.url)).rejects.toThrow("body too large");
  });

  it("refuses malformed JSON and unknown content encoding", async () => {
    const invalid = await transport((_incoming, response) => response.end("not JSON"));
    await expect(invalid.fetch(invalid.url)).rejects.toThrow();
    const unknown = await transport((_incoming, response) => {
      response.setHeader("Content-Encoding", "gzip, br"); response.end("{}");
    });
    await expect(unknown.fetch(unknown.url)).rejects.toThrow("encoding refused");
  });

  it("includes DNS time in the five-second deadline and cancels resolution", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const send = vi.fn();
    const fetch = createMetadataFetcher({ request: send, resolve: (_host, abortSignal) => {
      signal = abortSignal;
      return new Promise((_resolve, reject) => abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true }));
    } });
    const result = expect(fetch(new URL("https://metadata.example/client.json"))).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(METADATA_FETCH_TIMEOUT_MS);
    await result;
    expect(signal?.aborted).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("cancels both outstanding DNS queries at the deadline before any connection", async () => {
    vi.useFakeTimers();
    const pending: ((error: Error) => void)[] = [];
    const v4 = vi.spyOn(Resolver.prototype, "resolve4").mockImplementation(() => new Promise((_resolve, reject) => pending.push(reject)));
    const v6 = vi.spyOn(Resolver.prototype, "resolve6").mockImplementation(() => new Promise((_resolve, reject) => pending.push(reject)));
    const cancel = vi.spyOn(Resolver.prototype, "cancel").mockImplementation(() => {
      for (const reject of pending) reject(Object.assign(new Error("cancelled"), { code: "ECANCELLED" }));
    });
    try {
      const send = vi.fn();
      const fetch = createMetadataFetcher({ request: send });
      const result = expect(fetch(new URL("https://metadata.example/client.json"))).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(METADATA_FETCH_TIMEOUT_MS);
      await result;
      expect(v4).toHaveBeenCalledWith("metadata.example");
      expect(v6).toHaveBeenCalledWith("metadata.example");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    } finally { v4.mockRestore(); v6.mockRestore(); cancel.mockRestore(); }
  });

  it("cancels an incomplete response when its deadline expires", async () => {
    let arrived!: () => void;
    const arrival = new Promise<void>(resolve => { arrived = resolve; });
    const r = await transport((_incoming, response) => { response.write("{"); arrived(); });
    const result = expect(r.fetch(r.url)).rejects.toThrow();
    await arrival;
    await result;
  });

  it("honors shutdown cancellation while reading a response", async () => {
    let arrived!: () => void;
    const arrival = new Promise<void>(resolve => { arrived = resolve; });
    const r = await transport((_incoming, response) => { response.write("{"); arrived(); });
    const controller = new AbortController();
    const result = expect(r.fetch(r.url, controller.signal)).rejects.toThrow();
    await arrival;
    controller.abort();
    await result;
  });
});
