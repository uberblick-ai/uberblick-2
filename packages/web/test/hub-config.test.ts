// @vitest-environment node
/**
 * Where the client configuration comes from, and what happens when the answer
 * is unusable.
 *
 * Three values travel in one document — the hub endpoint, the workspaces this
 * client offers and the secret it mints tokens with — and the contracts are
 * largely the same for all three:
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
 * - **Freshness.** A cached document keeps a retargeted deployment dialling the
 *   old hub.
 *
 * Remote hosts serve public configuration only. A stale shared signing secret
 * is ignored for non-loopback endpoints; local dev and ub open browser keys
 * retain their loopback path.
 *
 * The fetch itself is a stub: what is defended is the decision, not whether
 * `fetch` works. The Caddy half of the no-store contract is checked against the
 * configuration, because this suite runs in jsdom and serves nothing.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackEndpoint } from "@uberblick/hub/remote-url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { devConfigDocument } from "../dev-config-document.js";
import {
  HUB_CONFIG_PATH,
  configuredWorkspaces,
  endpointLabel,
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
const INJECTED = process.env.HUB_URL ?? "ws://localhost:1234";

/** Two workspaces a served document could name — one decorated, one bare. */
const FIRST = "uberblick-6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const SECOND = "b2d9e4c7-5a13-4f80-8e6b-71c0a9d35f2e";

/** A secret arriving on a *second* read, after the first document missed. */
const LATE_SECRET = "late-arriving-signing-secret";

/**
 * A `fetch` that never answers on its own — a proxy holding the connection
 * open, a captive portal. It rejects only when the caller aborts, which is what
 * a real `fetch` does and what makes this a genuine test of the deadline: drop
 * the signal and this promise is never settled by anything.
 */
function stalling(stage: "headers" | "body"): typeof globalThis.fetch {
  return (async (_input: string, init?: RequestInit) => {
    if (stage === "headers") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("The operation was aborted", "AbortError"));
          });
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
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
 * not what one developer's configuration happens to say.
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
  it("answers the SPA fallback's HTML with a diagnostic and a working fallback, and tries again for a secret it never got", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    // `try_files {path} /index.html` answering an absent document: 200, HTML.
    // Then the same read, after the deployment came up.
    const { fetch, calls } = serving(
      { body: '<!doctype html>\n<html lang="en">' },
      { body: `{"hubUrl":"ws://127.0.0.1:4321","hubAuthToken":"${LATE_SECRET}"}` },
    );

    // The only `resolveClientConfig` calls in this file — it memoises per
    // session, so every other case goes through `readClientConfig`. This is the
    // case worth spending them on: the whole app is downstream of what happens
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

    // And the read is not remembered, because it produced no secret: with the
    // fallback gone (#426) a memoised miss is a tab that can never authenticate
    // for as long as it stays open. `rooms.ts` calls this before every connect
    // attempt, so "not memoised" is what makes the next attempt try again — and
    // the answer it gets is the one now being served.
    const again = await resolveClientConfig(fetch);
    expect(calls).toHaveLength(2);
    expect(again.hubAuthToken).toBe(LATE_SECRET);
    expect(hubUrl()).toBe("ws://127.0.0.1:4321/");
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

  it.each(["headers", "body"] as const)(
    "gives stalled %s a deadline, so a hung request cannot wedge every room",
    async (stage) => {
      // Nothing acquires a room until this settles, so "never settles" is the
      // worst outcome available, worse than dialling a stale address.
      const builtIn = await readClientConfig(serving({ status: 404, body: "not found" }).fetch);
      const config = await readClientConfig(stalling(stage), 20);

      expect(config).toEqual({
        ...builtIn,
        rejected: "it did not answer within 20ms",
      });
    },
  );

  it("distinguishes a fetch failure from an expired deadline", async () => {
    const { hubUrl: url, hubUrlSource, rejected } = await readClientConfig(serving().fetch);

    expect(url).toBe(INJECTED);
    expect(hubUrlSource).toBe("define");
    expect(rejected).toBe("it could not be fetched (Failed to fetch)");
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

  it("keeps loopback keys and ignores stale secrets for every remote endpoint", async () => {
    const carried = await readClientConfig(
      serving({
        body: '{"hubUrl":"wss://hub.example/ws","hubAuthToken":"s3cret"}',
      }).fetch,
    );
    expect(carried.hubAuthToken).toBe("");
    for (const endpoint of ["ws://127.2.3.4:4321", "ws://localhost:4321", "ws://[::1]:4321"]) {
      const local = await readClientConfig(serving({ body: JSON.stringify({
        hubUrl: endpoint, hubAuthToken: "local-key",
      }) }).fetch);
      expect(local.hubAuthToken).toBe("local-key");
    }
    for (const endpoint of ["ws://0.0.0.0:4321", "ws://[::]:4321", "wss://remote.example/ws"]) {
      const remote = await readClientConfig(serving({ body: JSON.stringify({
        hubUrl: endpoint, hubAuthToken: "stale-remote-secret",
      }) }).fetch);
      expect(remote.hubAuthToken).toBe("");
    }

    // A non-string is refused rather than coerced: `String(42)` would be minted
    // with, and a client authenticating with a plausible-looking wrong secret
    // is harder to diagnose than one that says it has none. Every unusable
    // shape lands in the same state as a document that named no secret at all.
    const unusable = {
      "a number": '{"hubUrl":"wss://hub.example/ws","hubAuthToken":42}',
      "an object": '{"hubUrl":"wss://hub.example/ws","hubAuthToken":{"v":"s3cret"}}',
      null: '{"hubUrl":"wss://hub.example/ws","hubAuthToken":null}',
      absent: '{"hubUrl":"wss://hub.example/ws"}',
    };
    for (const [kind, body] of Object.entries(unusable)) {
      const config = await readClientConfig(serving({ body }).fetch);
      expect(config.hubAuthToken, kind).toBe("");
      // …and the endpoint survives it: the keys fail independently here too.
      expect(config.hubUrl, kind).toBe("wss://hub.example/ws");
      expect(JSON.stringify(config), kind).not.toContain("s3cret");
    }
  });

  it("keeps the development key when an unbound checkout uses its compiled loopback endpoint", async () => {
    // Plain ub init stores no hub binding. ub env supplies its signing key,
    // while the dev server's document names no endpoint and the bundle falls
    // back to its compiled value.
    const config = await readClientConfig(serving({
      body: devConfigDocument({ HUB_AUTH_TOKEN: "dev-secret" }),
    }).fetch);
    expect(config.hubUrl).toBe(INJECTED);
    expect(config.hubUrlSource).toBe("define");
    expect(config.hubAuthToken).toBe(isLoopbackEndpoint(INJECTED) ? "dev-secret" : "");
  });
});

describe("the local-serving diagnostic", () => {
  it("keeps development and ub open on their local admission path without a key", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const document of [
      { hubUrl: "ws://localhost:1234", workspaces: [FIRST] },
      { hubUrl: "ws://127.0.0.1:4321", workspaces: [FIRST], remoteHubUrl: "wss://remote.example/ws" },
      { hubUrl: "ws://127.0.0.1:4321", workspaces: [], remoteHubUrl: "wss://remote.example/ws" },
    ]) {
      // Each case represents a new page, with its own resolved configuration.
      vi.resetModules();
      const config = await import("../src/config.js");
      await config.resolveClientConfig(serving({ body: JSON.stringify(document) }).fetch);
      expect(config.hubAuthToken()).toBe("");
      expect(config.browserSignInRequired()).toBe(false);
    }
  });

  it("keeps the frozen workspace/upstream pair and accepts only a literal rebound", async () => {
    const servingDocument = (rebound: unknown, remote = true): string =>
      JSON.stringify({
        hubUrl: "ws://127.0.0.1:4321",
        workspaces: [FIRST],
        ...(remote ? { remoteHubUrl: "wss://remote.example/ws" } : {}),
        ...(rebound === undefined ? {} : { rebound }),
      });

    const rebound = await readClientConfig(
      serving({ body: servingDocument(true) }).fetch,
    );
    expect(rebound.localServing).toEqual({
      workspace: FIRST,
      remoteHubUrl: "wss://remote.example/ws",
      rebound: true,
    });

    for (const value of [undefined, false, "true", 1]) {
      const config = await readClientConfig(
        serving({ body: servingDocument(value) }).fetch,
      );
      expect(config.localServing?.rebound, String(value)).toBe(false);
    }

    const direct = await readClientConfig(
      serving({ body: servingDocument(true, false) }).fetch,
    );
    expect(direct.localServing).toBeNull();
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

  it("refuses a document that plainly names a key twice, rather than taking the last one", async () => {
    // Defence in depth, not the guarantee. The deployed document is a template
    // with values substituted into it, so a value carrying a quote could close
    // its string and append a second `hubUrl` — and `JSON.parse` keeps the last
    // occurrence, pointing every browser at a hub of somebody else's choosing.
    // What makes that impossible is `bin/remote-compose.sh` refusing any value that
    // could close a string; this pins the client's own best-effort refusal of
    // the plainly spelled case. It reads raw JSON spelling, so an escaped key
    // would pass — which is not worth a tokenizer, because writing escapes into
    // the served document already means being able to set `hubUrl` outright.
    const injected =
      '{"hubUrl":"wss://hub.example/ws","workspaces":"' +
      `${FIRST}","hubUrl":"wss://elsewhere.example/ws"}`;

    const config = await readClientConfig(serving({ body: injected }).fetch);

    expect(config.hubUrl).toBe(INJECTED);
    expect(config.hubUrlSource).toBe("define");
    expect(config.workspaces).toEqual(await builtInWorkspaces());
    expect(config.rejected).toContain("names hubUrl more than once");

    // The secret's key is covered too: a second one would be the credential
    // every client mints with, chosen by whoever wrote it.
    const twice = await readClientConfig(
      serving({
        body: '{"hubUrl":"wss://hub.example/ws","hubAuthToken":"first","hubAuthToken":"second"}',
      }).fetch,
    );
    expect(twice.hubAuthToken).toBe("");
    expect(twice.rejected).toContain("names hubAuthToken more than once");
  });

  it("does not mistake key-like text inside the secret for a second key", async () => {
    // The other direction, and the one that would break a working deployment:
    // the secret is opaque, so its own characters must never make the document
    // unreadable. A real key's quote follows `{` or `,`; inside a JSON string a
    // quote is written `\"`, so the two cannot be confused — and every value
    // here is a legitimate secret that happens to read like a document.
    const secrets = [
      'a","hubUrl":"wss://elsewhere.example/ws',
      '{"hubAuthToken": "nested"}',
      '"workspaces":',
    ];

    for (const secret of secrets) {
      const config = await readClientConfig(
        serving({
          body: JSON.stringify({
            hubUrl: "ws://127.0.0.1:4321",
            workspaces: [FIRST],
            hubAuthToken: secret,
          }),
        }).fetch,
      );
      expect(config.hubAuthToken, secret).toBe(secret);
      expect(config.hubUrl, secret).toBe("ws://127.0.0.1:4321/");
      expect(config.rejected, secret).toBeUndefined();
    }
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

    // An entry that is not even a string counts too. Reporting zero rejected
    // for a list that dropped one is the diagnostic lying about the only thing
    // it is for.
    const mixed = await readClientConfig(
      serving({
        body: JSON.stringify({ hubUrl: "wss://hub.example/ws", workspaces: [FIRST, 42] }),
      }).fetch,
    );
    expect(mixed.workspaces).toEqual([FIRST]);
    expect(mixed.rejected).toContain("1 of its workspaces is not a workspace id");
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

/**
 * What the UI is allowed to *say* about the endpoint (#362).
 *
 * The surfaces that assert sync state now name the hub, so the label they name
 * it with is the one place a credential could reach a screen. `usableEndpoint`
 * already refuses userinfo in the served document — but the build-time defines
 * are not validated at all, and a `HUB_URL` set to a credential-bearing address
 * would otherwise be rendered verbatim in the panel and in the pill's tooltip.
 */
describe("the endpoint as it is shown", () => {
  it("renders the address alone, whatever the configured value carried", () => {
    // Every way a secret can ride in a URL. The label is rebuilt from the
    // parsed parts, so none of them has anywhere to survive.
    expect(endpointLabel("wss://agent:s3cret@hub.example/ws")).toBe(
      "wss://hub.example/ws",
    );
    expect(endpointLabel("wss://hub.example/ws?token=s3cret")).toBe(
      "wss://hub.example/ws",
    );
    expect(endpointLabel("wss://hub.example/ws#s3cret")).toBe(
      "wss://hub.example/ws",
    );
    // An ordinary path is left as it reads, while the `/` `new URL` adds to a
    // bare host is dropped rather than shown as a path.
    expect(endpointLabel("wss://hub.example/ws")).toBe("wss://hub.example/ws");
    expect(endpointLabel("ws://localhost:1234")).toBe("ws://localhost:1234");
    // Nothing at all rather than a best effort: a string this cannot take
    // apart is one it cannot promise carries no credential — and an opaque
    // scheme is exactly that, since `new URL` leaves its whole payload in
    // `pathname` with no host to rebuild the address from.
    expect(endpointLabel("hub.example/ws")).toBeNull();
    expect(endpointLabel("mailto:agent:s3cret@hub.example")).toBeNull();
    expect(endpointLabel("https://hub.example/ws")).toBeNull();
  });
});

describe("the deployments that serve it", () => {
  it("serves the document uncached, ahead of the SPA fallback, from run-time config", () => {
    const caddyfile = readFileSync(resolve(repoRoot, "Caddyfile"), "utf8");
    const configRoute = caddyfile.indexOf(`handle ${HUB_CONFIG_PATH}`);
    const spaFallback = caddyfile.indexOf("try_files {path} /index.html");

    expect(configRoute).toBeGreaterThan(-1);
    expect(spaFallback).toBeGreaterThan(configRoute);
    expect(caddyfile).toContain('header Cache-Control "no-store"');
    // The served body: the agreed shape, with all three values substituted at
    // run time — so retargeting the client, giving it its workspaces or
    // rotating the secret is not a bundle rebuild.
    expect(caddyfile).toContain(
      'respond `{"hubUrl":"{$HUB_URL}","workspaces":"{$WORKSPACES}"}`',
    );

    // Both the wrapper and the image use the same guard. Plain Compose passes
    // native operator names; the container validates before aliasing them into
    // the Caddyfile, so it cannot bypass the wrapper's alphabets.
    const compose = readFileSync(resolve(repoRoot, "compose.release.yml"), "utf8");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Compose expression
    expect(compose).toContain('WEB_HUB_URL: "${WEB_HUB_URL:-}"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Compose expression
    expect(compose).toContain('WEB_WORKSPACES: "${WEB_WORKSPACES:-}"');
    expect(compose).not.toContain("HUB_AUTH_TOKEN:");
    expect(readFileSync(resolve(repoRoot, "remote.env.example"), "utf8")).toContain(
      "WEB_WORKSPACES=",
    );
    const guard = readFileSync(resolve(repoRoot, "remote-settings.sh"), "utf8");
    expect(guard).toContain("WEB_WORKSPACES");
    expect(guard).toContain("*[!A-Za-z0-9,-]*)");
    expect(guard).not.toContain("HUB_AUTH_TOKEN");

    // The dev server answers the same path from one middleware, out of the
    // environment `ub env` resolves — `mise run web`, `mise run dev`, the e2e
    // harness and the first-user proof all read this. Repeating the default
    // workspace in `WORKSPACES` is the ordinary configuration, and the menu
    // must not show it twice.
    expect(
      JSON.parse(
        devConfigDocument({
          HUB_URL: "ws://127.0.0.1:4321",
          HUB_AUTH_TOKEN: "dev-secret",
          WORKSPACE_ID: FIRST,
          WORKSPACES: `${FIRST},${SECOND}`,
        }),
      ),
    ).toEqual({
      hubUrl: "ws://127.0.0.1:4321",
      workspaces: [FIRST, SECOND],
      hubAuthToken: "dev-secret",
    });
    // Vite copies `public/` verbatim, and a file there would win over the
    // middleware while carrying whatever the checkout was last configured with.
    expect(() =>
      readFileSync(resolve(webRoot, `public${HUB_CONFIG_PATH}`)),
    ).toThrow();
  });

  it("refuses an endpoint that could inject into the document, before it calls Docker", () => {
    // The endpoint reaches the same JSON string the workspaces and the secret
    // do — by `WEB_HUB_URL`, or through the `wss://<host>/ws` default built
    // from `TAILSCALE_HOST` — so it needs the same guarantee. Run rather than
    // read: the *order* is the second half of the contract, and a file cannot
    // show it. A host without Docker must be told about its `.env`, not about
    // the daemon.
    //
    // PATH is an empty directory, which is the proof of that order: nothing
    // external is reachable, `docker` included, and the refusal still arrives.
    // The cwd has only release metadata, so no developer's own `.env` is
    // sourced over these, and the wrapper accepts it as a release directory.
    const injecting = {
      WEB_HUB_URL: 'wss://ok.example.ts.net/ws","hubUrl":"wss://elsewhere',
      TAILSCALE_HOST: 'ok.example.ts.net","hubUrl":"wss://elsewhere',
    };
    const empty = mkdtempSync(join(tmpdir(), `uberblick-${process.env.UB_AGENTS_RUN ?? "test"}-wrapper-`));
    try {
      writeFileSync(join(empty, "release.json"), "{}\n");
      for (const [name, value] of Object.entries(injecting)) {
        const run = spawnSync(
          "/bin/sh",
          [resolve(repoRoot, "bin/remote-compose.sh"), "config"],
          {
            cwd: empty,
            env: { PATH: empty, [name]: value },
            encoding: "utf8",
          },
        );

        expect(run.status, name).toBe(1);
        expect(run.stderr, name).toContain(`${name} may only contain`);
        expect(run.stdout, name).toBe("");
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
