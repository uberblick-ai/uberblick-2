/**
 * Where the client configuration comes from, and what happens when the answer
 * is unusable.
 *
 * Two values travel in one document — the hub endpoint and the workspaces this
 * client offers — and the contracts are the same for both:
 *
 * - **Precedence, and saying which source won.** A bundle nobody can rebuild
 *   has no other way to be retargeted or to be told which workspaces exist, and
 *   a fallback nobody announces makes a misconfigured client look like an
 *   offline hub — or like a deployment that was never given a workspace.
 * - **One fallback behaviour, never a crash.** Under the SPA fallback (#68) an
 *   absent document arrives as 200-with-HTML, so "missing" and "wrong shape"
 *   are the same observation in production. Both must land the client on a
 *   working endpoint with one diagnostic.
 * - **The keys fail independently.** A deployment that serves an endpoint but
 *   no workspaces is an ordinary deployment: it must keep its endpoint, and
 *   deep links must keep working — only `/` and the switcher degrade.
 * - **Freshness, and nothing but configuration.** A cached document keeps a
 *   retargeted deployment dialling the old hub; a document that could carry
 *   more than this would become the credential channel #84 exists to close.
 *
 * The fetch itself is a stub: what is defended is the decision, not whether
 * `fetch` works. The Caddy half of the no-store contract is checked against the
 * configuration, because this suite runs in jsdom and serves nothing.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HUB_CONFIG_PATH,
  configuredWorkspaces,
  hubUrl,
  readClientConfig,
  resolveClientConfig,
} from "../src/config.js";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "../..");

/**
 * The value `vite.config.ts` injects, which is what the dev server, `pnpm test`
 * and a default build all see. Named rather than repeated so these tests read
 * as being about precedence rather than about one address.
 */
const INJECTED = "ws://localhost:1234";

/** Two workspaces a served document could name — one decorated, one bare. */
const FIRST = "uberblick-6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const SECOND = "b2d9e4c7-5a13-4f80-8e6b-71c0a9d35f2e";

/**
 * A `fetch` that never answers on its own — a proxy holding the connection
 * open, a captive portal. It rejects only when the caller aborts, which is what
 * a real `fetch` does and what makes this a genuine test of the deadline: drop
 * the signal and this promise is never settled by anything.
 */
function stalling(): typeof globalThis.fetch {
  return (async (_input: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      });
    })) as unknown as typeof globalThis.fetch;
}

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

/**
 * The workspaces this build carries, read back through the module rather than
 * restated here.
 *
 * `WORKSPACE_ID` and `WORKSPACES` come from the environment vite was started
 * in, and a contributor's machine has its own ids. What these tests pin is the
 * precedence — that every unusable answer lands on the *same* built-in list —
 * not what one developer's `mise.local.toml` happens to say.
 */
async function builtInWorkspaces(): Promise<readonly string[]> {
  const { workspaces } = await readClientConfig(
    serving({ status: 404, body: "not found" }).fetch,
  );
  return workspaces;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the served configuration", () => {
  it("answers the SPA fallback's HTML with a diagnostic and a working fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // `try_files {path} /index.html` answering an absent document: 200, HTML.
    const { fetch } = serving({ body: '<!doctype html>\n<html lang="en">' });

    // The one `resolveClientConfig` call in this file — it memoises per
    // session, so every other case goes through `readClientConfig`. This is the
    // case worth spending it on: the whole app is downstream of what happens
    // here.
    const config = await resolveClientConfig(fetch);

    // Never a parse crash, and never a client left with no hub at all.
    expect(config.hubUrl).toBe(INJECTED);
    expect(config.hubUrlSource).toBe("define");
    expect(config.workspacesSource).toBe("define");
    // The accessors the app reads: the one `rooms.ts` builds the socket from,
    // and the one that answers `/` and fills the switcher.
    expect(hubUrl()).toBe(INJECTED);
    expect(configuredWorkspaces()).toEqual(await builtInWorkspaces());

    // One diagnostic, naming the sources in force and why the document was not
    // used. Without it a misconfigured client just looks like an offline hub.
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain(`hub ${INJECTED} (source: define)`);
    expect(message).toContain("workspaces");
    expect(message).toContain("(source: define)");
    expect(message).toContain(`${HUB_CONFIG_PATH} unused`);
    expect(message).toContain("not JSON");

    // …and not one byte of what came back. A misroute can answer with an
    // upstream error page or another service's secret, and a diagnostic that
    // quoted it would copy that into the console and every log that collects
    // one. The content type says "HTML" without repeating any of it.
    expect(message).not.toContain("<!doctype");
    expect(message).not.toContain("<html");
    expect(message).toContain("text/plain");
  });

  it("refuses a hubUrl that is not a bare ws(s) address, without echoing it", async () => {
    const unusable = {
      "wrong scheme": "https://hub.example/ws",
      "not a URL": "hub.example/ws",
      whitespace: "   ",
      userinfo: "wss://agent:s3cret@hub.example/ws",
      "query credential": "wss://hub.example/ws?token=s3cret",
      fragment: "wss://hub.example/ws#s3cret",
    };

    for (const [kind, value] of Object.entries(unusable)) {
      const { fetch } = serving({ body: JSON.stringify({ hubUrl: value }) });
      const { hubUrl: url, hubUrlSource, rejected } = await readClientConfig(fetch);

      // The same unified fallback, not a `source: "document"` the socket would
      // then throw on.
      expect(url, kind).toBe(INJECTED);
      expect(hubUrlSource, kind).toBe("define");
      expect(rejected, kind).toMatch(/hubUrl (is not|carries)/);
      // The values most worth naming are the ones that might carry a secret,
      // so none of the value reaches the diagnostic — not the credential, not
      // even the host it was pointed at.
      expect(rejected, kind).not.toContain("s3cret");
      expect(rejected, kind).not.toContain("hub.example");
    }
  });

  it("gives the read a deadline, so a hung request cannot wedge every room", async () => {
    // Nothing acquires a room until this settles — not even the IndexedDB-backed
    // rooms that need no hub at all — so "never settles" is the worst outcome
    // available, worse than dialling a stale address.
    const { hubUrl: url, hubUrlSource, workspaces, rejected } = await readClientConfig(
      stalling(),
      20,
    );

    expect(url).toBe(INJECTED);
    expect(hubUrlSource).toBe("define");
    expect(workspaces).toEqual(await builtInWorkspaces());
    expect(rejected).toContain("did not answer within 20ms");
  });

  it("supplies the endpoint when the document names one, and falls back the same way for every response it cannot use", async () => {
    const named = await readClientConfig(
      serving({ body: '{"hubUrl":"wss://hub.example/ws"}' }).fetch,
    );
    expect(named.hubUrl).toBe("wss://hub.example/ws");
    expect(named.hubUrlSource).toBe("document");

    // One behaviour, not four: a non-200, a non-JSON body, JSON without a
    // string `hubUrl`, and an origin that cannot be reached all land here.
    const unusable = {
      "not found": serving({ status: 404, body: "not found" }).fetch,
      "wrong shape": serving({ body: '{"hub":"wss://hub.example/ws"}' }).fetch,
      "hubUrl not a string": serving({ body: '{"hubUrl":42}' }).fetch,
      unreachable: serving().fetch,
    };
    for (const [kind, fetch] of Object.entries(unusable)) {
      const { hubUrl: url, hubUrlSource, rejected } = await readClientConfig(fetch);
      expect(url, kind).toBe(INJECTED);
      expect(hubUrlSource, kind).toBe("define");
      expect(rejected, kind).toBeTypeOf("string");
    }
  });

  it("is re-read uncached, so a changed endpoint takes effect on the next load", async () => {
    const { fetch, calls } = serving(
      { body: '{"hubUrl":"wss://old.example/ws"}' },
      { body: '{"hubUrl":"wss://new.example/ws"}' },
    );

    const first = await readClientConfig(fetch);
    const second = await readClientConfig(fetch);

    expect(first.hubUrl).toBe("wss://old.example/ws");
    expect(second.hubUrl).toBe("wss://new.example/ws");
    for (const call of calls) expect(call.cache).toBe("no-store");
  });

  it("takes configuration and nothing else, so no credential can ride along", async () => {
    const { fetch } = serving({
      body: '{"hubUrl":"wss://hub.example/ws","hubAuthToken":"s3cret"}',
    });

    const config = await readClientConfig(fetch);

    // The extra key is ignored, not adopted and not fatal — and there is no
    // field it could have reached (#84 owns the secret still in the bundle).
    expect(config.hubUrl).toBe("wss://hub.example/ws");
    expect(JSON.stringify(config)).not.toContain("s3cret");
  });
});

describe("the workspaces it names", () => {
  it("takes them in the order listed — the first is the one `/` opens", async () => {
    const { workspaces, workspacesSource, rejected } = await readClientConfig(
      serving({
        body: JSON.stringify({ hubUrl: "wss://hub.example/ws", workspaces: [FIRST, SECOND] }),
      }).fetch,
    );

    expect(workspaces).toEqual([FIRST, SECOND]);
    expect(workspacesSource).toBe("document");
    expect(rejected).toBeUndefined();
  });

  it("reads one comma-separated string as the same list", async () => {
    // The deployed document is a Caddy `respond` with an environment variable
    // substituted into it (see the Caddyfile), and an operator's `.env` holds
    // `a,b`. Refusing that spelling would put JSON quoting rules into a dotenv
    // file for no gain.
    const { workspaces, workspacesSource } = await readClientConfig(
      serving({
        body: JSON.stringify({
          hubUrl: "wss://hub.example/ws",
          workspaces: ` ${FIRST} , ${SECOND} `,
        }),
      }).fetch,
    );

    expect(workspaces).toEqual([FIRST, SECOND]);
    expect(workspacesSource).toBe("document");
  });

  it("drops an entry that is not a workspace id, and counts it in the diagnostic", async () => {
    // A menu item that navigates to the invalid-link screen reads as a broken
    // workspace, so it is not offered — but a deployment whose list is half
    // typos has to be able to find that out from the console.
    const { workspaces, workspacesSource, rejected } = await readClientConfig(
      serving({
        body: JSON.stringify({
          hubUrl: "wss://hub.example/ws",
          workspaces: ["main", FIRST, "not-a-uuid"],
        }),
      }).fetch,
    );

    expect(workspaces).toEqual([FIRST]);
    expect(workspacesSource).toBe("document");
    expect(rejected).toContain("2 of its workspaces");
    // Not a syllable of the offending values: this document is the one place a
    // value must never be echoed, and the rule does not get a workspace-shaped
    // exception.
    expect(rejected).not.toContain("not-a-uuid");
  });

  it("keeps the endpoint when it lists no usable workspace, and falls back only for the menu", async () => {
    // The acceptance criterion this defends: a config document without
    // `workspaces` leaves deep links working — only `/` and the switcher
    // degrade to what the build carries.
    const built = await builtInWorkspaces();
    const unusable = {
      absent: '{"hubUrl":"wss://hub.example/ws"}',
      empty: '{"hubUrl":"wss://hub.example/ws","workspaces":[]}',
      "empty string": '{"hubUrl":"wss://hub.example/ws","workspaces":""}',
      "all typos": '{"hubUrl":"wss://hub.example/ws","workspaces":["main"]}',
      "wrong type": '{"hubUrl":"wss://hub.example/ws","workspaces":42}',
    };

    for (const [kind, body] of Object.entries(unusable)) {
      const config = await readClientConfig(serving({ body }).fetch);
      expect(config.hubUrl, kind).toBe("wss://hub.example/ws");
      expect(config.hubUrlSource, kind).toBe("document");
      expect(config.workspaces, kind).toEqual(built);
      expect(config.workspacesSource, kind).toBe("define");
      expect(config.rejected, kind).toBeTypeOf("string");
    }
  });
});

describe("the deployments that serve it", () => {
  it("leaves `mise run dev` with no configuration document at all", () => {
    // Vite copies `public/` verbatim, so a file there would be served by the
    // dev server too — and the dev server is the one place the injected
    // `define`s must remain the whole answer.
    expect(() =>
      readFileSync(resolve(webRoot, `public${HUB_CONFIG_PATH}`)),
    ).toThrow();
    const viteConfig = readFileSync(resolve(webRoot, "vite.config.ts"), "utf8");
    expect(viteConfig).toContain("__HUB_URL__");
    expect(viteConfig).toContain("__WORKSPACE_ID__");
  });

  it("serves the document uncached, ahead of the SPA fallback, from run-time config", () => {
    const caddyfile = readFileSync(resolve(repoRoot, "Caddyfile"), "utf8");
    const configRoute = caddyfile.indexOf(`handle ${HUB_CONFIG_PATH}`);
    const spaFallback = caddyfile.indexOf("try_files {path} /index.html");

    expect(configRoute).toBeGreaterThan(-1);
    expect(spaFallback).toBeGreaterThan(configRoute);
    expect(caddyfile).toContain('header Cache-Control "no-store"');
    // The served body: the agreed shape, with both values substituted at run
    // time — so retargeting the client, or giving it its workspaces, is not a
    // bundle rebuild.
    expect(caddyfile).toContain(
      'respond `{"hubUrl":"{$HUB_URL}","workspaces":"{$WORKSPACES}"}`',
    );

    // Both are host-side `.env` values, renamed on the way in for the same
    // reason: the undecorated names already mean "what my local tools use".
    const compose = readFileSync(resolve(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).toContain('HUB_URL: "${WEB_HUB_URL:-wss://');
    expect(compose).toContain('WORKSPACES: "${WEB_WORKSPACES');
    expect(readFileSync(resolve(repoRoot, "remote.env.example"), "utf8")).toContain(
      "WEB_WORKSPACES=",
    );
  });
});
