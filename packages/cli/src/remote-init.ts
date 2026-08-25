/**
 * `ub remote init` — stand up the Tailscale-only remote from this machine, and
 * `ub remote update` — deploy on demand.
 *
 * The machine running this already holds everything the host needs: the signing
 * secret (`credentials.json`), SSH access to the host, and a GitHub login.
 * Nothing is copied by hand.
 *
 * **Nothing is deployed *from* here.** The host clones `main` from GitHub and
 * keeps itself current with a systemd user timer running `remote-update.sh` out
 * of that checkout. Deploying this machine's checkout was considered and
 * rejected: with more than one user it deploys whichever version somebody
 * happened to have, and it needs a human every time.
 *
 * **The consequence, stated plainly: anyone who can merge to `main` can execute
 * code on the host within five minutes.** The updater resets to `origin/main`
 * and runs `docker compose up --build` unattended. That is the accepted
 * tradeoff for a host whose whole purpose is to follow `main`, and it is why
 * `--no-auto-update` exists.
 *
 * **The signing secret travels over stdin and nowhere else.** Never in argv on
 * either side — argv is in every `ps` listing and every shell history — never
 * echoed, and never in an error message. The deploy key's private half is
 * generated on the host and never leaves it.
 *
 * Every step is idempotent, because the second run of a command that stood up a
 * host is how somebody repairs one: the key is generated only when absent and
 * registered only when GitHub does not already hold it (matched by key
 * material, never by title), an existing checkout is fast-forwarded instead of
 * re-cloned, and enabling an already-enabled timer changes nothing.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  bridgeConfig,
  liveDocs,
  resolveMcpConfig,
  syncWorkspace,
} from "@uberblick/mcp-server";
import type { McpConfig } from "@uberblick/mcp-server";
import { resolveConfig } from "./config.js";
import type { Io } from "./io.js";
import { processIo } from "./io.js";
import { setRemote } from "./remote.js";

/** The repository the host tracks. Public or private, this is the only source. */
const REPO = "uberblick-ai/uberblick-2";

/** Cloned over SSH with the host's own deploy key; see {@link SSH_COMMAND}. */
const CLONE_URL = `git@github.com:${REPO}.git`;

const DEFAULT_DIR = "~/uberblick-remote";

/** The host's read-only credential. Generated there, never transferred. */
const KEY_PATH = "~/.ssh/uberblick-deploy";

/**
 * Set on the clone itself, so the updater needs no environment of its own — it
 * runs from a timer with no agent, no login session and no forwarded keys.
 */
const SSH_COMMAND = `ssh -i ${KEY_PATH} -o IdentitiesOnly=yes`;

const TIMER_UNIT = "uberblick-update.timer";

/** The character set `remote-compose.sh` enforces on the deployed secret. */
const SAFE_SECRET = /^[A-Za-z0-9._-]+$/;

const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export const REMOTE_INIT_USAGE = `usage: ub remote init <ssh-target> [options]
       ub remote update <ssh-target> [--dir <path>]

options:
  --dir <path>       checkout directory on the host (default ${DEFAULT_DIR})
  --host <fqdn>      the host's MagicDNS name, when detection cannot see it
  --ip <v4>          the host's Tailscale IPv4, likewise
  --no-auto-update   install the stack without the five-minute update timer
`;

// --- talking to the two vendor commands ------------------------------------

interface Ran {
  /** Null when the program could not be run at all. */
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The environment a vendor process gets: the caller's, minus the signing
 * secret.
 *
 * `HUB_AUTH_TOKEN` is routinely exported into this process — that is what
 * `fnox exec` and the mise tasks do — and an inherited environment is readable
 * from `/proc/<pid>/environ` and lands in whatever the child spawns next. The
 * secret has exactly one route to the host, the `.env` payload on stdin, so it
 * is removed here rather than trusted not to be looked at.
 *
 * Nothing else is stripped: `gh` authenticates with `GH_TOKEN`/`GITHUB_TOKEN`
 * and `ssh` with `SSH_AUTH_SOCK`, so removing the vendors' own credentials
 * would break the delegation this command exists to perform.
 */
function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...env };
  delete child.HUB_AUTH_TOKEN;
  return child;
}

function run(
  program: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; input?: string },
): Ran {
  const result = spawnSync(program, args, {
    env: childEnvironment(options.env),
    // No `input` means stdin is an immediately closed pipe: a remote command
    // that reads stdin gets nothing rather than swallowing this process's.
    input: options.input ?? "",
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.error === undefined ? result.status : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * One remote command over one SSH connection.
 *
 * `BatchMode=yes` because everything here runs unattended-shaped: a host that
 * wants a password should say so immediately rather than block a non-TTY
 * channel forever.
 */
function ssh(
  target: string,
  script: string,
  options: { env: NodeJS.ProcessEnv; input?: string },
): Ran {
  return run("ssh", ["-o", "BatchMode=yes", target, script], options);
}

/** A shell word: one single-quoted string, safe whatever it contains. */
function q(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A path as a shell word, expanding a leading `~` the way the host's shell
 * would — quoting the whole of it would send a literal tilde.
 */
function hostPath(path: string): string {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) return `"$HOME"${q(path.slice(1))}`;
  return q(path);
}

// --- the remote scripts ----------------------------------------------------
//
// Each carries a marker comment. It is what a journal entry or a `ps` line on
// the host is recognisable by — and what this package's tests assert against.

function preflightScript(dir: string, wantTimer: boolean): string {
  return `# uberblick:preflight
set -u
printf 'user=%s\\n' "$(id -un)"
printf 'hostname=%s\\n' "$(hostname -s 2>/dev/null || hostname)"
if docker compose version --short >/dev/null 2>&1; then
  printf 'compose=%s\\n' "$(docker compose version --short)"
else
  printf 'compose=none\\n'
fi
if command -v git >/dev/null 2>&1; then printf 'git=yes\\n'; else printf 'git=no\\n'; fi
if command -v tailscale >/dev/null 2>&1; then printf 'tailscale=yes\\n'; else printf 'tailscale=no\\n'; fi
linger=$(loginctl show-user "$(id -u)" --property=Linger --value 2>/dev/null || echo no)
printf 'linger=%s\\n' "$linger"
if [ "$linger" != "yes" ] && [ ${wantTimer ? "1" : "0"} -eq 1 ]; then
  if sudo -n true >/dev/null 2>&1; then printf 'sudo=yes\\n'; else printf 'sudo=no\\n'; fi
fi
if [ -d ${hostPath(dir)}/.git ]; then printf 'checkout=present\\n'; else printf 'checkout=absent\\n'; fi
if [ -f ${hostPath(KEY_PATH)}.pub ]; then
  printf 'deploykey=%s\\n' "$(cat ${hostPath(KEY_PATH)}.pub)"
else
  printf 'deploykey=none\\n'
fi
`;
}

function ensureKeyScript(hostname: string): string {
  return `# uberblick:ensure-key
set -eu
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
ssh-keygen -q -t ed25519 -N '' -C ${q(`uberblick-deploy@${hostname}`)} -f ${hostPath(KEY_PATH)}
cat ${hostPath(KEY_PATH)}.pub
`;
}

function cloneScript(dir: string): string {
  return `# uberblick:clone
set -eu
git -c core.sshCommand=${q(SSH_COMMAND)} clone --branch main ${q(CLONE_URL)} ${hostPath(dir)}
cd ${hostPath(dir)}
git config core.sshCommand ${q(SSH_COMMAND)}
git rev-parse HEAD
`;
}

function fastForwardScript(dir: string): string {
  return `# uberblick:fast-forward
set -eu
cd ${hostPath(dir)}
git config core.sshCommand ${q(SSH_COMMAND)}
git fetch --quiet origin main
git merge --ff-only origin/main
git rev-parse HEAD
`;
}

function envScript(dir: string): string {
  return `# uberblick:env
set -eu
cd ${hostPath(dir)}
umask 077
cat > .env
chmod 600 .env
`;
}

function upScript(dir: string): string {
  return `# uberblick:up
set -eu
cd ${hostPath(dir)}
sh remote-compose.sh up --build --detach
git update-ref refs/uberblick/deployed HEAD
`;
}

function logsScript(dir: string): string {
  return `# uberblick:logs
cd ${hostPath(dir)}
sh remote-compose.sh logs --tail=50 hub caddy
`;
}

function timerScript(dir: string, linger: boolean): string {
  return `# uberblick:timer
set -eu
cd ${hostPath(dir)}
checkout=$(pwd)
units="$HOME/.config/systemd/user"
mkdir -p "$units"
cat > "$units/uberblick-update.service" <<UNIT
[Unit]
Description=Update the uberblick stack to origin/main

[Service]
Type=oneshot
WorkingDirectory=$checkout
ExecStart=/bin/sh $checkout/remote-update.sh
UNIT
cat > "$units/${TIMER_UNIT}" <<'UNIT'
[Unit]
Description=Check uberblick's origin/main every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
${linger ? "" : 'sudo -n loginctl enable-linger "$(id -un)"\n'}systemctl --user daemon-reload
systemctl --user enable --now ${TIMER_UNIT}
`;
}

function updateScript(dir: string): string {
  return `# uberblick:update
set -eu
cd ${hostPath(dir)}
sh remote-update.sh
`;
}

// --- reaching the deployment ------------------------------------------------

/** Verify the stack from this machine. Returns a problem, or null when it is up. */
export type Reach = (host: string) => Promise<string | null>;

const REACH_BUDGET_MS = 90_000;

/**
 * A deployment is always `https://`; `http://` exists so a test can drive these
 * probes against a server on loopback, where there is no certificate to trust.
 */
function requestFor(url: string): typeof httpRequest {
  return url.startsWith("http://") ? httpRequest : httpsRequest;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A plain GET. Null when the server answered at all with a final status. */
function fetchPage(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const call = requestFor(url)(url, { method: "GET", timeout: 10_000 }, (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      resolve(status >= 200 && status < 400 ? null : `answered HTTP ${status}`);
    });
    call.on("timeout", () => {
      call.destroy();
      resolve("timed out");
    });
    call.on("error", (error) => resolve(error.message));
    call.end();
  });
}

/**
 * Null when the endpoint completes a websocket handshake.
 *
 * RFC 6455 to the letter, because a compliant server holds it to the letter:
 * the key is 16 random bytes, base64 — anything else is refused before the
 * upgrade, which would report a healthy deployment as broken — and the
 * `Sec-WebSocket-Accept` it comes back with is checked, so a proxy answering
 * 101 without understanding websockets does not pass for a hub.
 *
 * Exported for the test that drives it against a real server; `reachStack` is
 * the caller that matters.
 */
export function upgradeWebsocket(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString("base64");
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    const call = requestFor(url)(url, {
      method: "GET",
      timeout: 10_000,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
    });
    call.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(
        response.headers["sec-websocket-accept"] === accept
          ? null
          : "upgraded without a valid Sec-WebSocket-Accept: that is not a websocket endpoint",
      );
    });
    call.on("response", (response) => {
      response.resume();
      resolve(`did not upgrade: HTTP ${response.statusCode ?? 0}`);
    });
    call.on("timeout", () => {
      call.destroy();
      resolve("timed out");
    });
    call.on("error", (error) => resolve(error.message));
    call.end();
  });
}

/**
 * Poll the app, then the socket.
 *
 * The first request is what makes the host's Tailscale daemon issue the
 * certificate, so an immediate check is a false negative rather than a failure —
 * hence a budget rather than one attempt.
 */
async function reachStack(host: string): Promise<string | null> {
  const deadline = Date.now() + REACH_BUDGET_MS;
  let problem = "no answer";
  for (;;) {
    const page = await fetchPage(`https://${host}/`);
    if (page === null) break;
    problem = page;
    if (Date.now() >= deadline) {
      return `https://${host}/ never answered within 90s: ${problem}`;
    }
    await sleep(3_000);
  }
  const socket = await upgradeWebsocket(`https://${host}/ws`);
  return socket === null ? null : `https://${host}/ws ${socket}`;
}

// --- preflight facts --------------------------------------------------------

type Facts = Record<string, string>;

function parseFacts(text: string): Facts {
  const facts: Facts = {};
  for (const line of text.split("\n")) {
    const split = line.indexOf("=");
    if (split > 0) facts[line.slice(0, split)] = line.slice(split + 1).trim();
  }
  return facts;
}

/** Compose 2.6 is the minimum `remote-compose.sh` accepts; check it early. */
function composeTooOld(version: string): boolean {
  const [major, minor] = version.replace(/^v/, "").split(".");
  const first = Number(major);
  const second = Number(minor);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return false;
  return first < 2 || (first === 2 && second < 6);
}

type TailscaleFailure = "absent" | "down" | "denied" | "unreadable";

/**
 * Which of the three it was.
 *
 * Worth distinguishing because only one of them has a one-line fix: an SSH user
 * who is not the tailscale operator is told the exact command, rather than being
 * told to go and look at their host.
 */
function classifyTailscale(output: string): TailscaleFailure {
  if (/access denied|operator|permission denied|not permitted/i.test(output)) {
    return "denied";
  }
  if (/stopped|not running|failed to connect|no such file|connection refused/i.test(output)) {
    return "down";
  }
  return "unreadable";
}

function tailscaleProblem(
  failure: TailscaleFailure,
  target: string,
  user: string,
): string {
  if (failure === "absent") {
    return `tailscale is not installed on ${target}.`;
  }
  if (failure === "down") {
    return `tailscale is installed on ${target} but tailscaled is not up — start it there with: tailscale up`;
  }
  if (failure === "denied") {
    return (
      `tailscale on ${target} refused its local API to ${user}: that user is ` +
      `not the tailscale operator. Fix it on the host with: tailscale set --operator=${user}`
    );
  }
  return `tailscale status on ${target} could not be read.`;
}

/** `Self.DNSName` carries a trailing dot. */
function dnsNameOf(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { Self?: { DNSName?: unknown } };
    const name = parsed.Self?.DNSName;
    return typeof name === "string" && name !== "" ? name.replace(/\.$/, "") : null;
  } catch {
    return null;
  }
}

// --- the deploy key ---------------------------------------------------------

/**
 * The type and material of a public key, without its comment.
 *
 * Identity is the key itself: a fingerprint is a hash of exactly these bytes, so
 * comparing them answers "is this the same key" without either side having to
 * agree on a hash format — and neither answer consults the title, which two
 * hosts can share.
 */
function keyBody(line: string): string {
  const [type, material] = line.trim().split(/\s+/);
  return `${type ?? ""} ${material ?? ""}`;
}

/** The short fingerprint a title carries, so two hosts never alias. */
function shortFingerprint(body: string): string {
  const material = body.split(" ")[1] ?? "";
  return createHash("sha256")
    .update(Buffer.from(material, "base64"))
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .slice(0, 12);
}

// --- the command ------------------------------------------------------------

interface InitFlags {
  target: string;
  dir: string;
  host: string | null;
  ip: string | null;
  autoUpdate: boolean;
}

function parseInitFlags(argv: string[]): InitFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      host: { type: "string" },
      ip: { type: "string" },
      "no-auto-update": { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new Error("expected exactly one <ssh-target>, such as uberblick@host");
  }
  const host = values.host ?? null;
  if (host !== null && !HOSTNAME.test(host)) {
    throw new Error(`--host ${JSON.stringify(host)} is not a hostname`);
  }
  const ip = values.ip ?? null;
  if (ip !== null && !IPV4.test(ip)) {
    throw new Error(`--ip ${JSON.stringify(ip)} is not an IPv4 address`);
  }
  return {
    target: positionals[0] as string,
    dir: values.dir ?? DEFAULT_DIR,
    host,
    ip,
    autoUpdate: values["no-auto-update"] !== true,
  };
}

export interface RemoteInitDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** How the deployment is verified from here. Injected by the tests. */
  reach?: Reach;
}

/** What a failed vendor command is reported as — never its own words. */
function failed(program: string, ran: Ran): string {
  return ran.status === null
    ? `${program} could not be run (is it installed?)`
    : `${program} exited ${ran.status}`;
}

/** Ask for one value. Null when there is nobody to ask. */
async function ask(io: Io, question: string): Promise<string | null> {
  if (process.stdin.isTTY !== true) return null;
  // The question goes through `io`; readline only echoes what is typed, and to
  // stderr, so stdout stays the report alone.
  io.err(question);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question("");
    return answer.trim() === "" ? null : answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * How many documents this machine holds.
 *
 * The local update log alone — sync is switched off for this reading, so it
 * costs no hub round trip. That is also its limit, and the caller says so: a
 * document a browser wrote to a local hub and no MCP session ever pulled down
 * is not in the log and is not counted.
 */
async function localDocumentCount(base: McpConfig): Promise<number> {
  const corpus = await syncWorkspace(bridgeConfig(base, { authSecret: null }));
  return liveDocs(corpus).length;
}

export async function remoteInitCommand(
  argv: string[],
  io: Io = processIo,
  deps: RemoteInitDeps = {},
): Promise<number> {
  let flags: InitFlags;
  try {
    flags = parseInitFlags(argv);
  } catch (error) {
    io.err(
      `ub remote init: ${error instanceof Error ? error.message : String(error)}\n\n${REMOTE_INIT_USAGE}`,
    );
    return 2;
  }

  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const reach = deps.reach ?? reachStack;
  const resolved = resolveConfig({ env, cwd });
  for (const warning of resolved.warnings) io.err(`ub: warning: ${warning}\n`);

  let base: McpConfig;
  try {
    base = resolveMcpConfig(resolved.env);
  } catch (error) {
    io.err(`ub remote init: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const secret = base.authSecret;
  if (secret === null) {
    io.err(
      "ub remote init: no signing secret is configured, so there is nothing " +
        "for the host to authenticate with. Run `ub init` first.\n",
    );
    return 2;
  }
  // Checked here so the failure is early and readable rather than a compose
  // wrapper's refusal after everything else has already happened on the host.
  if (!SAFE_SECRET.test(secret)) {
    io.err(
      "ub remote init: the configured signing secret contains characters " +
        "`remote-compose.sh` refuses (only A-Z a-z 0-9 . _ - are safe, because " +
        "the shell and Compose parse `.env` differently). Regenerate it before " +
        "deploying.\n",
    );
    return 2;
  }

  // This machine has to be able to reach the host over the tailnet to verify
  // the deployment. Discovering that after the stack is up would report a
  // failure that is not one.
  const localTailscale = run("tailscale", ["status", "--json"], { env });
  if (localTailscale.status !== 0) {
    io.err(
      "ub remote init: this machine is not on the tailnet — " +
        `${tailscaleProblem(
          localTailscale.status === null ? "absent" : classifyTailscale(localTailscale.stderr),
          "this machine",
          "you",
        )}\nIt is what verifies the deployment afterwards, so nothing was done.\n`,
    );
    return 1;
  }

  io.err(`ub remote: checking ${flags.target}…\n`);
  const preflight = ssh(flags.target, preflightScript(flags.dir, flags.autoUpdate), { env });
  if (preflight.status !== 0) {
    io.err(`ub remote init: ${failed(`ssh ${flags.target}`, preflight)}.\n`);
    return 1;
  }
  const facts = parseFacts(preflight.stdout);
  const user = facts.user ?? "the SSH user";

  if (facts.compose === undefined || facts.compose === "none") {
    io.err(
      `ub remote init: ${flags.target} has no working \`docker compose\`; ` +
        "Docker Compose 2.6.0 or newer is a host prerequisite.\n",
    );
    return 1;
  }
  if (composeTooOld(facts.compose)) {
    io.err(
      `ub remote init: ${flags.target} has Docker Compose ${facts.compose}; ` +
        "2.6.0 or newer is required.\n",
    );
    return 1;
  }
  if (facts.git !== "yes") {
    io.err(`ub remote init: ${flags.target} has no \`git\`.\n`);
    return 1;
  }
  // Before anything is cloned, and before the deploy key exists: passwordless
  // sudo is a stated host prerequisite, and its absence is a refusal rather
  // than a password prompt nobody can answer over a non-TTY channel.
  if (flags.autoUpdate && facts.linger !== "yes" && facts.sudo !== "yes") {
    io.err(
      `ub remote init: the update timer needs lingering enabled for ${user} on ` +
        `${flags.target}, and \`sudo -n true\` there failed, so this cannot ` +
        "enable it. Run `sudo loginctl enable-linger " +
        `${user}\` on the host once, or pass --no-auto-update. Nothing was done.\n`,
    );
    return 1;
  }

  // Detection, then the flags, then a prompt — and a refusal that names what is
  // missing rather than guessing it.
  let host = flags.host;
  let ip = flags.ip;
  if (host === null || ip === null) {
    let problem: string | null = null;
    if (facts.tailscale !== "yes") {
      problem = tailscaleProblem("absent", flags.target, user);
    } else {
      const status = ssh(flags.target, "tailscale status --json", { env });
      if (status.status !== 0) {
        problem = tailscaleProblem(
          classifyTailscale(`${status.stderr}${status.stdout}`),
          flags.target,
          user,
        );
      } else {
        host = host ?? dnsNameOf(status.stdout);
        const address = ssh(flags.target, "tailscale ip -4", { env });
        if (address.status !== 0) {
          problem = tailscaleProblem(
            classifyTailscale(`${address.stderr}${address.stdout}`),
            flags.target,
            user,
          );
        } else {
          ip = ip ?? (address.stdout.trim().split("\n")[0]?.trim() ?? null);
        }
      }
    }
    if (problem !== null) io.err(`ub remote init: ${problem}\n`);
    if (host === null || host === "") {
      host = await ask(io, `MagicDNS name of ${flags.target} (…ts.net): `);
    }
    if (ip === null || ip === "") {
      ip = await ask(io, `Tailscale IPv4 of ${flags.target}: `);
    }
  }
  const missing = [
    host === null || host === "" ? "the MagicDNS name" : null,
    ip === null || ip === "" ? "the Tailscale IPv4 address" : null,
  ].filter((entry): entry is string => entry !== null);
  if (missing.length > 0) {
    io.err(
      `ub remote init: could not detect ${missing.join(" and ")} of ` +
        `${flags.target}. Pass --host <fqdn> --ip <v4>. Nothing was done.\n`,
    );
    return 1;
  }
  if (!HOSTNAME.test(host as string) || !IPV4.test(ip as string)) {
    io.err(
      "ub remote init: the host name and IPv4 address must be a plain " +
        "hostname and a dotted-quad address; `.env` is parsed by both the shell " +
        "and Compose. Nothing was done.\n",
    );
    return 1;
  }
  const magicDns = host as string;
  const address = ip as string;

  // The repository read access, before the host is touched further: listing the
  // deploy keys needs exactly the rights adding one needs, so a login without
  // them is refused here rather than after a key exists on the host.
  const listed = run("gh", ["api", `repos/${REPO}/keys`], { env });
  if (listed.status !== 0) {
    io.err(
      `ub remote init: ${failed(`gh api repos/${REPO}/keys`, listed)}. Adding a ` +
        "deploy key needs admin rights on the repository and a `repo`-scoped " +
        "token — `gh auth login --scopes repo`. Nothing was done.\n",
    );
    return 1;
  }
  let registered: { key?: unknown }[];
  try {
    registered = JSON.parse(listed.stdout) as { key?: unknown }[];
  } catch {
    io.err("ub remote init: the deploy-key listing could not be read as JSON.\n");
    return 1;
  }

  let publicKey = facts.deploykey === "none" ? null : (facts.deploykey ?? null);
  if (publicKey === null) {
    io.err(`ub remote: generating a deploy key on ${flags.target}…\n`);
    const generated = ssh(
      flags.target,
      ensureKeyScript(facts.hostname ?? "host"),
      { env },
    );
    if (generated.status !== 0) {
      io.err(`ub remote init: ${failed("ssh-keygen on the host", generated)}.\n`);
      return 1;
    }
    publicKey = generated.stdout.trim();
  }
  const body = keyBody(publicKey);
  const known = registered.some(
    (entry) => typeof entry.key === "string" && keyBody(entry.key) === body,
  );
  if (!known) {
    const scratch = mkdtempSync(join(tmpdir(), "uberblick-deploy-key-"));
    const keyFile = join(scratch, "uberblick-deploy.pub");
    try {
      writeFileSync(keyFile, `${publicKey}\n`, "utf8");
      const added = run(
        "gh",
        [
          "repo",
          "deploy-key",
          "add",
          keyFile,
          "--repo",
          REPO,
          "--title",
          `uberblick-${facts.hostname ?? "host"}-${shortFingerprint(body)}`,
        ],
        { env },
      );
      if (added.status !== 0) {
        io.err(`ub remote init: ${failed("gh repo deploy-key add", added)}.\n`);
        return 1;
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  const existing = facts.checkout === "present";
  io.err(
    existing
      ? `ub remote: fast-forwarding the checkout on ${flags.target}…\n`
      : `ub remote: cloning ${REPO} onto ${flags.target}…\n`,
  );
  const checkout = ssh(
    flags.target,
    existing ? fastForwardScript(flags.dir) : cloneScript(flags.dir),
    { env },
  );
  if (checkout.status !== 0) {
    io.err(
      `ub remote init: ${failed(existing ? "git fetch on the host" : "git clone on the host", checkout)}.\n` +
        (checkout.stderr.trim() === "" ? "" : `${checkout.stderr.trim()}\n`),
    );
    return 1;
  }

  // Over stdin: the secret is never an argument, on either side.
  const wrote = ssh(flags.target, envScript(flags.dir), {
    env,
    input: `# Written by \`ub remote init\`. Untracked, so updates never touch it.\nTAILSCALE_HOST=${magicDns}\nTAILSCALE_IP=${address}\nHUB_AUTH_TOKEN=${secret}\n`,
  });
  if (wrote.status !== 0) {
    io.err(`ub remote init: ${failed("writing .env on the host", wrote)}.\n`);
    return 1;
  }

  io.err(`ub remote: building and starting the stack on ${flags.target}…\n`);
  const up = ssh(flags.target, upScript(flags.dir), { env });
  if (up.status !== 0) {
    io.err(`ub remote init: ${failed("sh remote-compose.sh up", up)}.\n`);
    io.err(ssh(flags.target, logsScript(flags.dir), { env }).stdout);
    io.err("Nothing was persisted here, and no update timer was installed.\n");
    return 1;
  }

  io.err(`ub remote: waiting for https://${magicDns}/ …\n`);
  const unreachable = await reach(magicDns);
  if (unreachable !== null) {
    io.err(`ub remote init: ${unreachable}\n`);
    io.err(ssh(flags.target, logsScript(flags.dir), { env }).stdout);
    io.err("Nothing was persisted here, and no update timer was installed.\n");
    return 1;
  }

  if (flags.autoUpdate) {
    const timer = ssh(flags.target, timerScript(flags.dir, facts.linger === "yes"), {
      env,
    });
    if (timer.status !== 0) {
      io.err(
        `ub remote init: the stack is up, but ${failed("installing the update timer", timer)}. ` +
          "Rerun, or pass --no-auto-update and deploy with `ub remote update`. " +
          "Nothing was persisted here.\n",
      );
      return 1;
    }
  }

  const endpoint = `wss://${magicDns}/ws`;
  let report = `uberblick is up at https://${magicDns}/\n`;
  report += flags.autoUpdate
    ? `${flags.target} now follows origin/main by itself, checking every five ` +
      "minutes: anyone who can merge to main can run code on it. " +
      "`ub remote update` deploys on demand; --no-auto-update installs without " +
      "the timer.\n"
    : "No update timer was installed; deploy with `ub remote update`.\n";

  const held = await localDocumentCount(base);
  if (held > 0) {
    report +=
      `\nThis workspace holds ${held} document${held === 1 ? "" : "s"}, so the ` +
      "endpoint was left alone — `ub remote set` moves nothing. Move them onto " +
      "the new hub with:\n\n" +
      `  ub remote promote ${endpoint}\n`;
    io.out(report);
    return 0;
  }

  const persistence = setRemote(endpoint, { env, cwd });
  for (const warning of persistence.warnings) io.err(`ub: warning: ${warning}\n`);
  report +=
    `\nThis workspace holds no documents, so the endpoint is now ${endpoint}\n` +
    persistence.written.map((path) => `  wrote ${path}\n`).join("") +
    "(counted from the local update log: a document a browser wrote to a local " +
    "hub and no MCP session ever pulled down is not visible to it.)\n" +
    "Point another machine here with `ub remote join`.\n";
  if (persistence.outrankedBy !== null) {
    io.out(report);
    io.err(
      `ub remote init: ${persistence.outrankedBy.layer} names ` +
        `${persistence.outrankedBy.endpoint}, so the clients will keep dialling ` +
        "that one.\n",
    );
    return 1;
  }
  io.out(report);
  return 0;
}

interface UpdateFlags {
  target: string;
  dir: string;
}

export async function remoteUpdateCommand(
  argv: string[],
  io: Io = processIo,
  deps: RemoteInitDeps = {},
): Promise<number> {
  let flags: UpdateFlags;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { dir: { type: "string" } },
      allowPositionals: true,
    });
    if (positionals.length !== 1) {
      throw new Error("expected exactly one <ssh-target>, such as uberblick@host");
    }
    flags = { target: positionals[0] as string, dir: values.dir ?? DEFAULT_DIR };
  } catch (error) {
    io.err(
      `ub remote update: ${error instanceof Error ? error.message : String(error)}\n\n${REMOTE_INIT_USAGE}`,
    );
    return 2;
  }

  const env = deps.env ?? process.env;
  // The host's own updater, on demand — the same script the timer runs, so the
  // two can never drift apart, and the lock is what keeps them from colliding.
  const ran = ssh(flags.target, updateScript(flags.dir), { env });
  if (ran.stdout !== "") io.out(ran.stdout);
  if (ran.status !== 0) {
    io.err(`${ran.stderr}ub remote update: ${failed("remote-update.sh", ran)}.\n`);
    return 1;
  }
  return 0;
}
