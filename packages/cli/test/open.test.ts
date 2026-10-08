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

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_TOKEN_LIFETIME_SECONDS } from "@uberblick/hub";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { localBrowserKey } from "../src/browser-key.js";
import { acquireInitLock } from "../src/init-lock.js";
import { probePort } from "../src/probes.js";
import { readWorkspaceHub, rememberWorkspaceBinding } from "../src/workspace-registry.js";
import { UB_BIN, pointAt, runUbAsync, sandbox, unboundSandbox, sleep, waitUntil } from "./helpers.js";
import {
  BANNER,
  BUILD_STAMP,
  FIRST_REMOTE,
  REBOUND_SECRET,
  REBOUND_WORKSPACE,
  SECOND_REMOTE,
  SECRET,
  WORKSPACE,
  authMessage,
  bearer,
  browserRecorder,
  cleanUp,
  configDir,
  configured,
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
  writeBinding,
  writeCredentials,
} from "./open-fixtures.js";

/** A source-shaped copy whose default bundle is safe for this test to change. */
function checkoutCli(box: ReturnType<typeof sandbox>): { bin: string; bundle: string } {
  const root = join(box.cwd, "source-checkout");
  const cliRoot = join(root, "packages", "cli");
  const bin = join(cliRoot, "src", "ub.mjs");
  const webRoot = join(root, "packages", "web");
  mkdirSync(join(cliRoot, "src"), { recursive: true });
  mkdirSync(webRoot, { recursive: true });
  // Reuse global setup's self-contained CLI; module-relative paths resolve
  // against this copy even though the command's working directory is outside it.
  copyFileSync(UB_BIN, bin);
  writeFileSync(join(root, "package.json"), '{"name":"uberblick"}', "utf8");
  writeFileSync(join(root, "mise.toml"), "[env]\n", "utf8");
  writeFileSync(join(cliRoot, "package.json"), '{"version":"0.0.0"}', "utf8");
  writeFileSync(join(webRoot, "package.json"), '{"name":"@uberblick/web"}', "utf8");
  return { bin, bundle: join(webRoot, "dist") };
}

afterEach(cleanUp);

describe("ub open", () => {
  it.each([
    { source: "project", hubUrl: null },
    { source: "project", hubUrl: FIRST_REMOTE },
    { source: "environment", hubUrl: null },
    { source: "environment", hubUrl: FIRST_REMOTE },
  ])("remembers a first $source binding with hub $hubUrl after serving", async ({ source, hubUrl }) => {
    const box = source === "project"
      ? sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl } })
      : unboundSandbox();
    const env = {
      UBERBLICK_WEB_DIST: fixtureBundle(box), BROWSER: "none",
      ...(source === "environment" ? {
        UB_WORKSPACE_ID: `browser-${WORKSPACE}`, UB_HUB_URL: hubUrl ?? "local",
      } : {}),
    };
    expect(readWorkspaceHub(WORKSPACE, box.env)).toBeUndefined();
    const app = await open(box, ["--port", String(await freePort())], env);
    try {
      expect((await get(app.url)).status).toBe(200);
      expect(readWorkspaceHub(WORKSPACE, box.env)).toBe(hubUrl);
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("preserves a different recorded hub while serving the project's binding", async () => {
    const { box, env } = configured();
    pointAt(box, FIRST_REMOTE);
    await rememberWorkspaceBinding({ workspaceId: WORKSPACE, hubUrl: null }, box.env);
    const app = await open(box, ["--port", String(await freePort())], env);
    try {
      const document = await (await get(`${app.url}uberblick-config.json`)).json() as { remoteHubUrl: string };
      expect(document.remoteHubUrl).toBe(FIRST_REMOTE);
      expect(readWorkspaceHub(WORKSPACE, box.env)).toBeNull();
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("records nothing when a complete binding cannot serve its bundle", async () => {
    const { box, env, bundle } = configured();
    stamp(bundle, SYNC_PROTOCOL_VERSION + 1);
    const refused = await openFails(box, ["--port", String(await freePort())], env);
    expect(refused.status).toBe(1);
    expect(readWorkspaceHub(WORKSPACE, box.env)).toBeUndefined();
  });

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
        false,
        { [WORKSPACE]: { browserKey: localBrowserKey(WORKSPACE, box.env), remoteHubUrl: FIRST_REMOTE } },
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

  it.each([
    { name: "missing", index: false, protocol: null },
    { name: "stamp-only", index: false, protocol: SYNC_PROTOCOL_VERSION },
    { name: "stale", index: true, protocol: SYNC_PROTOCOL_VERSION + 1 },
    { name: "unstamped", index: true, protocol: null },
  ])("refuses its $name default bundle before starting a hub, without building", async ({ index, protocol }) => {
    const { box, env } = configured();
    const hubPort = await freePort();
    const webPort = await freePort();
    pointAt(box, `ws://127.0.0.1:${hubPort}`);

    const { bin, bundle } = checkoutCli(box);
    if (index || protocol !== null) {
      mkdirSync(bundle, { recursive: true });
      if (index) writeFileSync(join(bundle, "index.html"), "<title>default fixture</title>", "utf8");
      stamp(bundle, protocol);
    }

    const tools = join(box.cwd, "build-tools");
    const buildCalls = join(box.cwd, "build-calls.txt");
    mkdirSync(tools, { recursive: true });
    for (const command of ["mise", "pnpm"]) {
      writeFileSync(
        join(tools, command),
        `#!/bin/sh\nprintf 'called\\n' >> "${buildCalls}"\nexit 1\n`,
        { mode: 0o755 },
      );
    }
    const checkoutEnv = { ...box.env, ...env, PATH: tools };
    delete checkoutEnv.UBERBLICK_WEB_DIST;

    const refused = spawnSync(process.execPath, [bin, "open", "--no-browser", "--port", String(webPort)], {
      cwd: box.cwd,
      env: checkoutEnv,
      encoding: "utf8",
      timeout: 25_000,
    });

    expect(refused.status, refused.stderr).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain(bundle);
    expect(refused.stderr).toContain("mise run build-web");
    if (index && protocol !== null) {
      expect(refused.stderr).toContain(`speaks sync protocol ${protocol}`);
      expect(refused.stderr).toContain(`this uberblick speaks ${SYNC_PROTOCOL_VERSION}`);
    }
    expect(refused.stderr).not.toMatch(BANNER);
    expect(existsSync(buildCalls)).toBe(false);
    expect((await probePort("127.0.0.1", hubPort)).state).toBe("free");
    expect((await probePort("127.0.0.1", webPort)).state).toBe("free");
    expect(existsSync(join(box.cwd, "started-hub.sqlite"))).toBe(false);
    expect(existsSync(box.dataHome)).toBe(false);
    expect(existsSync(join(bundle, "index.html"))).toBe(index);
    if (index) {
      expect(readFileSync(join(bundle, "index.html"), "utf8")).toBe("<title>default fixture</title>");
    }
    if (protocol !== null) {
      expect(JSON.parse(readFileSync(join(bundle, BUILD_STAMP), "utf8"))).toEqual({
        syncProtocolVersion: protocol,
      });
    }
  });

  it("serves a compatible default bundle from the CLI's checkout, regardless of cwd", async () => {
    const { box, env } = configured();
    pointAt(box, `ws://127.0.0.1:${await freePort()}`);
    const { bin, bundle } = checkoutCli(box);
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "index.html"), "<title>default fixture</title>", "utf8");
    stamp(bundle, SYNC_PROTOCOL_VERSION);
    const checkoutEnv = { ...env };
    delete checkoutEnv.UBERBLICK_WEB_DIST;

    const app = await open(box, ["--no-browser", "--port", String(await freePort())], checkoutEnv, bin);
    try {
      const response = await get(app.url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("default fixture");
      expect(app.stderr()).not.toContain("building");
    } finally {
      expect((await app.interrupt()).status).toBe(0);
    }
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
    const box = unboundSandbox({
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
  const box = unboundSandbox();
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
