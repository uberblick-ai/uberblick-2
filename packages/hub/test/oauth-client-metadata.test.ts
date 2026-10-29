import { describe, expect, it, vi } from "vitest";
import { UnsupportedOAuthClientAuthentication } from "../src/oauth-authorization.js";
import { MAX_CONCURRENT_METADATA_FETCHES, MAX_METADATA_CACHE_ENTRIES, METADATA_CACHE_TTL_MS, OAuthMetadataClients } from "../src/oauth-client-metadata.js";

const CLIENT_ID = "https://agent.example/client.json";
const REDIRECT = "http://127.0.0.1/callback";
function document(clientId = CLIENT_ID) {
  return { client_id: clientId, client_name: "Example Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" };
}

describe("metadata client documents", () => {
  it("uses only the required fields and the shared redirect rules", async () => {
    const fetch = vi.fn(async () => ({ ...document(), logo_uri: "https://internal.example/logo", jwks_uri: "https://internal.example/keys",
      scope: "ignored", grant_types: ["ignored"], response_types: ["ignored"] }));
    const clients = new OAuthMetadataClients(fetch);
    const client = await clients.lookup(CLIENT_ID);
    expect(client?.name).toBe("Example Agent");
    expect(client?.redirectUriAllowed("http://127.0.0.1:45678/callback")).toBe(true);
    expect(client?.redirectUriAllowed("http://127.0.0.1:45678/other")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    null, [], "string", 42,
    { ...document(), client_id: "https://AGENT.example/client.json" },
    { ...document(), client_id: undefined },
    { ...document(), client_name: "" },
    { ...document(), client_name: undefined },
    { ...document(), redirect_uris: [] },
    { ...document(), redirect_uris: "https://example.com" },
    { ...document(), redirect_uris: [REDIRECT, null] },
  ])("refuses invalid required fields without caching: %j", async value => {
    const fetch = vi.fn(async () => value);
    const clients = new OAuthMetadataClients(fetch);
    expect(await clients.lookup(CLIENT_ID)).toBeNull();
    expect(await clients.lookup(CLIENT_ID)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "client_secret_basic", "private_key_jwt", "NONE", "", null])(
    "reports unsupported authentication without caching: %s", async method => {
      const fetch = vi.fn(async () => ({ ...document(), token_endpoint_auth_method: method }));
      const clients = new OAuthMetadataClients(fetch);
      await expect(clients.lookup(CLIENT_ID)).rejects.toBeInstanceOf(UnsupportedOAuthClientAuthentication);
      await expect(clients.lookup(CLIENT_ID)).rejects.toBeInstanceOf(UnsupportedOAuthClientAuthentication);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

  it("leaves non-URL client ids unresolved without fetching", async () => {
    const fetch = vi.fn(async () => document());
    const clients = new OAuthMetadataClients(fetch);
    expect(await clients.lookup("registered-client-id")).toBeNull();
    expect(await clients.lookup("http://agent.example/client.json")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reuses validated documents by exact id for a fixed lifetime, independent of HTTP cache hints", async () => {
    let now = 0;
    const fetch = vi.fn(async (url: URL) => document(url.href));
    const clients = new OAuthMetadataClients(fetch, () => now);
    const first = await clients.lookup(CLIENT_ID);
    now = METADATA_CACHE_TTL_MS - 1;
    expect(await clients.lookup(CLIENT_ID)).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    now++;
    expect(await clients.lookup(CLIENT_ID)).not.toBe(first);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await clients.lookup("https://agent.example/other.json")).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("evicts entries at the fixed cache bound", async () => {
    const fetch = vi.fn(async (url: URL) => document(url.href));
    const clients = new OAuthMetadataClients(fetch);
    await clients.lookup(CLIENT_ID);
    for (let i = 0; i < MAX_METADATA_CACHE_ENTRIES; i++) await clients.lookup(`https://agent.example/${i}.json`);
    expect(fetch).toHaveBeenCalledTimes(MAX_METADATA_CACHE_ENTRIES + 1);
    await clients.lookup(CLIENT_ID);
    expect(fetch).toHaveBeenCalledTimes(MAX_METADATA_CACHE_ENTRIES + 2);
  });

  it("does not share cached clients between URL spellings that normalize identically", async () => {
    const explicitPort = "https://agent.example:443/client.json";
    const fetch = vi.fn().mockResolvedValueOnce(document()).mockResolvedValueOnce(document(explicitPort));
    const clients = new OAuthMetadataClients(fetch);
    const first = await clients.lookup(CLIENT_ID);
    const second = await clients.lookup(explicitPort);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(await clients.lookup(CLIENT_ID)).toBe(first);
    expect(await clients.lookup(explicitPort)).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses excess concurrency immediately and releases slots after failures", async () => {
    const gates: ((value: unknown) => void)[] = [];
    const fetch = vi.fn(() => new Promise<unknown>(resolve => gates.push(resolve)));
    const clients = new OAuthMetadataClients(fetch);
    const active = Array.from({ length: MAX_CONCURRENT_METADATA_FETCHES }, (_, i) => clients.lookup(`https://agent.example/${i}.json`));
    expect(gates).toHaveLength(MAX_CONCURRENT_METADATA_FETCHES);
    expect(await clients.lookup(CLIENT_ID)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(MAX_CONCURRENT_METADATA_FETCHES);
    for (const resolve of gates) resolve(null);
    expect(await Promise.all(active)).toEqual(Array(MAX_CONCURRENT_METADATA_FETCHES).fill(null));
    const retry = clients.lookup(CLIENT_ID);
    expect(fetch).toHaveBeenCalledTimes(MAX_CONCURRENT_METADATA_FETCHES + 1);
    gates.at(-1)!(document());
    expect(await retry).not.toBeNull();
  });

  it("fences shutdown, aborts outstanding transport and never caches its late result", async () => {
    let finish!: (value: unknown) => void;
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_url: URL, currentSignal?: AbortSignal) => {
      signal = currentSignal;
      return new Promise<unknown>(resolve => { finish = resolve; });
    });
    const clients = new OAuthMetadataClients(fetch);
    const pending = clients.lookup(CLIENT_ID);
    clients.stop();
    expect(signal?.aborted).toBe(true);
    finish(document());
    expect(await pending).toBeNull();
    expect(await clients.lookup(CLIENT_ID)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
