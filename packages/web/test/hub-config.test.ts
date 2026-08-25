/**
 * Where the hub endpoint comes from, and what happens when the answer is
 * unusable.
 *
 * Three contracts, one per way this can hurt someone:
 *
 * - **Precedence, and saying which source won.** A bundle nobody can rebuild
 *   has no other way to be retargeted, and a fallback nobody announces makes a
 *   misconfigured client look like an offline hub.
 * - **One fallback behaviour, never a crash.** Under the SPA fallback (#68) an
 *   absent document arrives as 200-with-HTML, so "missing" and "wrong shape"
 *   are the same observation in production. Both must land the client on a
 *   working endpoint with one diagnostic.
 * - **Freshness, and nothing but the endpoint.** A cached document keeps a
 *   retargeted deployment dialling the old hub; a document that could carry
 *   more than `hubUrl` would become the credential channel #84 exists to close.
 *
 * The fetch itself is a stub: what is defended is the decision, not whether
 * `fetch` works. The Caddy half of the no-store contract is checked against the
 * configuration, because this suite runs in jsdom and serves nothing.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HUB_CONFIG_PATH, hubUrl, readHubUrl, resolveHubUrl } from "../src/config.js";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "../..");

/**
 * The value `vite.config.ts` injects, which is what the dev server, `pnpm test`
 * and a default build all see. Named rather than repeated so these tests read
 * as being about precedence rather than about one address.
 */
const INJECTED = "ws://localhost:1234";

/** A stub `fetch` for `HUB_CONFIG_PATH`, answering from a queue of responses. */
function serving(...answers: Array<{ status?: number; body: string }>): {
  fetch: typeof globalThis.fetch;
  calls: RequestInit[];
} {
  const calls: RequestInit[] = [];
  const queue = [...answers];
  const fetch = (async (input: string, init?: RequestInit) => {
    expect(input).toBe(HUB_CONFIG_PATH);
    calls.push(init ?? {});
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    // No answers at all stands for an origin that cannot be reached.
    if (answer === undefined) throw new TypeError("Failed to fetch");
    return new Response(answer.body, { status: answer.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the served hub configuration", () => {
  it("answers the SPA fallback's HTML with a diagnostic and a working fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // `try_files {path} /index.html` answering an absent document: 200, HTML.
    const { fetch } = serving({ body: '<!doctype html>\n<html lang="en">' });

    // The one `resolveHubUrl` call in this file — it memoises per session, so
    // every other case goes through `readHubUrl`. This is the case worth
    // spending it on: the whole app is downstream of what happens here.
    const resolution = await resolveHubUrl(fetch);

    // Never a parse crash, and never a client left with no hub at all.
    expect(resolution).toEqual({ url: INJECTED, source: "define" });
    // The accessor `rooms.ts` reads when it builds the shared websocket.
    expect(hubUrl()).toBe(INJECTED);

    // One diagnostic, naming the source in force and why the document was not
    // used. Without it a misconfigured client just looks like an offline hub.
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain(`hub ${INJECTED} (source: define)`);
    expect(message).toContain(`${HUB_CONFIG_PATH} unused`);
    expect(message).toContain("not JSON");
  });

  it("supplies the endpoint when the document names one, and falls back the same way for every response it cannot use", async () => {
    await expect(
      readHubUrl(serving({ body: '{"hubUrl":"wss://hub.example/ws"}' }).fetch),
    ).resolves.toEqual({ url: "wss://hub.example/ws", source: "document" });

    // One behaviour, not four: a non-200, a non-JSON body, JSON without a
    // string `hubUrl`, and an origin that cannot be reached all land here.
    const unusable = {
      "not found": serving({ status: 404, body: "not found" }).fetch,
      "wrong shape": serving({ body: '{"hub":"wss://hub.example/ws"}' }).fetch,
      "hubUrl not a string": serving({ body: '{"hubUrl":42}' }).fetch,
      unreachable: serving().fetch,
    };
    for (const [kind, fetch] of Object.entries(unusable)) {
      const { url, source, rejected } = await readHubUrl(fetch);
      expect(url, kind).toBe(INJECTED);
      expect(source, kind).toBe("define");
      expect(rejected, kind).toBeTypeOf("string");
    }
  });

  it("is re-read uncached, so a changed endpoint takes effect on the next load", async () => {
    const { fetch, calls } = serving(
      { body: '{"hubUrl":"wss://old.example/ws"}' },
      { body: '{"hubUrl":"wss://new.example/ws"}' },
    );

    const first = await readHubUrl(fetch);
    const second = await readHubUrl(fetch);

    expect(first.url).toBe("wss://old.example/ws");
    expect(second.url).toBe("wss://new.example/ws");
    for (const call of calls) expect(call.cache).toBe("no-store");
  });

  it("takes the endpoint and nothing else, so no credential can ride along", async () => {
    const { fetch } = serving({
      body: '{"hubUrl":"wss://hub.example/ws","hubAuthToken":"s3cret"}',
    });

    const resolution = await readHubUrl(fetch);

    // The extra key is ignored, not adopted and not fatal — and there is no
    // field it could have reached (#84 owns the secret still in the bundle).
    expect(resolution).toEqual({ url: "wss://hub.example/ws", source: "document" });
    expect(JSON.stringify(resolution)).not.toContain("s3cret");
  });
});

describe("the deployments that serve it", () => {
  it("leaves `mise run dev` with no configuration document at all", () => {
    // Vite copies `public/` verbatim, so a file there would be served by the
    // dev server too — and the dev server is the one place the injected
    // `define` must remain the whole answer.
    expect(() =>
      readFileSync(resolve(webRoot, `public${HUB_CONFIG_PATH}`)),
    ).toThrow();
    expect(
      readFileSync(resolve(webRoot, "vite.config.ts"), "utf8"),
    ).toContain("__HUB_URL__");
  });

  it("serves the document uncached, ahead of the SPA fallback, from run-time config", () => {
    const caddyfile = readFileSync(resolve(repoRoot, "Caddyfile"), "utf8");
    const configRoute = caddyfile.indexOf(`handle ${HUB_CONFIG_PATH}`);
    const spaFallback = caddyfile.indexOf("try_files {path} /index.html");

    expect(configRoute).toBeGreaterThan(-1);
    expect(spaFallback).toBeGreaterThan(configRoute);
    expect(caddyfile).toContain('header Cache-Control "no-store"');
    // The served body: the agreed shape, with the endpoint substituted at run
    // time — so retargeting the client is not a bundle rebuild.
    expect(caddyfile).toContain('respond `{"hubUrl":"{$HUB_URL}"}`');

    const compose = readFileSync(resolve(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).toContain('HUB_URL: "${WEB_HUB_URL:-wss://');
  });
});
