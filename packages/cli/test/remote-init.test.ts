/**
 * `ub remote init` and `ub remote update`, against a stub SSH transport.
 *
 * The command's whole job is delegation: the right programs, with the right
 * argument vectors, in the right order, and one payload that must travel on
 * stdin rather than in any of them. So `ssh`, `gh` and `tailscale` are stubs on
 * `PATH` that record what they were called with and answer from a script the
 * test writes — the technique `ub mcp install` uses for the vendor CLIs. A
 * Linux tailnet host is #98's, not this suite's.
 *
 * What is asserted, and nothing else: the recorded sequence and the `.env`
 * payload; that the three tailscale failure modes are told apart; that nothing
 * scheduled is installed on the host, updates being deliberate; that the
 * signing secret is in no argument vector and on neither stream; that a failed
 * `up` persists nothing; which way the workspace hands off; and that a second
 * run is a no-op.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, resolveMcpConfig } from "@uberblick/mcp-server";
import { parseWorkspaceId } from "@uberblick/schema";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readUserConfig } from "../src/config.js";
import type { Io } from "../src/io.js";
import {
  remoteInitCommand,
  remoteUpdateCommand,
  upgradeWebsocket,
} from "../src/remote-init.js";
import { type Sandbox, removeTempDirs, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

const SECRET = "test-signing-secret-never-in-argv";
const WORKSPACE = "b7c3d914-5a20-4e6f-8d13-9f04a2c68e75";
const TARGET = "uberblick@box";
const MAGIC_DNS = "uberblick.tail9f2.ts.net";
const TAILSCALE_IP = "100.83.4.11";
const HOST_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL7fakekeymaterialforthetestsuite0 uberblick-deploy@box";

/** What the host's preflight reports on a fresh, healthy machine. */
const HEALTHY: Record<string, string> = {
  user: "uberblick",
  hostname: "box",
  compose: "5.0.0",
  git: "yes",
  tailscale: "yes",
  checkout: "absent",
  deploykey: "none",
};

/** Records argv and stdin, then answers from the test's own `case` script. */
function stubProgram(program: string): string {
  return `#!/bin/sh
count=$(ls "$UB_TEST_RECORD" | wc -l | tr -d ' ')
{
  for a in "$@"; do printf '%s\\0' "$a"; done
  printf 'ENV\\0'
  env | tr '\\n' '\\0'
  printf 'STDIN\\0'
  cat
} > "$UB_TEST_RECORD/$(printf '%03d' "$count")-${program}"
if [ -f "$UB_TEST_BEHAVIOR/${program}.sh" ]; then . "$UB_TEST_BEHAVIOR/${program}.sh"; fi
exit 0
`;
}

interface Host {
  /** Overrides for what the preflight reports. */
  facts?: Record<string, string>;
  /** Extra `case` clauses for the ssh stub, matched before the defaults. */
  ssh?: string;
  /** The body of `gh api …/keys`. */
  keys?: string;
}

function sshBehavior(host: Host): string {
  const facts = { ...HEALTHY, ...host.facts };
  const preflight = Object.entries(facts)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  return `case "$*" in
${host.ssh ?? ""}
  *"uberblick:preflight"*)
    cat <<'FACTS'
${preflight}
FACTS
    ;;
  *"tailscale status --json"*)
    printf '%s\\n' '{"Self":{"DNSName":"${MAGIC_DNS}.","TailscaleIPs":["${TAILSCALE_IP}"]}}'
    ;;
  *"tailscale ip -4"*) printf '%s\\n' '${TAILSCALE_IP}' ;;
  *"uberblick:ensure-key"*) printf '%s\\n' '${HOST_KEY}' ;;
  *"uberblick:logs"*) printf 'hub | boom\\n' ;;
esac
`;
}

interface Step {
  program: string;
  args: string[];
  /** `NAME=value` for every variable the spawned process inherited. */
  env: string[];
  stdin: string;
}

interface Harness {
  box: Sandbox;
  env: NodeJS.ProcessEnv;
  io: Io;
  out(): string;
  err(): string;
  output(): string;
  steps(): Step[];
  labels(): string[];
}

function harness(host: Host = {}, box: Sandbox = sandbox({ credentials: { signingSecret: SECRET } })): Harness {
  const stubs = join(box.cwd, "..", "stubs");
  const record = join(box.cwd, "..", "record");
  const behavior = join(box.cwd, "..", "behavior");
  for (const dir of [stubs, record, behavior]) mkdirSync(dir, { recursive: true });
  for (const program of ["ssh", "gh", "tailscale"]) {
    const path = join(stubs, program);
    writeFileSync(path, stubProgram(program), "utf8");
    chmodSync(path, 0o755);
  }
  writeFileSync(join(behavior, "ssh.sh"), sshBehavior(host), "utf8");
  writeFileSync(
    join(behavior, "gh.sh"),
    `case "$*" in\n  *keys*) printf '%s\\n' '${host.keys ?? "[]"}' ;;\nesac\n`,
    "utf8",
  );
  writeFileSync(
    join(behavior, "tailscale.sh"),
    `printf '%s\\n' '{"Self":{"DNSName":"laptop.tail9f2.ts.net."}}'\n`,
    "utf8",
  );

  let out = "";
  let err = "";
  return {
    box,
    env: {
      ...box.env,
      WORKSPACE_ID: WORKSPACE,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      UB_TEST_RECORD: record,
      UB_TEST_BEHAVIOR: behavior,
    },
    io: {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
    out: () => out,
    err: () => err,
    output: () => `${out}${err}`,
    steps: () =>
      readdirSync(record)
        .sort()
        .map((name) => {
          const parts = readFileSync(join(record, name), "utf8").split("\0");
          const environment = parts.indexOf("ENV");
          const marker = parts.indexOf("STDIN");
          return {
            program: name.slice(4),
            args: parts.slice(0, environment),
            env: parts.slice(environment + 1, marker),
            stdin: parts.slice(marker + 1).join("\0"),
          };
        }),
    labels() {
      return this.steps().map(label);
    },
  };
}

/**
 * One recorded invocation as a line: the remote script's marker comment where
 * there is one, so the assertion reads as the sequence a person would describe.
 */
function label(step: Step): string {
  if (step.program === "ssh") {
    // Past `-o BatchMode=yes`: the target and the remote command.
    const [target, script] = step.args.slice(2);
    const marker = /^# (uberblick:[\w-]+)/.exec(script ?? "");
    return `ssh ${target} ${marker === null ? (script ?? "").trim() : marker[1]}`;
  }
  if (step.program === "gh") {
    // The temporary public-key path and the fingerprinted title are not part of
    // the sequence; they are asserted where they matter.
    return `gh ${step.args.slice(0, step.args[0] === "api" ? 2 : 3).join(" ")}`;
  }
  return `${step.program} ${step.args.join(" ")}`;
}

function stepFor(rig: Harness, marker: string): Step {
  const found = rig.steps().find((step) => step.args.some((arg) => arg.includes(marker)));
  if (found === undefined) throw new Error(`no recorded step for ${marker}`);
  return found;
}

/** A successful init, with the network verification injected. */
function init(rig: Harness, args: string[] = [TARGET]): Promise<number> {
  return remoteInitCommand(args, rig.io, {
    env: rig.env,
    cwd: rig.box.cwd,
    reach: async () => null,
  });
}

/** Put one document in the local update log, the way an MCP session does. */
async function createDocument(box: Sandbox): Promise<void> {
  const instance = createMcpServer(
    // No signing secret: this writes to the log and nothing else.
    resolveMcpConfig({ ...box.env, WORKSPACE_ID: WORKSPACE }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "uberblick-cli-tests", version: "0.0.0" });
  await Promise.all([
    instance.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    await client.callTool({
      name: "create_doc",
      arguments: {
        title: "held here",
        description: "A test document.",
        blocks: [{ type: "paragraph", text: "body" }],
      },
    });
  } finally {
    await client.close();
    await instance.close();
  }
}

describe("ub remote init", () => {
  it("keeps every accepted workspace spelling inside the compose charset", () => {
    // remote-compose.sh interpolates this value into JSON, so schema's accepted
    // grammar must remain a subset of its explicit deployment rule.
    const composeWebWorkspaces = /^[A-Za-z0-9,-]+$/;
    const accepted = [
      WORKSPACE,
      `uberblick-${WORKSPACE}`,
      `abcdefghijklmnopqrstuvwxyz0123456789-${WORKSPACE}`,
      `2026-${WORKSPACE}`,
      `team-one-${WORKSPACE}`,
    ];

    for (const value of accepted) {
      expect(() => parseWorkspaceId(value)).not.toThrow();
      expect(value).toMatch(composeWebWorkspaces);
    }
  });

  it("runs the whole sequence, and writes .env from stdin", async () => {
    const rig = harness();
    expect(await init(rig)).toBe(0);

    expect(rig.labels()).toEqual([
      "tailscale status --json",
      `ssh ${TARGET} uberblick:preflight`,
      `ssh ${TARGET} tailscale status --json`,
      `ssh ${TARGET} tailscale ip -4`,
      "gh api repos/uberblick-ai/uberblick-2/keys",
      `ssh ${TARGET} uberblick:ensure-key`,
      "gh repo deploy-key add",
      `ssh ${TARGET} uberblick:clone`,
      `ssh ${TARGET} uberblick:env`,
      `ssh ${TARGET} uberblick:up`,
    ]);
    expect(rig.out()).toContain(`https://${MAGIC_DNS}/`);

    // The clone carries its own credential, so the updater needs no environment.
    expect(stepFor(rig, "uberblick:clone").args.join("\n")).toContain(
      "git -c core.sshCommand='ssh -i ~/.ssh/uberblick-deploy -o IdentitiesOnly=yes' clone --branch main",
    );
    // The payload, exactly — and on stdin.
    expect(stepFor(rig, "uberblick:env").stdin).toBe(
      "# Written by `ub remote init`. Untracked, so updates never touch it.\n" +
        `TAILSCALE_HOST=${MAGIC_DNS}\nTAILSCALE_IP=${TAILSCALE_IP}\nHUB_AUTH_TOKEN=${SECRET}\n` +
        `WEB_WORKSPACES=${WORKSPACE}\n`,
    );
    expect(stepFor(rig, "uberblick:up").args.join("\n")).toContain(
      "sh remote-compose.sh up --build --detach",
    );
    // The title carries a fingerprint, so two hosts called `box` never alias.
    const added = rig.steps().find((step) => step.args[1] === "deploy-key") as Step;
    expect(added.args).toContain("--repo");
    expect(added.args[added.args.indexOf("--title") + 1]).toMatch(/^uberblick-box-.{12}$/);
  });

  it("keeps the signing secret out of every argument vector, environment and stream", async () => {
    const rig = harness();
    // The shape `fnox exec` and the mise tasks leave: the secret is exported
    // into this process, so every child would inherit it by default.
    rig.env.HUB_AUTH_TOKEN = SECRET;
    expect(await init(rig)).toBe(0);

    for (const step of rig.steps()) {
      expect(step.args.join("\n")).not.toContain(SECRET);
      // Readable from /proc/<pid>/environ, and inherited onwards by whatever
      // the vendor spawns next — so it must not be there either.
      expect(step.env.join("\n")).not.toContain(SECRET);
      expect(step.env.some((entry) => entry.startsWith("HUB_AUTH_TOKEN="))).toBe(false);
    }
    expect(rig.output()).not.toContain(SECRET);
    // It travelled, though — on the one channel that is not argv.
    expect(stepFor(rig, "uberblick:env").stdin).toContain(SECRET);
    // And the private half of the deploy key was never in a payload either.
    expect(rig.steps().map((step) => step.stdin).join("\n")).not.toContain("PRIVATE KEY");
  });

  it("names which of the three tailscale failures it was, and refuses", async () => {
    const modes: { host: Host; expected: RegExp }[] = [
      {
        host: { facts: { tailscale: "no" } },
        expected: /tailscale is not installed/,
      },
      {
        host: {
          ssh: `  *"tailscale status --json"*) echo "failed to connect to local tailscaled" >&2; exit 1 ;;`,
        },
        expected: /tailscaled is not up.*tailscale up/s,
      },
      {
        host: {
          ssh: `  *"tailscale status --json"*) echo "Access denied: this command is available only to the tailscale operator" >&2; exit 1 ;;`,
        },
        // The only one of the three with a one-line fix.
        expected: /tailscale set --operator=uberblick/,
      },
    ];

    for (const mode of modes) {
      const rig = harness(mode.host);
      expect(await init(rig)).toBe(1);
      expect(rig.err()).toMatch(mode.expected);
      // Non-interactive and without the flags: it says what it could not detect.
      expect(rig.err()).toMatch(/could not detect .*--host <fqdn> --ip <v4>/s);
      expect(rig.labels().join("\n")).not.toContain("uberblick:clone");
    }
  });

  it("takes --host and --ip in place of detection", async () => {
    const rig = harness({ facts: { tailscale: "no" } });
    expect(await init(rig, [TARGET, "--host", MAGIC_DNS, "--ip", TAILSCALE_IP])).toBe(0);
    expect(rig.labels()).not.toContain(`ssh ${TARGET} tailscale status --json`);
    expect(stepFor(rig, "uberblick:env").stdin).toContain(`TAILSCALE_HOST=${MAGIC_DNS}`);
  });

  it("refuses before touching the host when no workspace is configured", async () => {
    const rig = harness();
    delete rig.env.WORKSPACE_ID;
    expect(await init(rig)).toBe(2);
    expect(rig.err()).toContain("Run `ub init`");
    expect(rig.steps()).toEqual([]);
  });

  it("schedules nothing on the host, and says the host does not update itself", async () => {
    const rig = harness();
    expect(await init(rig)).toBe(0);
    // The posture, not an implementation detail: an unattended updater would
    // deploy a wire-semantics change to production with nobody present.
    const sent = rig.steps().map((step) => step.args.join("\n")).join("\n");
    expect(sent).not.toMatch(/systemctl|\.timer|enable-linger/);
    expect(rig.out()).toContain("does not update itself");
    expect(rig.out()).toContain("ub remote update");
  });

  it("prints the logs and persists nothing when the stack does not come up", async () => {
    const rig = harness({
      ssh: `  *"uberblick:up"*) echo "compose said no" >&2; exit 1 ;;`,
    });
    expect(await init(rig)).toBe(1);
    expect(rig.err()).toContain("hub | boom");
    expect(existsSync(join(rig.box.configHome, "uberblick", "config.json"))).toBe(false);
  });

  it("persists the endpoint when this workspace holds no documents", async () => {
    const rig = harness();
    expect(await init(rig)).toBe(0);
    expect(readUserConfig(rig.env).raw?.hubUrl).toBe(`wss://${MAGIC_DNS}/ws`);
    expect(rig.out()).toContain(`wss://${MAGIC_DNS}/ws`);
  });

  it("switches nothing when it does, and names the promote command", async () => {
    const box = sandbox({ credentials: { signingSecret: SECRET } });
    await createDocument(box);
    const rig = harness({}, box);

    expect(await init(rig)).toBe(0);
    expect(rig.out()).toContain(`ub remote promote wss://${MAGIC_DNS}/ws`);
    expect(readUserConfig(rig.env).raw?.hubUrl).toBeUndefined();
  });

  // The whole of what a second machine has to be told, in one string it can
  // paste: the endpoint with this workspace's id on the end. Printed either
  // way, because the workspace reaches the hub by `promote` or by being empty
  // already, and a second machine binds to it the same way afterwards.
  it("prints the join URL a second machine binds to", async () => {
    const empty = harness();
    expect(await init(empty)).toBe(0);
    expect(empty.out()).toContain(
      `ub remote join wss://${MAGIC_DNS}/ws/${WORKSPACE}`,
    );

    const box = sandbox({ credentials: { signingSecret: SECRET } });
    await createDocument(box);
    const held = harness({}, box);
    expect(await init(held)).toBe(0);
    expect(held.out()).toContain(
      `ub remote join wss://${MAGIC_DNS}/ws/${WORKSPACE}`,
    );
  });

  it("is a no-op against a host it already initialised", async () => {
    const rig = harness({
      facts: { checkout: "present", deploykey: HOST_KEY },
      keys: `[{"id":1,"title":"uberblick-box-something","key":"${HOST_KEY}"}]`,
    });
    expect(await init(rig)).toBe(0);

    const labels = rig.labels();
    // No second key, and detection is by the key itself rather than the title.
    expect(labels.join("\n")).not.toContain("ensure-key");
    expect(labels.join("\n")).not.toContain("deploy-key add");
    // And no second clone: the existing checkout is fast-forwarded.
    expect(labels).toContain(`ssh ${TARGET} uberblick:fast-forward`);
    expect(labels.join("\n")).not.toContain("uberblick:clone");
    expect(stepFor(rig, "uberblick:fast-forward").args.join("\n")).toContain(
      "git merge --ff-only origin/main",
    );
  });

  it("reports replacing a different workspace on a re-run", async () => {
    const rig = harness({
      facts: {
        checkout: "present",
        deploykey: HOST_KEY,
        webworkspaces: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      keys: `[{"id":1,"title":"uberblick-box-something","key":"${HOST_KEY}"}]`,
    });

    expect(await init(rig)).toBe(0);
    expect(rig.out()).toContain(
      `Replaced the host's WEB_WORKSPACES with \`${WORKSPACE}\`.`,
    );
  });

  it("keeps an identical workspace assignment silent on a re-run", async () => {
    const rig = harness({
      facts: {
        checkout: "present",
        deploykey: HOST_KEY,
        webworkspaces: WORKSPACE,
      },
      keys: `[{"id":1,"title":"uberblick-box-something","key":"${HOST_KEY}"}]`,
    });

    expect(await init(rig)).toBe(0);
    expect(rig.out()).not.toContain("WEB_WORKSPACES");
    expect(
      stepFor(rig, "uberblick:env").stdin
        .split("\n")
        .filter((line) => line.startsWith("WEB_WORKSPACES=")),
    ).toEqual([`WEB_WORKSPACES=${WORKSPACE}`]);
  });
});

describe("the /ws probe", () => {
  /**
   * A server that holds the handshake to RFC 6455: the key must decode to 16
   * bytes, and the answer proves the server understood it. `wrongAccept` is the
   * other half — 101 alone is not a websocket endpoint.
   */
  async function handshakeServer(
    options: { wrongAccept?: boolean } = {},
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const sockets: Socket[] = [];
    const server = createServer();
    server.on("upgrade", (incoming, socket: Socket) => {
      sockets.push(socket);
      const key = incoming.headers["sec-websocket-key"] ?? "";
      if (Buffer.from(key, "base64").length !== 16) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      const accept = options.wrongAccept === true
        ? "not-the-accept-value"
        : createHash("sha1")
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the handshake server did not bind a port");
    }
    return {
      url: `http://127.0.0.1:${address.port}/ws`,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  it("completes a compliant handshake and checks what came back", async () => {
    const good = await handshakeServer();
    try {
      expect(await upgradeWebsocket(good.url)).toBeNull();
    } finally {
      await good.close();
    }

    const liar = await handshakeServer({ wrongAccept: true });
    try {
      expect(await upgradeWebsocket(liar.url)).toMatch(/Sec-WebSocket-Accept/);
    } finally {
      await liar.close();
    }
  });
});

describe("ub remote update", () => {
  it("runs the host's own updater and relays what it said", async () => {
    const rig = harness({
      ssh: `  *"uberblick:update"*) printf 'uberblick-update: up to date at abc123\\n' ;;`,
    });
    expect(await remoteUpdateCommand([TARGET], rig.io, { env: rig.env })).toBe(0);
    expect(rig.out()).toContain("up to date at abc123");
    expect(stepFor(rig, "uberblick:update").args.join("\n")).toContain("sh remote-update.sh");
  });

  it("fails when the host's updater fails", async () => {
    const rig = harness({
      ssh: `  *"uberblick:update"*) echo "build failed" >&2; exit 1 ;;`,
    });
    expect(await remoteUpdateCommand([TARGET], rig.io, { env: rig.env })).toBe(1);
    expect(rig.err()).toContain("build failed");
  });
});
