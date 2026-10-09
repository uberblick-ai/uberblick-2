/**
 * `ub open` and the hub and ports it owns: starting or reusing a hub, refusing
 * a port somebody else holds, and releasing every port and the serving role on
 * the way out. Split from `open.test.ts`, whose header explains the real-world
 * rig; the fixtures are in `open-fixtures.ts`.
 */

import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { resolveMcpConfig } from "@uberblick/mcp-server";
import { directoryRoom } from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { localBrowserKey } from "../src/browser-key.js";
import { whoHoldsPort } from "../src/open.js";
import { probeHub, probePort } from "../src/probes.js";
import { pointAt, waitUntil } from "./helpers.js";
import {
  SECRET,
  WORKSPACE,
  answeringListener,
  authMessage,
  bearer,
  browserRecorder,
  cleanUp,
  configDir,
  configured,
  freePort,
  get,
  hubAnswers,
  interruptWhen,
  open,
  openFails,
  openStore,
  silentListener,
  startHub,
  untilBound,
} from "./open-fixtures.js";

afterEach(cleanUp);

describe("ub open: hub, ports and serving role", () => {
  it("creates the missing secret and gives it to the local hub and serving replica", async () => {
    const { box, env } = configured();
    const path = join(configDir(box), "credentials.json");
    rmSync(path);
    const hubUrl = `ws://127.0.0.1:${await freePort()}`;
    pointAt(box, hubUrl);

    const app = await open(box, ["--no-browser", "--port", String(await freePort())], env);
    try {
      const secret = JSON.parse(readFileSync(path, "utf8")).signingSecret as string;
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(app.stdout()).toContain(`secret     created ${path} (0600)`);
      expect(app.stdout()).toContain("started here");
      expect(app.stdout() + app.stderr()).not.toContain(secret);
      expect(await probeHub(resolveMcpConfig({ ...box.env, WORKSPACE_ID: WORKSPACE,
        HUB_AUTH_TOKEN: secret, UBERBLICK_DB: join(box.cwd, "generated-secret-probe.sqlite") }), hubUrl)).toBe("connected");
      const status = async () => await (await fetch(`${app.url}api/status`, {
        headers: bearer(await authMessage(localBrowserKey(WORKSPACE, box.env))),
      })).json() as { caughtUp: boolean };
      await waitUntil("the serving replica to sync with its new local secret", async () => (await status()).caughtUp);
      const document = await (await get(`${app.url}uberblick-config.json`)).text();
      expect(JSON.parse(document)).toMatchObject({ remoteHubUrl: hubUrl });
      expect(JSON.parse(document)).not.toHaveProperty("rebound");
      expect(document).not.toContain(secret);
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it.each(["file", "environment"])("keeps the %s secret and credential store unchanged", async source => {
    const { box, env } = configured();
    const path = join(configDir(box), "credentials.json");
    const before = readFileSync(path, "utf8");
    if (source === "environment") rmSync(path);
    const hubUrl = `ws://127.0.0.1:${await freePort()}`;
    pointAt(box, hubUrl);
    const app = await open(box, ["--port", String(await freePort())], {
      ...env, ...(source === "environment" ? { HUB_AUTH_TOKEN: SECRET } : {}),
    });
    try {
      if (source === "environment") expect(existsSync(path)).toBe(false);
      else {
        expect(readFileSync(path, "utf8")).toBe(before);
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      expect(app.stdout()).not.toContain("secret     created");
      expect(await hubAnswers(box, hubUrl)).toBe(true);
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it.each(["free", "occupied"])("refuses exposed local credentials unchanged with a %s hub port", async state => {
    const { box, env } = configured();
    const path = join(configDir(box), "credentials.json");
    const before = readFileSync(path, "utf8");
    chmodSync(path, 0o644);
    const hubPort = await freePort();
    if (state === "occupied") await silentListener(hubPort);
    pointAt(box, `ws://127.0.0.1:${hubPort}`);
    const webPort = await freePort();
    const refused = await openFails(box, ["--no-browser", "--port", String(webPort)], env);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("may have leaked");
    expect(refused.output).toContain(path);
    expect(refused.output).toMatch(/delete|rm /);
    expect(refused.output).toContain("ub open");
    expect(refused.output).toContain("restart");
    expect(refused.output).toContain("ub auth login");
    expect(refused.output).not.toContain("chmod 600");
    expect(refused.output).not.toContain(SECRET);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect((await probePort("127.0.0.1", webPort)).state).toBe("free");
    expect(existsSync(join(box.cwd, "started-hub.sqlite"))).toBe(false);
  });

  it("uses an environment secret without repairing an exposed credential file", async () => {
    const { box, env } = configured();
    const path = join(configDir(box), "credentials.json");
    const before = readFileSync(path, "utf8");
    chmodSync(path, 0o644);
    const hubUrl = `ws://127.0.0.1:${await freePort()}`;
    pointAt(box, hubUrl);
    const app = await open(box, ["--port", String(await freePort())], { ...env, HUB_AUTH_TOKEN: SECRET });
    try {
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(statSync(path).mode & 0o777).toBe(0o644);
      expect(app.stdout()).not.toContain("secret     created");
      expect(await hubAnswers(box, hubUrl)).toBe(true);
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("opens the default origin and refuses collisions without choosing another port", async () => {
    const { box, env } = configured();
    const browser = browserRecorder(box);
    const app = await open(box, [], { ...env, BROWSER: browser.command });

    expect(app.url).toBe("http://127.0.0.1:13379/");
    expect((await get(app.url)).status).toBe(200);
    const configuration = await (await get(`${app.url}uberblick-config.json`)).json();
    expect(configuration).toMatchObject({ hubUrl: "ws://127.0.0.1:13379" });
    const recording = (): string =>
      existsSync(browser.opened) ? readFileSync(browser.opened, "utf8") : "";
    await waitUntil("the browser to record the default URL", () => recording().endsWith("\n"));
    expect(recording().trim()).toBe(app.url);

    // The serving role is acquired before binding: even with both the store
    // and port held, the original store refusal still wins.
    const sameStore = await openFails(box, [], env);
    expect(sameStore.status).toBe(1);
    expect(sameStore.output).toContain("another `ub open` is already serving this store");
    expect(sameStore.output).not.toContain("port 13379 is");

    const other = configured();
    const samePort = await openFails(other.box, [], other.env);
    expect(samePort.status).toBe(1);
    expect(samePort.output).toContain("port 13379 is already serving an uberblick web app");
    expect(samePort.output).not.toContain("uberblick is at");

    expect((await app.interrupt()).status).toBe(0);
  });

  it("keeps a stopped loopback deployment external after logout", async () => {
    const { box, env } = configured();
    const credentials = join(configDir(box), "credentials.json");
    rmSync(credentials);
    const port = await freePort();
    const endpoint = `ws://127.0.0.1:${port}/custom-proxy-path`;
    pointAt(box, endpoint);
    // No login any more, only the device admission it recorded.
    writeFileSync(join(configDir(box), "config.json"), JSON.stringify({ hubAdmissions: { [endpoint]: "device" } }));
    const app = await open(box, ["--port", String(await freePort())], env);
    try {
      expect(app.stdout()).toContain("hub unreachable; nothing started here");
      expect(existsSync(credentials)).toBe(false);
      expect(app.stdout()).not.toContain("secret     created");
      expect((await probePort("127.0.0.1", port)).state).toBe("free");
    } finally { expect((await app.interrupt()).status).toBe(0); }
  });

  it("starts a hub, serves the bundle, and opens the browser at the served URL", async () => {
    const { box, env } = configured();
    const hubPort = await freePort();
    const webPort = await freePort();
    const hubUrl = `ws://127.0.0.1:${hubPort}`;
    const browser = browserRecorder(box);
    pointAt(box, hubUrl);

    const app = await open(box, ["--port", String(webPort)], {
      ...env,
      BROWSER: browser.command,
    });

    expect(app.url).toBe(`http://127.0.0.1:${webPort}/`);
    const configuration = await (await get(`${app.url}uberblick-config.json`)).text();
    expect(configuration).not.toContain(SECRET);
    expect(JSON.parse(configuration).hubAuthToken).toBe(localBrowserKey(WORKSPACE, box.env));
    expect(app.stdout() + app.stderr()).not.toContain(localBrowserKey(WORKSPACE, box.env));
    expect(await (await get(app.url)).text()).toContain("<title>uberblick</title>");
    expect(await (await get(`${app.url}assets/app.js`)).text()).toContain("marker");

    // The hub it started is one a real client can open the workspace's
    // directory room on — which is what the document list hydrates from.
    expect(await hubAnswers(box, hubUrl)).toBe(true);
    expect(app.stdout()).toContain("started here");

    // The browser was handed the address that is actually being served. `ub
    // open` spawns that command and carries on without awaiting it, so the
    // recording lands whenever the machine gets to it: wait for the recording
    // rather than for a duration, or load fails this case instead of delaying
    // it (#531). The recorder appends, and `>>` creates the file before
    // `printf` fills it — so a finished line, not an existing file, is the
    // recording.
    const recording = (): string =>
      existsSync(browser.opened) ? readFileSync(browser.opened, "utf8") : "";
    await waitUntil(
      "the `BROWSER` command to record the URL it was handed",
      () => recording().endsWith("\n"),
    );
    expect(recording().trim()).toBe(app.url);

    expect((await app.interrupt()).status).toBe(0);
  });

  it("uses a hub that is already answering, and Ctrl-C leaves it running", async () => {
    const { box, env } = configured();
    const hub = await startHub(box);
    const hubUrl = `ws://127.0.0.1:${hub.port}`;
    const webPort = await freePort();
    pointAt(box, hubUrl);

    const app = await open(box, ["--port", String(webPort)], env);

    // Nothing was started: a bind of the occupied port would have failed with
    // EADDRINUSE and taken the command down before it ever served.
    expect(app.stdout()).toContain("already running — left alone");
    expect(app.stderr()).not.toContain("EADDRINUSE");
    expect(await (await get(`${app.url}uberblick-config.json`)).json()).toMatchObject({
      hubUrl: app.url.replace(/^http:/, "ws:").replace(/\/$/, ""),
      remoteHubUrl: hubUrl,
    });

    expect((await app.interrupt()).status).toBe(0);
    // The hub this command did not start is the hub it did not stop.
    expect(await hubAnswers(box, hubUrl)).toBe(true);
  });

  it("releases both ports on Ctrl-C, so a second `ub open` succeeds at once", async () => {
    const { box, env } = configured();
    const hubPort = await freePort();
    const webPort = await freePort();
    const hubUrl = `ws://127.0.0.1:${hubPort}`;
    pointAt(box, hubUrl);

    const first = await open(box, ["--port", String(webPort)], env);
    expect(first.stdout()).toContain("started here");
    // A request first, so a keep-alive connection is open when the signal
    // arrives: `close()` alone waits for it, and the port would still be held.
    expect((await get(first.url)).status).toBe(200);
    expect((await first.interrupt()).status).toBe(0);

    expect((await probePort("127.0.0.1", webPort)).state).toBe("free");
    expect((await probePort("127.0.0.1", hubPort)).state).toBe("free");

    const second = await open(box, ["--port", String(webPort)], env);
    expect(second.url).toBe(`http://127.0.0.1:${webPort}/`);
    expect((await second.interrupt()).status).toBe(0);
  });

  it("exits and releases the serving role when its replica refresh loop stops", async () => {
    const { box, env } = configured();
    const upstream = await startHub(box);
    pointAt(box, `ws://127.0.0.1:${upstream.port}`);
    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);

    const databasePath = resolveMcpConfig({
      ...box.env,
      ...env,
      WORKSPACE_ID: WORKSPACE,
    }).databasePath;
    const database = openStore(databasePath);
    database.exec("DROP TABLE snapshots");
    database.close();

    const stopped = await app.wait();
    expect(stopped).toEqual({ status: 1, signal: null });
    expect(app.stderr()).toContain("local replica refresh failed");
    expect((await probePort("127.0.0.1", webPort)).state).toBe("free");

    // The same store and port can be served again immediately: the failed
    // process released its serving-role lock as part of the non-zero exit.
    const restarted = await open(box, ["--port", String(webPort)], env);
    expect((await restarted.interrupt()).status).toBe(0);
  });

  it("exits and releases the serving role when its replica is quarantined", async () => {
    const { box, env } = configured();
    const upstream = await startHub(box);
    const hubUrl = `ws://127.0.0.1:${upstream.port}`;
    pointAt(box, hubUrl);
    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);
    const room = directoryRoom(WORKSPACE);
    const remoteDoc = new Y.Doc();
    const remote = new HocuspocusProvider({
      url: hubUrl,
      name: room,
      document: remoteDoc,
      token: await authMessage(SECRET, "read-write"),
    });

    try {
      await waitUntil("the upstream peer to sync", () => remote.isSynced);
      const databasePath = resolveMcpConfig({
        ...box.env,
        ...env,
        WORKSPACE_ID: WORKSPACE,
      }).databasePath;
      const database = openStore(databasePath);
      database.exec(`
        CREATE TRIGGER refuse_updates
        BEFORE INSERT ON updates
        BEGIN
          SELECT RAISE(FAIL, 'simulated append refusal');
        END
      `);
      database.close();

      // A remote update is already in this engine replica when its observer
      // reaches the refused append, which is the quarantine boundary.
      remoteDoc.getMap("quarantine-probe").set("changed", true);
      const stopped = await app.wait();
      expect(stopped).toEqual({ status: 1, signal: null });
      const terminalLines = app
        .stderr()
        .split("\n")
        .filter((line) => line.startsWith("ub open: local replica quarantined"));
      expect(terminalLines).toHaveLength(1);
      expect(terminalLines[0]).toContain(room);
      expect(terminalLines[0]).toContain("simulated append refusal");
      expect((await probePort("127.0.0.1", webPort)).state).toBe("free");

      const repaired = openStore(databasePath);
      repaired.exec("DROP TRIGGER refuse_updates");
      repaired.close();
      const restarted = await open(box, ["--port", String(webPort)], env);
      expect((await restarted.interrupt()).status).toBe(0);
    } finally {
      remote.destroy();
      remoteDoc.destroy();
    }
  });

  it("names a taken port and refuses a second serving replica for the store", async () => {
    const { box, env } = configured();
    const foreignPort = await freePort();
    await answeringListener(foreignPort, 200, '{"not":"the config document"}');
    pointAt(box, "wss://hub.example.ts.net/ws");

    const foreign = await openFails(box, ["--port", String(foreignPort)], env);
    expect(foreign.status).toBe(1);
    expect(foreign.output).toContain(`port ${foreignPort}`);
    expect(foreign.output).toContain("another process");

    // A holder that never answers is nobody in particular, and the refusal for
    // it must not send the user to stop what may be their own `ub open` (#600).
    const silentPort = await freePort();
    await silentListener(silentPort);
    const silent = await openFails(box, ["--port", String(silentPort)], env);
    expect(silent.status).toBe(1);
    expect(silent.output).toContain(`port ${silentPort}`);
    expect(silent.output).toContain("--port");
    expect(silent.output).not.toContain("another process");
    expect(silent.output).not.toContain("`ub open`");
    expect(silent.output).not.toMatch(/stop/);

    const webPort = await freePort();
    const app = await open(box, ["--port", String(webPort)], env);
    const secondPort = await freePort();
    const second = await openFails(box, ["--port", String(secondPort)], env);
    expect(second.status).toBe(1);
    expect(second.output).toContain("`ub open`");
    expect(second.output).toContain(WORKSPACE);
    expect(second.output).toContain(".sqlite");
    expect(second.output).toContain("process");
    expect((await probePort("127.0.0.1", secondPort)).state).toBe("free");

    expect((await app.interrupt()).status).toBe(0);
  });

  it("identifies the port's holder from what it answers, not from the deadline", async () => {
    // Three holders, three behaviours, no race: each verdict follows from what
    // the holder does, so no ceiling on the probe's budget can change one.
    const servingPort = await freePort();
    await answeringListener(servingPort, 200, '{"hubUrl":"ws://127.0.0.1:1234"}');
    expect(await whoHoldsPort(servingPort)).toBe("ub-open");

    // A complete answer that is not the configuration document is the
    // definitive stranger — including a refusal, and a body that is not JSON.
    const refusingPort = await freePort();
    await answeringListener(refusingPort, 404, "no such thing");
    expect(await whoHoldsPort(refusingPort)).toBe("foreign");
    const gibberishPort = await freePort();
    await answeringListener(gibberishPort, 200, "<html>hello</html>");
    expect(await whoHoldsPort(gibberishPort)).toBe("foreign");

    const silentPort = await freePort();
    await silentListener(silentPort);
    expect(await whoHoldsPort(silentPort)).toBe("unidentified");
  });

  it("starts a hub only for an endpoint the hub it starts could answer", async () => {
    const { box, env } = configured();
    const port = await freePort();
    const webPort = await freePort();

    // A hub started here speaks plain ws on loopback. Announcing one at an
    // endpoint it does not answer would be a hub nothing can reach.
    pointAt(box, `wss://127.0.0.1:${port}`);
    const tls = await openFails(box, ["--port", String(webPort)], env);
    expect(tls.status).toBe(1);
    expect(tls.output).toContain("plain ws://");

    pointAt(box, "ws://127.0.0.1");
    const noPort = await openFails(box, ["--port", String(webPort)], env);
    expect(noPort.status).toBe(1);
    expect(noPort.output).toContain("names no port to bind");

    pointAt(box, "ws://127.0.0.1:0");
    const ephemeral = await openFails(box, ["--port", String(webPort)], env);
    expect(ephemeral.status).toBe(1);
    expect(ephemeral.output).toContain("names no port to bind");
  });

  it("an interrupt while it is still coming up stops the hub it started", async () => {
    const { box, env } = configured();
    const hubPort = await freePort();
    const webPort = await freePort();

    // Interrupted the instant the hub has bound its socket — before the web
    // server is up, and so before there is any banner.
    pointAt(box, `ws://127.0.0.1:${hubPort}`);
    const run = await interruptWhen(
      box,
      ["--port", String(webPort)],
      env,
      () => untilBound(hubPort),
    );

    // Exit 0, not death by signal: with the handlers installed only once
    // everything is up, Node's default SIGINT kills the process right here —
    // taking the hub down without the flush its durability contract is made of.
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.output).not.toContain("uberblick is at");
    expect((await probePort("127.0.0.1", webPort)).state).toBe("free");
    expect((await probePort("127.0.0.1", hubPort)).state).toBe("free");
  });

  it("refuses when the hub's endpoint is held by something that is not a hub", async () => {
    const { box, env } = configured();
    const hubPort = await freePort();
    await silentListener(hubPort);

    pointAt(box, `ws://127.0.0.1:${hubPort}`);
    const refused = await openFails(box, ["--port", String(await freePort())], env);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("held by something else");
    expect(refused.output).toContain(`ws://127.0.0.1:${hubPort}`);
  });
});
