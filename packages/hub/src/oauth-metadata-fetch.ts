import type { LookupAddress } from "node:dns";
import { Resolver } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { Agent, request, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export const METADATA_FETCH_TIMEOUT_MS = 5_000;
export const METADATA_BODY_LIMIT = 32 * 1024;

const specialV4 = new BlockList();
const specialV6 = new BlockList();
// IANA special-purpose registries, including their globally reachable entries.
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) specialV4.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["100:0:0:1::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["2620:4f:8000::", 48], ["3fff::", 20], ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) specialV6.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function isPublicMetadataAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !specialV4.check(address, "ipv4");
  return globalV6.check(address, "ipv6") && !specialV6.check(address, "ipv6");
}

export function parseMetadataClientId(clientId: string): URL | null {
  // URL parsing removes dot segments, whitespace and backslashes before callers can inspect them.
  if ([...clientId].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 ||
    character === "\\" || character === "#")) return null;
  const raw = /^https:\/\/([^/?#]+)(\/[^?#]*)(?:\?[^#]*)?$/i.exec(clientId);
  const authority = raw?.[1];
  const path = raw?.[2];
  if (authority === undefined || path === undefined || authority.includes("@") || path === "/") return null;
  if (path.split("/").some(segment => [".", ".."].includes(segment.replace(/%2e/gi, ".")))) return null;
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "" ? url : null;
  } catch { return null; }
}

async function resolveAddresses(hostname: string, signal: AbortSignal): Promise<LookupAddress[]> {
  const resolver = new Resolver({ timeout: METADATA_FETCH_TIMEOUT_MS, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    signal.throwIfAborted();
    const addresses: LookupAddress[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") addresses.push(...result.value.map(address => ({ address, family: index === 0 ? 4 : 6 })));
      else if (!["ENODATA", "ENOTFOUND"].includes((result.reason as NodeJS.ErrnoException).code ?? "")) throw result.reason;
    }
    return addresses;
  } finally { signal.removeEventListener("abort", cancel); }
}

interface FetchDependencies {
  resolve(hostname: string, signal: AbortSignal): Promise<LookupAddress[]>;
  request(options: RequestOptions, callback: (response: IncomingMessage) => void): ReturnType<typeof request>;
}

/** Internal transport seams; production always uses the guarded defaults. */
export function createMetadataFetcher(dependencies: Partial<FetchDependencies> = {}) {
  const resolve = dependencies.resolve ?? resolveAddresses;
  const send = dependencies.request ?? request;
  return async (url: URL, externalSignal?: AbortSignal): Promise<unknown> => {
    const controller = new AbortController();
    const abort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("metadata fetch timed out")), METADATA_FETCH_TIMEOUT_MS);
    // A fresh explicit agent cannot inherit NODE_USE_ENV_PROXY or reuse another request's connection.
    const agent = new Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0, proxyEnv: {} });
    try {
      controller.signal.throwIfAborted();
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const literal = isIP(hostname);
      const addresses = literal ? [{ address: hostname, family: literal }] : await resolve(hostname, controller.signal);
      controller.signal.throwIfAborted();
      const pinned = addresses[0];
      if (pinned === undefined || addresses.some(value => !isPublicMetadataAddress(value.address) || isIP(value.address) !== value.family)) {
        throw new Error("metadata address refused");
      }
      const response = await new Promise<IncomingMessage>((resolveResponse, reject) => {
        const outgoing = send({ protocol: "https:", hostname, port: url.port || 443,
          path: url.pathname + url.search, method: "GET", agent, signal: controller.signal,
          family: pinned.family,
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          },
          headers: { Accept: "application/json", "Accept-Encoding": "gzip, deflate, br", Connection: "close" },
        }, resolveResponse);
        outgoing.once("error", reject);
        outgoing.end();
      });
      if (response.statusCode !== 200) { response.destroy(); throw new Error("metadata response refused"); }
      const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
      const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
        : encoding === "br" ? createBrotliDecompress() : undefined;
      if (encoding !== undefined && encoding !== "identity" && decoder === undefined) {
        response.destroy(); throw new Error("metadata encoding refused");
      }
      let size = 0;
      const chunks: Buffer[] = [];
      const cap = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        callback(size > METADATA_BODY_LIMIT ? new Error("metadata body too large") : null, chunk);
      } });
      const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(chunk); callback(); } });
      if (decoder === undefined) await pipeline(response, cap, sink, { signal: controller.signal });
      else await pipeline(response, decoder, cap, sink, { signal: controller.signal });
      controller.signal.throwIfAborted();
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abort);
      agent.destroy();
    }
  };
}

export const fetchMetadataDocument = createMetadataFetcher();
