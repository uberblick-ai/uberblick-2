/**
 * `ub open` — one test per acceptance criterion of #97.
 *
 * The world is real here, as it is in the `ub doctor` suite: a real hub on an
 * ephemeral port for "a hub is already answering", a real foreign listener for
 * "the port is taken", real HTTP requests against the served bundle, and a real
 * SIGINT to end the foreground. Nothing here calls {@link runUb}: `spawnSync`
 * blocks this process's event loop (#154), so a `ub open` child probing a hub
 * *this* process is serving would find it unreachable and every assertion would
 * be about the blockage rather than about the command.
 *
 * The bundle is a fixture rather than a real `vite build`: `UBERBLICK_WEB_DIST`
 * is the seam `ub open` reads, and what these tests are about is what gets
 * served, not what Vite emits.
 *
 * The criteria that need a live upstream hub are in `open-remote.test.ts`, the
 * ones about the hub and ports this command owns in `open-ports.test.ts`, and
 * the fixtures all three share in `open-fixtures.ts`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_TOKEN_LIFETIME_SECONDS } from "@uberblick/hub";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { localBrowserKey } from "../src/browser-key.js";
import { acquireInitLock } from "../src/init-lock.js";
import { bundlePlan, ensureBundle } from "../src/open.js";
import { probePort } from "../src/probes.js";
import { pointAt, runUbAsync, sandbox, sleep, waitUntil } from "./helpers.js";
import {
  BANNER,
  BUILD_STAMP,
  FIRST_REMOTE,
  REBOUND_SECRET,
  REBOUND_WORKSPACE,
  REPO_ROOT,
  SECOND_REMOTE,
  SECRET,
  WORKSPACE,
  anotherRunBuilding,
  authMessage,
  bearer,
  browserRecorder,
  calm,
  cleanUp,
  configDir,
  configured,
  fakeMise,
  fakeTool,
  fixtureBundle,
  forgedAuthMessage,
  freePort,
  get,
  getWithHost,
  open,
  openFails,
  rebind,
  servingDocumentOf,
  stamp,
  stderrIo,
  stoppable,
  writeBinding,
  writeCredentials,
} from "./open-fixtures.js";

afterEach(cleanUp);

describe("ub open", () => {
  it("serves the local browser endpoint and names the configured upstream", async () => {
    const { box, env } = configured();
    const remote = "wss://hub.example.ts.net/ws";
    pointAt(box, remote);

    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);

    // Byte-exact: the path and the shape are #91's contract, and the web
    // client's fallback is silent enough that a wrong document looks like an
    // offline hub rather than a misconfiguration. Its independent key admits
    // the page only to the local server, never to the upstream hub.
    const document = await get(`${app.url}uberblick-config.json`);
    expect(await document.text()).toBe(
      servingDocumentOf(app.url, remote, WORKSPACE, localBrowserKey(WORKSPACE, box.env)),
    );
    expect(app.stdout()).toContain("remote — nothing started here");

    expect((await app.interrupt()).status).toBe(0);
  });

  it("admits API requests exactly through the served workspace token boundary", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    const app = await open(box, ["--port", String(await freePort())], env);
    const now = Math.floor(Date.now() / 1_000);
    const valid = await authMessage(localBrowserKey(WORKSPACE, box.env));
    const refused: { name: string; auth?: string; suffix?: string }[] = [
      { name: "missing" },
      { name: "hub signing secret", auth: await authMessage(SECRET) },
      { name: "malformed", auth: "not-an-envelope" },
      { name: "bad signature", auth: await authMessage(localBrowserKey(WORKSPACE, box.env), "read-only", { secret: "wrong" }) },
      {
        name: "protocol mismatch",
        auth: await authMessage(localBrowserKey(WORKSPACE, box.env), "read-only", {
          protocolVersion: SYNC_PROTOCOL_VERSION + 1,
        }),
      },
      {
        name: "other workspace",
        auth: await authMessage(localBrowserKey(WORKSPACE, box.env), "read-only", { workspace: REBOUND_WORKSPACE }),
      },
      {
        name: "lifetime beyond the ceiling",
        auth: await forgedAuthMessage(localBrowserKey(WORKSPACE, box.env), {
          typ: "room",
          sub: "compromised-minter",
          workspace: WORKSPACE,
          scope: "read-only",
          kid: null,
          iat: now,
          exp: now + MAX_TOKEN_LIFETIME_SECONDS + 1,
        }),
      },
      {
        name: "token in query",
        auth: valid,
        suffix: `&token=${encodeURIComponent(valid)}`,
      },
    ];

    try {
      for (const sample of refused) {
        const paths = [
          `api/search?q=nothing${sample.suffix ?? ""}`,
          `api/status${sample.suffix?.replace(/^&/, "?") ?? ""}`,
        ];
        for (const path of paths) {
          const response = await fetch(
            `${app.url}${path}`,
            sample.auth === undefined
              ? undefined
              : { headers: bearer(sample.auth) },
          );
          expect(response.status, `${sample.name}: ${path}`).toBe(401);
          expect(response.headers.get("cache-control"), `${sample.name}: ${path}`)
            .toBe("no-store");
          expect(
            response.headers.get("access-control-allow-origin"),
            `${sample.name}: ${path}`,
          ).toBeNull();
        }
      }

      const unknown = await fetch(`${app.url}api/unknown`, {
        headers: bearer(valid),
      });
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get("cache-control")).toBe("no-store");
      expect(unknown.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      expect((await app.interrupt()).status).toBe(0);
    }
  });

  // --- #758: serving freezes the startup binding and reports rebound ----------

  it("freezes the serving binding and marks a later machine rebind", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);
    const url = `${app.url}uberblick-config.json`;

    const before = await get(url);
    expect(before.headers.get("cache-control")).toBe("no-store");
    expect(await before.text()).toBe(
      servingDocumentOf(app.url, FIRST_REMOTE, WORKSPACE, localBrowserKey(WORKSPACE, box.env)),
    );

    // `ub workspace join` completes while this `ub open` keeps running.
    rebind(box, {
      hubUrl: SECOND_REMOTE,
      workspace: REBOUND_WORKSPACE,
      signingSecret: REBOUND_SECRET,
    });

    // The live engine keeps its startup identity. A reload is told that the
    // machine moved underneath it, without silently retargeting the replica.
    expect(await (await get(url)).text()).toBe(
      servingDocumentOf(app.url, FIRST_REMOTE, WORKSPACE, localBrowserKey(WORKSPACE, box.env), true),
    );

    expect((await app.interrupt()).status).toBe(0);

    const restarted = await open(box, ["--port", String(webPort)], env);
    expect(await (await get(`${restarted.url}uberblick-config.json`)).text()).toBe(
      servingDocumentOf(
        restarted.url,
        SECOND_REMOTE,
        REBOUND_WORKSPACE,
        localBrowserKey(REBOUND_WORKSPACE, box.env),
      ),
    );
    expect((await restarted.interrupt()).status).toBe(0);
  });

  it("serves the last coherent document while `.init.lock` is held", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);
    const url = `${app.url}uberblick-config.json`;

    expect(await (await get(url)).text()).toBe(
      servingDocumentOf(app.url, FIRST_REMOTE, WORKSPACE, localBrowserKey(WORKSPACE, box.env)),
    );

    // A write is in flight after its first publication. Pairing this new secret
    // with the old endpoint would authenticate against a hub nobody configured.
    const lock = await acquireInitLock(box.env);
    writeCredentials(box, REBOUND_SECRET);

    // Answered from the last document that resolved outside a write, and
    // answered *now*: the lock is consulted, never waited on. Its own holder
    // timeout is 2s, so anything near that would be this server waiting.
    const started = Date.now();
    const held = await get(url);
    const text = await held.text();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(text).toBe(servingDocumentOf(app.url, FIRST_REMOTE, WORKSPACE, localBrowserKey(WORKSPACE, box.env)));

    writeBinding(box, SECOND_REMOTE, REBOUND_WORKSPACE);
    lock.release();
    expect(await (await get(url)).text()).toBe(
      servingDocumentOf(app.url, FIRST_REMOTE, WORKSPACE, localBrowserKey(WORKSPACE, box.env), true),
    );

    // Only an *active* write falls back like that. A completed removal is the
    // configuration: the frozen serving identity remains usable, but is marked
    // stale so a restart can adopt the removal coherently.
    rmSync(join(configDir(box), "credentials.json"), { force: true });
    expect(await (await get(url)).json()).toMatchObject({
      hubAuthToken: localBrowserKey(WORKSPACE, box.env),
      rebound: true,
    });

    expect((await app.interrupt()).status).toBe(0);
  });

  it("establishes its first document only after a two-file writer completes", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    const webPort = await freePort();

    // A real writer lock spans the two publications. Start `ub open` after the
    // new credential is visible but before its endpoint/workspace is: accepting
    // a startup document here would seed old/new for the server's lifetime.
    const writer = await acquireInitLock(box.env);
    writeCredentials(box, REBOUND_SECRET);
    const opening = open(box, ["--port", String(webPort)], env);

    const openedWhileTorn = await Promise.race([
      opening.then(() => true),
      sleep(500).then(() => false),
    ]);
    expect(openedWhileTorn).toBe(false);

    writeBinding(box, SECOND_REMOTE, REBOUND_WORKSPACE);
    writer.release();

    const app = await opening;
    expect(await (await get(`${app.url}uberblick-config.json`)).text()).toBe(
      servingDocumentOf(app.url, SECOND_REMOTE, REBOUND_WORKSPACE, localBrowserKey(REBOUND_WORKSPACE, box.env)),
    );
    expect((await app.interrupt()).status).toBe(0);
  });

  it("keeps a genuine environment pin winning over the files it re-reads", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    const webPort = await freePort();
    // The pin a repository puts in its project MCP entry. It outranks this
    // project's file, and re-resolving must not quietly demote it — nor
    // promote the file-sourced secret beside it into a pin of its own.
    const app = await open(box, ["--port", String(webPort)], {
      ...env,
      UB_WORKSPACE_ID: REBOUND_WORKSPACE,
      UB_HUB_URL: FIRST_REMOTE,
    });
    const url = `${app.url}uberblick-config.json`;

    expect(await (await get(url)).text()).toBe(
      servingDocumentOf(app.url, FIRST_REMOTE, REBOUND_WORKSPACE, localBrowserKey(REBOUND_WORKSPACE, box.env)),
    );

    // The complete environment pair stays selected even when both file values
    // change. A legacy signing secret also cannot rebind a remote device login,
    // so this unrelated file edit does not mark the browser stale.
    rebind(box, {
      hubUrl: SECOND_REMOTE,
      workspace: WORKSPACE,
      signingSecret: REBOUND_SECRET,
    });
    expect(await (await get(url)).text()).toBe(
      servingDocumentOf(app.url, FIRST_REMOTE, REBOUND_WORKSPACE, localBrowserKey(REBOUND_WORKSPACE, box.env)),
    );

    expect((await app.interrupt()).status).toBe(0);
  });

  it("serves the configuration document uncached, ahead of the SPA fallback", async () => {
    const { box, env } = configured();
    const webPort = await freePort();
    pointAt(box, "wss://hub.example.ts.net/ws");
    const app = await open(box, ["--port", String(webPort)], env);

    const document = await get(`${app.url}uberblick-config.json`);
    expect(document.status).toBe(200);
    expect(document.headers.get("cache-control")).toBe("no-store");
    expect(document.headers.get("content-type")).toBe("application/json");
    const body = await document.text();
    expect(body).not.toContain("<!doctype html");
    expect(JSON.parse(body)).toMatchObject({
      hubUrl: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
      remoteHubUrl: "wss://hub.example.ts.net/ws",
    });

    // The fallback is still there for deep links (#68) — which is exactly why
    // the document has to be matched before it.
    const deepLink = await get(`${app.url}${WORKSPACE}/6bd9d0b1-6d0e-4e5a-9c93-0a5c9f5a7e11`);
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toContain("<title>uberblick</title>");

    expect((await app.interrupt()).status).toBe(0);
  });

  it("refuses every HTTP surface before routing when Host is not the served address", async () => {
    const { box, env } = configured();
    const webPort = await freePort();
    pointAt(box, "wss://hub.example.ts.net/ws");
    const app = await open(box, ["--port", String(webPort)], env);
    const valid = await authMessage(localBrowserKey(WORKSPACE, box.env));
    const samples = [
      { path: "uberblick-config.json", host: `rebound.example:${webPort}` },
      { path: "assets/app.js", host: `localhost:${webPort}` },
      { path: `${WORKSPACE}/unknown`, host: `[::1]:${webPort}` },
      { path: "api/unknown", host: `127.0.0.1:${webPort + 1}` },
      { path: "api/status", host: `rebound.example:${webPort}`, authorization: valid },
    ];

    try {
      for (const sample of samples) {
        const response = await getWithHost(
          `${app.url}${sample.path}`,
          sample.host,
          sample.authorization,
        );
        expect(response.status, sample.path).toBe(421);
        expect(response.headers["cache-control"], sample.path).toBe("no-store");
        expect(response.body, sample.path).toBe("misdirected request\n");
      }

      // Node may reject HTTP/1.1 without Host before the request reaches our
      // handler. Either layer must refuse it without exposing served content.
      const missing = await getWithHost(`${app.url}uberblick-config.json`, null);
      expect(missing.status).toBeGreaterThanOrEqual(400);
      expect(missing.status).toBeLessThan(500);
      expect(missing.body).not.toContain(SECRET);
    } finally {
      expect((await app.interrupt()).status).toBe(0);
    }
  });

  it("refuses rather than serving a blank page when there is no bundle", async () => {
    const { box, env } = configured();
    const empty = join(box.cwd, "not-a-bundle");
    mkdirSync(empty, { recursive: true });

    const refused = await openFails(box, [], { ...env, UBERBLICK_WEB_DIST: empty });
    expect(refused.status).toBe(1);
    expect(refused.output).toContain(empty);
    expect(refused.output).toContain("index.html");
    // The way out names the variable this user can set, not a checkout's task.
    expect(refused.output).toContain("UBERBLICK_WEB_DIST");
    expect(refused.output).not.toMatch(/mise/);

    // And in a checkout, an absent bundle is one to build rather than to
    // refuse: the web package is right there and the plan says so.
    expect(bundlePlan({}).action).not.toBe("missing");
  });

  it("refuses a bundle that speaks another sync protocol, and starts nothing", async () => {
    const { box, env, bundle } = configured();
    const hubPort = await freePort();
    pointAt(box, `ws://127.0.0.1:${hubPort}`);
    stamp(bundle, SYNC_PROTOCOL_VERSION + 1);

    const refused = await openFails(box, [], env);

    expect(refused.status).toBe(1);
    // Both versions, so the reader can see which side is behind, and the way
    // out named rather than implied.
    expect(refused.output).toContain(bundle);
    expect(refused.output).toContain(`speaks sync protocol ${SYNC_PROTOCOL_VERSION + 1}`);
    expect(refused.output).toContain(`this uberblick speaks ${SYNC_PROTOCOL_VERSION}`);
    expect(refused.output).toContain("mise run build-web");

    // It served nothing and started nothing: a refusal that had bound a port or
    // opened a hub database would be the unsyncable page, served anyway.
    expect(refused.output).not.toMatch(BANNER);
    expect((await probePort("127.0.0.1", hubPort)).state).toBe("free");
    expect(existsSync(join(box.cwd, "started-hub.sqlite"))).toBe(false);
  });

  it("treats a bundle with no readable stamp as one that cannot sync", async () => {
    const { box, env, bundle } = configured();
    stamp(bundle, null);

    // The stale bundle actually observed: built before the stamp existed.
    const unstamped = await openFails(box, [], env);
    expect(unstamped.status).toBe(1);
    expect(unstamped.output).toContain("no sync protocol stamp");

    // A stamp that is not JSON is the same refusal, not a stack trace.
    writeFileSync(join(bundle, BUILD_STAMP), "{ not json", "utf8");
    const unparseable = await openFails(box, [], env);
    expect(unparseable.status).toBe(1);
    expect(unparseable.output).toContain("no sync protocol stamp");
  });

  it("rebuilds its own stale bundle with the documented task, in the checkout", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    stamp(bundle, SYNC_PROTOCOL_VERSION + 1);
    const mise = fakeMise(box);
    const io = stderrIo();

    const served = await ensureBundle(
      { action: "serve", dir: bundle, ours: true, installed: false },
      {
        ...box.env,
        PATH: mise.path,
        FAKE_STAMP_DIR: bundle,
        FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION),
      },
      io,
      calm(),
    );

    expect(served).toBe("servable");
    // Said before it happens, with both versions: a command that goes quiet for
    // a Vite build looks hung.
    expect(io.text()).toContain(`speaks sync protocol ${SYNC_PROTOCOL_VERSION + 1}`);
    expect(io.text()).toContain(`this uberblick speaks ${SYNC_PROTOCOL_VERSION}`);
    // Once, the documented task, from the checkout root — not a bare pnpm.
    expect(mise.calls()).toEqual([`${REPO_ROOT} run build-web`]);
  });

  it("rebuilds the bundle it chose, never one UBERBLICK_WEB_DIST named", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    stamp(bundle, null);
    const mise = fakeMise(box);

    // Ownership is the variable, not the path: the default directory named
    // explicitly is still an artifact its caller maintains.
    const chosen = bundlePlan({});
    expect(chosen.ours).toBe(true);
    expect(bundlePlan({ UBERBLICK_WEB_DIST: chosen.dir }).ours).toBe(false);
    // And it is the checkout's own `packages/web/dist` (#512): the rebuild path
    // reports success from the stamp in this directory, so a plan that quietly
    // moved would serve the old bundle and keep a green suite.
    expect(chosen.dir).toBe(join(REPO_ROOT, "packages", "web", "dist"));

    const io = stderrIo();
    const served = await ensureBundle(
      { action: "serve", dir: bundle, ours: false, installed: false },
      {
        ...box.env,
        PATH: mise.path,
        FAKE_STAMP_DIR: bundle,
        FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION),
      },
      io,
      calm(),
    );

    expect(served).toBe("refused");
    expect(mise.calls()).toEqual([]);
    expect(io.text()).toContain("no sync protocol stamp");
  });

  it("refuses when the rebuild cannot run, fails, or leaves the bundle stale", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    stamp(bundle, null);
    const mise = fakeMise(box);
    const plan = { action: "serve", dir: bundle, ours: true, installed: false } as const;
    const noTools = join(box.cwd, "no-tools");
    mkdirSync(noTools, { recursive: true });

    const unavailable = stderrIo();
    expect(await ensureBundle(plan, { ...box.env, PATH: noTools }, unavailable, calm())).toBe(
      "refused",
    );
    expect(unavailable.text()).toContain("could not be run");

    const failed = stderrIo();
    expect(
      await ensureBundle(
        plan,
        { ...box.env, PATH: mise.path, FAKE_EXIT_CODE: "3" },
        failed,
        calm(),
      ),
    ).toBe("refused");
    expect(failed.text()).toContain("exited 3");

    const stale = stderrIo();
    expect(
      await ensureBundle(
        plan,
        {
          ...box.env,
          PATH: mise.path,
          FAKE_STAMP_DIR: bundle,
          FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION + 2),
        },
        stale,
        calm(),
      ),
    ).toBe("refused");
    expect(stale.text()).toContain(
      `the rebuilt web app speaks sync protocol ${SYNC_PROTOCOL_VERSION + 2}`,
    );

    // Every refusal names both ways out, and none of them is "read the code".
    for (const said of [unavailable.text(), failed.text(), stale.text()]) {
      expect(said).toContain("mise run build-web");
      expect(said).toContain(REPO_ROOT);
      expect(said).toContain("UBERBLICK_WEB_DIST");
    }
  });

  it("waits for another run's build, then builds only what is still missing", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    stamp(bundle, SYNC_PROTOCOL_VERSION + 1);
    const mise = fakeMise(box);
    const env = {
      ...box.env,
      PATH: mise.path,
      FAKE_STAMP_DIR: bundle,
      FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION),
    };
    const io = stderrIo();
    const holder = await anotherRunBuilding(bundle, SYNC_PROTOCOL_VERSION);

    const waiting = ensureBundle(
      { action: "serve", dir: bundle, ours: true, installed: false },
      env,
      io,
      calm(),
    );
    await waitUntil("the waiter to announce itself", () => io.text().includes("waiting for it"));
    // Nothing was built behind the holder's back — which is the whole point:
    // `vite build` empties this directory before it writes it.
    expect(mise.calls()).toEqual([]);

    // The holder's build ends, leaving a current bundle. The waiter re-reads it
    // and has nothing left to do.
    await holder.finish();

    expect(await waiting).toBe("servable");
    expect(mise.calls()).toEqual([]);
  });

  it("never serves the stamp of a build that is still writing its directory", async () => {
    const box = sandbox();
    const dir = join(box.cwd, "half-written");
    mkdirSync(dir, { recursive: true });
    const mise = fakeMise(box);
    const io = stderrIo();
    const holder = await anotherRunBuilding(dir);

    // What Vite's output directory looks like partway through a build: it emits
    // the stamp from `generateBundle` with nothing ordering it last, so a
    // current stamp can be there before `index.html` is.
    stamp(dir, SYNC_PROTOCOL_VERSION);

    const waiting = ensureBundle(
      { action: "serve", dir, ours: true, installed: false },
      { ...box.env, PATH: mise.path },
      io,
      calm(),
    );
    // Waiting, not serving: announcing is what a run does when it finds the
    // lock held, and taking the stamp at its word would have returned already.
    await waitUntil("the waiter to announce itself", () => io.text().includes("waiting for it"));

    // The rest of the holder's build, and then the lock.
    writeFileSync(join(dir, "index.html"), "<!doctype html><div id=root></div>\n", "utf8");
    await holder.finish();

    expect(await waiting).toBe("servable");
    expect(mise.calls()).toEqual([]);
  });

  it("builds when the run it waited for left a stamp and no bundle", async () => {
    const box = sandbox();
    const dir = join(box.cwd, "abandoned");
    mkdirSync(dir, { recursive: true });
    const mise = fakeMise(box);
    const io = stderrIo();
    // The holder's build stamps this directory and then ends without ever
    // writing `index.html` — an ordinary non-zero exit does it. The waiter is
    // woken into precisely that state, and the stamp it re-reads under the lock
    // is the same one it already refused to serve outside it: nothing ran in
    // between. Take it at its word and this run announces success and answers
    // 404 for as long as it stays in the foreground.
    const holder = await anotherRunBuilding(dir, SYNC_PROTOCOL_VERSION);

    const env = {
      ...box.env,
      PATH: mise.path,
      FAKE_STAMP_DIR: dir,
      FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION),
    };
    const waiting = ensureBundle(
      { action: "serve", dir, ours: true, installed: false },
      env,
      io,
      calm(),
    );
    await waitUntil("the waiter to announce itself", () => io.text().includes("waiting for it"));
    expect(mise.calls()).toEqual([]);

    await holder.finish();

    expect(await waiting).toBe("servable");
    // It built, rather than serving the abandoned stamp, and said which of the
    // two things wrong with a bundle this one was.
    expect(mise.calls().length).toBe(1);
    expect(io.text()).toContain("stamp with no bundle behind it");
  });

  it("builds a stamp-only directory nobody is building, rather than serving it", async () => {
    const box = sandbox();
    const dir = join(box.cwd, "stamp-only");
    mkdirSync(dir, { recursive: true });
    // The same half-written directory as above, except that the build which left
    // it was killed: nothing holds the lock, so nothing will ever finish it. Take
    // the stamp at its word here and every `ub open` from now on announces
    // success and answers 404.
    stamp(dir, SYNC_PROTOCOL_VERSION);
    const pnpm = fakeTool(box, "pnpm");
    const io = stderrIo();

    const outcome = await ensureBundle(
      { action: "build", dir, ours: true, installed: false },
      { ...box.env, PATH: pnpm.path, FAKE_EXIT_CODE: "1" },
      io,
      calm(),
    );

    // It built — and said so when the build failed, instead of serving nothing.
    expect(pnpm.calls().length).toBe(1);
    expect(outcome).toBe("refused");
    expect(io.text()).toContain("the web build failed");
  });

  it("takes that same lock for a first build, not only for a rebuild", async () => {
    const box = sandbox();
    const bundle = join(box.cwd, "not-built-yet");
    const pnpm = fakeTool(box, "pnpm");
    const env = {
      ...box.env,
      PATH: pnpm.path,
      FAKE_STAMP_DIR: bundle,
      FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION),
    };
    const io = stderrIo();
    const holder = await anotherRunBuilding(bundle);

    const waiting = ensureBundle(
      { action: "build", dir: bundle, ours: true, installed: false },
      env,
      io,
      calm(),
    );
    await waitUntil("the waiter to announce itself", () => io.text().includes("waiting for it"));
    expect(pnpm.calls()).toEqual([]);

    await holder.finish();
    expect(await waiting).toBe("servable");
    // One build, in the workspace root, once the lock was free.
    expect(pnpm.calls()).toEqual([`${join(REPO_ROOT, "packages")} --filter @uberblick/web build`]);
  });

  it("stops quietly on an interrupt, whether it is waiting or building", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    stamp(bundle, SYNC_PROTOCOL_VERSION + 1);
    const mise = fakeMise(box);
    const plan = { action: "serve", dir: bundle, ours: true, installed: false } as const;

    // Waiting for somebody else's build: no build of its own, and no failure.
    const waitEnv = { ...box.env, PATH: mise.path };
    const holder = await anotherRunBuilding(bundle);
    const waitingIo = stderrIo();
    const waitingStop = stoppable();
    const waiting = ensureBundle(plan, waitEnv, waitingIo, waitingStop);
    await waitUntil("the waiter to announce itself", () =>
      waitingIo.text().includes("waiting for it"),
    );
    waitingStop.stop();

    expect(await waiting).toBe("interrupted");
    expect(mise.calls()).toEqual([]);
    expect(waitingIo.text()).not.toContain("was not rebuilt");
    await holder.finish();

    // Running one: the signal is passed on to the build, and a build that ends
    // on it is this command stopping rather than a build that failed.
    const buildingIo = stderrIo();
    const buildingStop = stoppable();
    const building = ensureBundle(
      plan,
      { ...box.env, PATH: mise.path, FAKE_SLEEP: "5" },
      buildingIo,
      buildingStop,
    );
    await waitUntil("the build to start", () => mise.calls().length === 1);
    buildingStop.stop();

    expect(await building).toBe("interrupted");
    expect(buildingIo.text()).not.toContain("was not rebuilt");
  });

  it("excludes two runs of one checkout even when their configuration differs", async () => {
    // The hazard is one output directory, so the lock has to be that
    // directory's. Two sandboxes is two `XDG_CONFIG_HOME` values — which is what
    // this repository's own rig and its parallel agents produce — over one
    // bundle.
    const one = sandbox();
    const other = sandbox();
    const bundle = join(one.cwd, "shared-dist");
    mkdirSync(bundle, { recursive: true });
    stamp(bundle, SYNC_PROTOCOL_VERSION + 1);
    const mise = fakeMise(one);
    const build = {
      PATH: mise.path,
      FAKE_STAMP_DIR: bundle,
      // Still stale afterwards, so the second run has real work to do rather
      // than finding the first one's bundle and stopping.
      FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION + 1),
      FAKE_SLEEP: "0.3",
      FAKE_BUSY_DIR: join(one.cwd, "building"),
    };
    const plan = { action: "serve", dir: bundle, ours: true, installed: false } as const;
    const first = stderrIo();
    const second = stderrIo();

    const outcomes = await Promise.all([
      ensureBundle(plan, { ...one.env, ...build }, first, calm()),
      ensureBundle(plan, { ...other.env, ...build }, second, calm()),
    ]);

    // Both really did build — and the sentinel proves they never overlapped.
    expect(outcomes).toEqual(["refused", "refused"]);
    expect(mise.calls()).toHaveLength(2);
    for (const said of [first.text(), second.text()]) {
      expect(said).not.toContain("exited 9");
    }
  });

  it("a build somebody else killed is a failure, not this command stopping", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    stamp(bundle, SYNC_PROTOCOL_VERSION + 1);
    const mise = fakeMise(box);
    const io = stderrIo();

    // No signal reached this process, so a dead build is a build that did not
    // work — exit 1 with a reason, not the quiet exit 0 of a Ctrl-C.
    const outcome = await ensureBundle(
      { action: "serve", dir: bundle, ours: true, installed: false },
      { ...box.env, PATH: mise.path, FAKE_KILL_SELF: "1" },
      io,
      calm(),
    );

    expect(outcome).toBe("refused");
    expect(io.text()).toContain("was killed by SIGTERM");
  });

  it("hands both builds the same environment, and neither the signing secret", async () => {
    const box = sandbox();
    const bundle = fixtureBundle(box);
    stamp(bundle, SYNC_PROTOCOL_VERSION + 1);
    const mise = fakeMise(box);
    const pnpm = fakeTool(box, "pnpm");
    const env = {
      ...box.env,
      HUB_AUTH_TOKEN: SECRET,
      PATH: mise.path,
      FAKE_STAMP_DIR: bundle,
      FAKE_STAMP_VERSION: String(SYNC_PROTOCOL_VERSION),
    };

    const rebuilt = await ensureBundle(
      { action: "serve", dir: bundle, ours: true, installed: false },
      env,
      stderrIo(),
      calm(),
    );
    const first = join(box.cwd, "first-build");
    const built = await ensureBundle(
      { action: "build", dir: first, ours: true, installed: false },
      { ...env, FAKE_STAMP_DIR: first },
      stderrIo(),
      calm(),
    );

    expect([rebuilt, built]).toEqual(["servable", "servable"]);
    // What `mise run build-web` puts back into its own child is that task's
    // business; what this command hands a build is neither path's secret.
    expect(mise.tokens()).toEqual(["<unset>"]);
    expect(pnpm.tokens()).toEqual(["<unset>"]);
  });

  it("--no-browser prints the URL and opens nothing; --port chooses the port", async () => {
    const { box, env } = configured();
    const webPort = await freePort();
    const browser = browserRecorder(box);
    pointAt(box, "wss://hub.example.ts.net/ws");

    // No TTY either way: a spawned child's stdio are pipes, not a terminal.
    const app = await open(box, ["--no-browser", "--port", String(webPort)], {
      ...env,
      BROWSER: browser.command,
    });

    expect(app.stdout()).toContain(`http://127.0.0.1:${webPort}/`);
    await sleep(500);
    expect(existsSync(browser.opened)).toBe(false);
    expect((await get(app.url)).status).toBe(200);

    expect((await app.interrupt()).status).toBe(0);
  });

  it("refuses to serve without a binding, even with a signing secret configured", async () => {
    const box = sandbox({
      userConfig: { workspace: WORKSPACE, hubUrl: FIRST_REMOTE },
      credentials: { signingSecret: SECRET },
    });
    const bundle = fixtureBundle(box);
    const webPort = await freePort();
    const refused = await openFails(box, ["--port", String(webPort)], {
      UBERBLICK_WEB_DIST: bundle,
      BROWSER: "none",
      HUB_DB_PATH: join(box.cwd, "unbound-hub.sqlite"),
    });

    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain("No workspace selected");
    expect(refused.output).not.toContain("uberblick is at");
    expect(refused.output).not.toContain(SECRET);
    expect(existsSync(join(configDir(box), "browser-keys"))).toBe(false);
    expect((await probePort("127.0.0.1", webPort)).state).toBe("free");
    expect(existsSync(join(box.cwd, "unbound-hub.sqlite"))).toBe(false);
  });

  it.each(["0.0.0.0", "127.attacker.example"])("serves locally without starting a hub at remote endpoint %s", async host => {
    const { box, env } = configured();
    const port = await freePort();
    const endpoint = `ws://${host}:${port}`;
    pointAt(box, endpoint);
    const app = await open(box, ["--port", String(await freePort())], env);
    try {
      expect(app.stdout()).toContain("remote — nothing started here");
      expect((await probePort("127.0.0.1", port)).state).toBe("free");
      const document = await (await get(`${app.url}uberblick-config.json`)).json() as { hubUrl: string; remoteHubUrl: string };
      expect(document).toMatchObject({ remoteHubUrl: endpoint });
      expect(document.hubUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/);
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });
});

it("opens a newly created local workspace in the browser without login or promotion", async () => {
  const box = sandbox();
  const created = await runUbAsync(["workspace", "create", "Local browser"], box);
  expect(created.status, created.output).toBe(0);
  const running = await open(box, ["--port", String(await freePort())], {
    UBERBLICK_WEB_DIST: fixtureBundle(box),
    HUB_DB_PATH: join(box.cwd, "local-browser.sqlite"), BROWSER: "none",
  });
  expect((await get(running.url)).status).toBe(200);
  expect(running.stdout() + running.stderr()).not.toMatch(/sign.in required|approve in a browser/i);
  expect(JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8")).hubUrl).toBeNull();
  expect((await running.interrupt()).status).toBe(0);
});
