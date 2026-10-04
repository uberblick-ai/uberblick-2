/**
 * `ub init <hub-url>` — a fresh machine, a new workspace, on a hub that exists.
 *
 * Its own suite because it serves a hub in this process, which `runUb`'s
 * blocking spawn cannot be used against (see `helpers.test.ts`); `init.test.ts`
 * keeps the offline bootstrap it always tested.
 *
 * What is asserted is the contract and not the mechanics: the endpoint that is
 * stored, that the starter corpus is on the hub when the command returns rather
 * than queued for a later client, that a second endpoint is refused instead of
 * overwritten, and that every refusal happens before a single file exists.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Hub } from "@uberblick/hub";
import { createHub, silentLogger } from "@uberblick/hub";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/hub/protocol";
import {
  bridgeConfig,
  inspectRemote,
  resolveMcpConfig,
} from "@uberblick/mcp-server";
import type { Corpus } from "@uberblick/mcp-server";
import { afterEach, describe, expect, it } from "vitest";
import type { Sandbox } from "./helpers.js";
import { removeTempDirs, runUbAsync, sandbox, waitUntil } from "./helpers.js";

const SECRET = "test-signing-secret-for-ub-init";
const OTHER_SECRET = "the-secret-that-hub-was-actually-deployed-with";
const WORKSPACE = "5f0b1c26-3d47-4a89-9e12-7c6b085af431";

/** A loopback port nothing listens on — an endpoint that cannot answer. */
const CLOSED = "ws://127.0.0.1:1";

const hubs: Hub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    await hub.stop();
  }
  removeTempDirs();
});

async function startHub(
  options: { authSecret?: string; protocolVersion?: number } = {},
): Promise<Hub> {
  const hub = await createHub({
    authSecret: options.authSecret ?? SECRET,
    port: 0,
    ...(options.protocolVersion === undefined
      ? {}
      : { protocolVersion: options.protocolVersion }),
    databasePath: join(sandbox().cwd, "hub.sqlite"),
    log: silentLogger,
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  });
  hubs.push(hub);
  return hub;
}

function url(hub: Hub): string {
  return `ws://127.0.0.1:${hub.port}`;
}

function configPath(box: Sandbox): string {
  return join(box.cwd, ".uberblick.json");
}

function credentialsPath(box: Sandbox): string {
  return join(box.configHome, "uberblick", "credentials.json");
}

function config(box: Sandbox): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(box), "utf8")) as Record<
    string,
    unknown
  >;
}

/** What a fresh client finds on the hub — no mirror, no local state. */
async function onHub(
  box: Sandbox,
  hub: Hub,
  workspace: string,
): Promise<Corpus> {
  return await inspectRemote(
    bridgeConfig(
      resolveMcpConfig({
        ...box.env,
        WORKSPACE_ID: workspace,
        HUB_URL: url(hub),
        HUB_AUTH_TOKEN: SECRET,
      }),
    ),
    { documents: true },
  );
}

describe("ub init <hub-url>", () => {
  it("creates the workspace on that hub, corpus and all, before it returns", async () => {
    const hub = await startHub();
    const box = sandbox();

    const run = await runUbAsync(["init", url(hub), "--yes"], box, {
      HUB_AUTH_TOKEN: SECRET,
    });

    expect(run.status).toBe(0);
    // A ws:// endpoint is what somebody who knows their hub typed, and is
    // stored exactly as typed.
    expect(config(box).hubUrl).toBe(url(hub));
    expect(run.stdout).toContain(url(hub));
    const workspace = config(box).workspaceId;
    expect(typeof workspace).toBe("string");

    // The whole point of doing it in this run: the starter documents are on the
    // hub, not sitting in the local log waiting for a client to be started.
    // Fingerprints, so this is the rooms and not merely the directory.
    const corpus = await onHub(box, hub, workspace as string);
    expect(corpus.hub.status).toBe("connected");
    expect(corpus.complete).toBe(true);
    expect(corpus.missing).toEqual([]);
    expect(corpus.entries).toHaveLength(2);
    for (const doc of corpus.entries) {
      expect(doc.fingerprint).not.toBeNull();
    }
  });

  it("changes nothing when it is given the endpoint already in force", async () => {
    const hub = await startHub();
    const box = sandbox();
    const first = await runUbAsync(["init", url(hub), "--yes"], box, {
      HUB_AUTH_TOKEN: SECRET,
    });
    expect(first.status).toBe(0);
    const settled = readFileSync(configPath(box), "utf8");

    // Without the secret this time, which is the case that has to be a real
    // no-op: falling through would generate a random local secret for a machine
    // whose hub has its own, write it, and seed with a credential that hub
    // refuses.
    const again = await runUbAsync(["init", url(hub), "--yes"], box);

    expect(again.status).toBe(0);
    expect(again.stdout).toContain("already set up");
    // The same workspace, the same identity, the same endpoint — byte for byte.
    expect(readFileSync(configPath(box), "utf8")).toBe(settled);
    expect(existsSync(credentialsPath(box))).toBe(false);
  });

  it("decides on the endpoint under the lock, not on what it read before it", async () => {
    // Two runs can both find no binding, both pass their probe, and then
    // serialize on the init lock. The second must not overwrite the endpoint the
    // first published — that is the endpoint-only retarget this command refuses,
    // arrived at by a race rather than by an argument. Held by hand, so the
    // interleave is a fact rather than a hope.
    const hub = await startHub();
    const first = "ws://127.0.0.1:2";
    const box = sandbox();
    const lock = join(box.configHome, "uberblick", ".init.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "999999\n");

    let waiting = false;
    const running = runUbAsync(
      ["init", url(hub), "--yes"],
      box,
      { HUB_AUTH_TOKEN: SECRET },
      undefined,
      (stderr) => {
        waiting ||= stderr.includes("waiting for another `ub init`");
      },
    );
    await waitUntil("`ub init` to say it is waiting for the lock", () => waiting);
    // What the run that got there first left behind.
    writeFileSync(
      configPath(box),
      `${JSON.stringify({ workspace: WORKSPACE, hubUrl: first }, null, 2)}\n`,
    );
    rmSync(lock);

    const run = await running;
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(first);
    expect(run.stderr).toContain("Nothing was written");
    // One endpoint, and it is the one that got there first.
    expect(config(box).hubUrl).toBe(first);
    expect(config(box).workspaceId).toBe(WORKSPACE);
  });

  it("applies the bound-machine rules to an endpoint that arrived under the lock", async () => {
    // A run with no hub argument passes its pre-lock checks on an unbound
    // machine, loses the lock to an `ub init <hub-url>`, and would otherwise
    // reach the generating branch with an endpoint now stored — a random secret
    // written for a hub that has its own, arrived at by a race. The winner's
    // credential is not visible to this process, which is the case that has to
    // refuse rather than invent one.
    const box = sandbox();
    const lock = join(box.configHome, "uberblick", ".init.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "999999\n");

    let waiting = false;
    const running = runUbAsync(["init", "--yes"], box, {}, undefined, (stderr) => {
      waiting ||= stderr.includes("waiting for another `ub init`");
    });
    await waitUntil("`ub init` to say it is waiting for the lock", () => waiting);
    writeFileSync(
      configPath(box),
      `${JSON.stringify({ workspace: WORKSPACE, hubUrl: CLOSED }, null, 2)}\n`,
    );
    rmSync(lock);

    const run = await running;
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("HUB_AUTH_TOKEN");
    expect(run.stderr).toContain("credentials.json");
    expect(run.stderr).toContain("Nothing was written");
    // No random secret for a machine somebody else bound.
    expect(existsSync(credentialsPath(box))).toBe(false);
    expect(config(box).hubUrl).toBe(CLOSED);
  });

  it("refuses a bound machine with no credential, hub argument or not", async () => {
    // The accepted exception to "no argument is what it always was": a machine
    // with an endpoint needs that hub's secret, and `ub init` says so instead of
    // writing a random one every later run would send and every hub reject.
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: CLOSED }, userConfig: { workspace: WORKSPACE, hubUrl: CLOSED } });

    const run = await runUbAsync(["init", "--yes"], box);

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("HUB_AUTH_TOKEN");
    expect(run.stderr).toContain("credentials.json");
    expect(existsSync(credentialsPath(box))).toBe(false);
  });

  it("refuses when the credential changes between the probe and the write", async () => {
    // The probe proves one value works on that hub. If the file it came from
    // has changed by the time the write phase runs, the run would seed with a
    // secret no hub has answered for — so it refuses instead.
    const hub = await startHub();
    const box = sandbox({ credentials: { signingSecret: SECRET } });
    const lock = join(box.configHome, "uberblick", ".init.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "999999\n");

    let waiting = false;
    const running = runUbAsync(
      ["init", url(hub), "--yes"],
      box,
      {},
      undefined,
      (stderr) => {
        waiting ||= stderr.includes("waiting for another `ub init`");
      },
    );
    await waitUntil("`ub init` to say it is waiting for the lock", () => waiting);
    writeFileSync(
      credentialsPath(box),
      `${JSON.stringify({ signingSecret: OTHER_SECRET }, null, 2)}\n`,
    );
    rmSync(lock);

    const run = await running;
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("signing secret changed");
    expect(existsSync(configPath(box))).toBe(false);
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toContain(OTHER_SECRET);
  });

  it("refuses two different signing secrets rather than picking one", async () => {
    // The environment and the file must not disagree about the credential a
    // bound machine sends: whichever this run preferred, the other is what some
    // other reader on this machine would use.
    const box = sandbox({ credentials: { signingSecret: OTHER_SECRET } });

    const run = await runUbAsync(["init", CLOSED, "--yes"], box, {
      HUB_AUTH_TOKEN: SECRET,
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("different signing secrets");
    // Refused on what is on disk, before anything is dialled or written.
    expect(run.stderr).not.toContain("did not answer");
    expect(existsSync(configPath(box))).toBe(false);
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toContain(OTHER_SECRET);
    expect(
      (
        JSON.parse(readFileSync(credentialsPath(box), "utf8")) as {
          signingSecret: string;
        }
      ).signingSecret,
    ).toBe(OTHER_SECRET);
  });

  it("counts a credentials file whose mode is wrong as a value that must agree", async () => {
    // The file `ub init` would repair and keep. Read as absent, its value would
    // slip past the conflict check and then win the seed — the run would
    // authenticate with the environment's secret and write with this one.
    const box = sandbox({
      credentials: { signingSecret: OTHER_SECRET },
      credentialsMode: 0o644,
    });

    const run = await runUbAsync(["init", CLOSED, "--yes"], box, {
      HUB_AUTH_TOKEN: SECRET,
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("different signing secrets");
    expect(run.stderr).not.toContain("did not answer");
    expect(existsSync(configPath(box))).toBe(false);
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toContain(OTHER_SECRET);
  });

  it("exits non-zero when the starter documents do not reach the hub", async () => {
    // The promise a hub argument adds is that the hub *holds* the workspace when
    // this returns, so an unacknowledged seed is a failure and not a warning.
    // The hub goes away between the probe and the seed, which the lock makes an
    // exact moment rather than a race.
    const hub = await startHub();
    const endpoint = url(hub);
    const box = sandbox();
    const lock = join(box.configHome, "uberblick", ".init.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "999999\n");

    let waiting = false;
    const running = runUbAsync(
      ["init", endpoint, "--yes"],
      box,
      { HUB_AUTH_TOKEN: SECRET },
      undefined,
      (stderr) => {
        waiting ||= stderr.includes("waiting for another `ub init`");
      },
    );
    await waitUntil("`ub init` to say it is waiting for the lock", () => waiting);
    for (const started of hubs.splice(0)) {
      await started.stop();
    }
    rmSync(lock);

    const run = await running;
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("did not reach");
    expect(run.stderr).toContain("ub open");
    // Local state stands: this machine is configured, and the documents are in
    // its update log — there is nothing to repair, only to get up.
    expect(run.stdout).toContain("uberblick initialised");
    expect(config(box).hubUrl).toBe(endpoint);
    expect(typeof config(box).workspaceId).toBe("string");
  });

  it("refuses a second endpoint, naming the verb that moves a machine", async () => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: "ws://127.0.0.1:2" },
      userConfig: { workspace: WORKSPACE, hubUrl: "ws://127.0.0.1:2" },
    });
    const before = readFileSync(configPath(box), "utf8");

    const run = await runUbAsync(["init", CLOSED, "--yes"], box, {
      HUB_AUTH_TOKEN: SECRET,
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("ws://127.0.0.1:2");
    expect(run.stderr).toContain(`ub remote join ${CLOSED}/${WORKSPACE}`);
    // Refused on what is on disk, before anything is dialled.
    expect(run.stderr).not.toContain("did not answer");
    expect(readFileSync(configPath(box), "utf8")).toBe(before);
    expect(existsSync(credentialsPath(box))).toBe(false);
  });

  it("refuses an endpoint that does not answer, before anything exists", async () => {
    const box = sandbox();

    const run = await runUbAsync(["init", CLOSED, "--yes"], box, {
      HUB_AUTH_TOKEN: SECRET,
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("did not answer");
    expect(run.stderr).toContain("Nothing was written");
    expect(existsSync(configPath(box))).toBe(false);
    expect(existsSync(credentialsPath(box))).toBe(false);
  });

  it("refuses a hub that rejects the secret this machine holds", async () => {
    const hub = await startHub({ authSecret: OTHER_SECRET });
    const box = sandbox();

    const run = await runUbAsync(["init", url(hub), "--yes"], box, {
      HUB_AUTH_TOKEN: SECRET,
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("rejected the credential");
    expect(existsSync(configPath(box))).toBe(false);
    expect(run.output).not.toContain(SECRET);
  });

  it("refuses a hub speaking another sync protocol, in that hub's terms", async () => {
    const hub = await startHub({ protocolVersion: SYNC_PROTOCOL_VERSION + 1 });
    const box = sandbox();

    const run = await runUbAsync(["init", url(hub), "--yes"], box, {
      HUB_AUTH_TOKEN: SECRET,
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("different sync protocol");
    // The refusal a person can act on, not the one that sends them to check
    // whether the deployment is running — it is.
    expect(run.stderr).not.toContain("did not answer");
    expect(existsSync(configPath(box))).toBe(false);
  });

  it("refuses before dialling when no secret is here to authenticate with", async () => {
    const box = sandbox();

    const run = await runUbAsync(["init", CLOSED, "--yes"], box);

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("HUB_AUTH_TOKEN");
    expect(run.stderr).toContain("credentials.json");
    expect(run.stderr).not.toContain("did not answer");
    expect(existsSync(configPath(box))).toBe(false);
    expect(existsSync(credentialsPath(box))).toBe(false);
  });

  it("fails the same way on a machine that was already bound", async () => {
    // The promise is about the endpoint in force, not about which run stored
    // it: a retry on a bound machine whose hub is down must not report a hub
    // holding a corpus it has never seen.
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: CLOSED },
      userConfig: { workspace: WORKSPACE, hubUrl: CLOSED },
      credentials: { signingSecret: SECRET },
    });

    const run = await runUbAsync(["init", "--yes"], box);

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("did not reach");
    expect(run.stderr).toContain("ub open");
    expect(run.stdout).toContain("uberblick initialised");
    expect(config(box).hubUrl).toBe(CLOSED);
  });

  it("agrees with `ub remote join` about the endpoint that is stored", async () => {
    // The two verbs write the same file, so a spelling one accepts and the
    // other rewrites would make `ub init` refuse the hub this machine is
    // already joined to. Same string in, same string stored, and the second
    // command has nothing left to do.
    const hub = await startHub();
    const box = sandbox();

    const joined = await runUbAsync(
      ["remote", "join", `${url(hub)}/${WORKSPACE}`],
      box,
      { HUB_AUTH_TOKEN: SECRET },
    );
    expect(joined.status, joined.output).toBe(0);
    expect(config(box).hubUrl).toBe(url(hub));
    const settled = readFileSync(configPath(box), "utf8");

    const run = await runUbAsync(["init", url(hub), "--yes"], box, {
      HUB_AUTH_TOKEN: SECRET,
    });

    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toContain("already set up");
    expect(config(box).workspaceId).toBe(WORKSPACE);
    expect(readFileSync(configPath(box), "utf8")).toBe(settled);
  });

  it("refuses something that is not an endpoint at all, echoing none of it", async () => {
    const box = sandbox();

    const run = await runUbAsync(["init", "not a hub", "--yes"], box, {
      HUB_AUTH_TOKEN: SECRET,
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("is not a URL");
    expect(existsSync(configPath(box))).toBe(false);

    // A URL somebody pasted a credential into is exactly the kind that fails to
    // parse, and repeating it is how the credential reaches a terminal log.
    const pasted = await runUbAsync(
      ["init", "wss://user:hunter2@hub.example.ts.net:notaport/ws", "--yes"],
      box,
      { HUB_AUTH_TOKEN: SECRET },
    );
    expect(pasted.status).toBe(2);
    expect(pasted.output).not.toContain("hunter2");
    expect(existsSync(configPath(box))).toBe(false);
  });
});
