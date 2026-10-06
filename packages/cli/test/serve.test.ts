/**
 * `ub mcp serve` from the only perspective that matters: an MCP client with
 * `ub mcp serve` as its configured command.
 *
 * Two things are being proved. First, that the shipped tool set is there — the
 * indirection through `ub` must be invisible to a client. Second, that stdout
 * carries nothing but JSON-RPC even when configuration resolution has something
 * to say: a successful `initialize` plus a parseable tool result is that proof,
 * because a stray byte on stdout is a parse error and a dropped session.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";
import { DEAD_HUB_URL, UB_BIN, removeTempDirs, runUb, runUbAsync, sandbox, unboundSandbox } from "./helpers.js";
import type { Sandbox } from "./helpers.js";

afterAll(removeTempDirs);

/** The environment a spawn wants: strings only, no undefined values. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

interface Session {
  client: Client;
  /** Everything the server and the CLI wrote to stderr. */
  stderr(): string;
  close(): Promise<void>;
}

async function connect(
  box: Sandbox,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [UB_BIN, "mcp", "serve"],
    cwd: box.cwd,
    env: stringEnv({ ...box.env, ...extraEnv }),
    stderr: "pipe",
  });

  let stderr = "";
  const client = new Client({ name: "uberblick-cli-tests", version: "0.0.0" });
  // The transport spawns the child inside `connect`, so the listener can only be
  // attached afterwards. Nothing is lost: an unread pipe buffers, and this is
  // the only reader.
  await client.connect(transport);
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  return {
    client,
    stderr: () => stderr,
    async close() {
      await client.close();
    },
  };
}

/**
 * Wait for the server to say it is serving, on its own stderr. Readiness is
 * observed rather than timed: a sleep here would be the flaky way to write it.
 */
function whenServing(child: ChildProcess): Promise<"serving"> {
  return new Promise((resolve) => {
    let seen = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      if (seen.includes("serving")) {
        resolve("serving");
      }
    });
  });
}

/**
 * Await something that might never happen, and say so instead of hanging.
 *
 * Every wait in the signal test needs its own bound, and each bound has to be
 * cancelled when the wait wins — an uncancelled timer is referenced, so it would
 * keep the event loop busy for its full duration after a passing case. Resolving
 * with a sentinel rather than rejecting is deliberate: the caller asserts on it,
 * so the failure is a readable expectation and the test still unwinds through
 * its own teardown, which Vitest's outer timeout would skip.
 */
async function within<T, S>(work: Promise<T>, ms: number, sentinel: S): Promise<T | S> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<S>((resolve) => {
        timer = setTimeout(() => resolve(sentinel), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A stand-in for a client that outlives the wrapper, which is the only condition
 * under which a signal the wrapper fails to forward is observable: a real MCP
 * client keeps running and keeps the server's stdin open, so an orphaned server
 * never sees EOF and lives on. An ordinary pipe cannot reproduce that — Node
 * closes our write end as soon as the wrapper exits, the orphan shuts down on
 * stdin-close, and a missing forward looks exactly like a working one.
 *
 * The two ends are deliberately separate descriptors. The child must get a
 * read-only one: an `O_RDWR` descriptor would make the server a writer to its
 * own stdin, so closing the parent's end could never produce EOF and a failing
 * test would hang instead of failing (and `O_RDWR` on a FIFO is undefined by
 * POSIX besides). Opening read-only blocks until a writer appears and write-only
 * blocks until a reader does, hence the non-blocking placeholder that breaks the
 * deadlock and is dropped once the real pair exists.
 */
function clientStdin(path: string): { childEnd: number; writer: number } {
  execFileSync("mkfifo", [path]);
  const placeholder = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const writer = openSync(path, constants.O_WRONLY);
    // Returns at once, a writer now exists — and blocking, so the child's stdin
    // is an ordinary descriptor.
    return { childEnd: openSync(path, constants.O_RDONLY), writer };
  } finally {
    closeSync(placeholder);
  }
}

/** The workspace these sandboxes are configured for. Ids are uuids. */
const WORKSPACE = "1e9b7a30-52c4-4d6f-8a13-c7b204e5f981";

describe("ub mcp serve", () => {
  it("opens a newly created local workspace without a hub or login", async () => {
    const box = unboundSandbox();
    const created = await runUbAsync(["workspace", "create", "Local MCP"], box);
    expect(created.status, created.output).toBe(0);
    const session = await connect(box);
    try {
      const result = await session.client.callTool({ name: "list_docs", arguments: {} });
      expect(result.isError).not.toBe(true);
      const content = result.content as { text: string }[];
      expect(content[0]!.text).toContain("Welcome");
      expect(session.stderr()).not.toMatch(/sign.in required|HUB_AUTH_TOKEN missing/i);
    } finally { await session.close(); }
  });

  it("serves the shipped tool set to a client that spawns it", async () => {
    const session = await connect(sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } }));
    try {
      const names = (await session.client.listTools()).tools.map(
        (tool) => tool.name,
      );
      expect(names).toEqual(
        expect.arrayContaining([
          "create_doc",
          "get_doc",
          "list_docs",
          "search",
          "backlinks",
          "edit_block",
          "insert_block",
          "delete_block",
          "set_tags",
          "set_links",
          "annotate",
          "export_markdown",
          "sync_status",
        ]),
      );
    } finally {
      await session.close();
    }
  });

  // What the wrapper owes a client: the endpoint is the project binding's, and it
  // survives the exec into the server the client actually talks to.
  it("dials the project binding's endpoint when a client spawns it inside a checkout", async () => {
    const box = sandbox({
      checkout: true,
      projectBinding: { workspaceId: WORKSPACE, hubUrl: DEAD_HUB_URL },
      credentials: { signingSecret: "cli-serve-checkout-secret" },
    });

    const session = await connect(box);
    try {
      const result = await session.client.callTool({
        name: "sync_status",
        arguments: {},
      });
      const content = result.content as { text: string }[];
      expect(JSON.parse(content[0]!.text).hub.url).toBe(DEAD_HUB_URL);
    } finally {
      await session.close();
    }
  });

  it("passes the resolved configuration through, warnings and all", async () => {
    // A project binding, a credential so the hub is enabled rather than
    // disabled, and a secret misplaced in the user config. The secret is
    // refused with a warning, so resolution has something
    // to write to stderr while stdout is carrying the protocol.
    const box = sandbox({
      projectBinding: { workspaceId: `serve-${WORKSPACE}`, hubUrl: DEAD_HUB_URL },
      userConfig: {
        signingSecret: "cli-serve-misplaced-secret",
      },
      credentials: { signingSecret: "cli-serve-signing-secret" },
    });

    const session = await connect(box);
    try {
      const result = await session.client.callTool({
        name: "sync_status",
        arguments: {},
      });
      const content = result.content as { text: string }[];
      const status = JSON.parse(content[0]!.text);

      // The claim and the file are keyed by the uuid, never by the slug the
      // config spelled it with.
      expect(status.workspace).toBe(WORKSPACE);
      expect(status.hub.url).toBe(DEAD_HUB_URL);
      expect(status.database).toMatch(new RegExp(`${WORKSPACE}\\.sqlite$`));

      expect(session.stderr()).toMatch(/belongs in credentials\.json/);
      expect(session.stderr()).not.toContain("cli-serve-signing-secret");
      expect(session.stderr()).not.toContain("cli-serve-misplaced-secret");
    } finally {
      await session.close();
    }
  });

  it.each([
    { WORKSPACE_ID: "8f21c604-3b7d-4a15-9c62-0d5e8b3f7a29" },
    { HUB_URL: "wss://legacy.example.test/ws" },
  ])("refuses a legacy MCP selector before opening the project workspace", (legacy) => {
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    // The real subprocess receives a valid project binding plus an old MCP
    // entry's pin. Ignoring that pin would boot the wrong corpus and seed data.
    const run = runUb(["mcp", "serve"], box, legacy);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Legacy WORKSPACE_ID / HUB_URL");
    expect(run.stderr).toContain("No workspace was opened");
    expect(existsSync(box.dataHome)).toBe(false);
    expect(existsSync(box.configHome)).toBe(false);
    expect(readdirSync(box.cwd)).toEqual([".uberblick.json"]);
  });

  it("serves only the complete new MCP binding even when legacy and project selections disagree", async () => {
    const selected = "8f21c604-3b7d-4a15-9c62-0d5e8b3f7a29";
    const legacy = "5cb9a7a5-3cc0-4cdb-bd20-fd348fbf1311";
    const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
    const session = await connect(box, {
      WORKSPACE_ID: legacy,
      HUB_URL: "wss://legacy.example.test/ws",
      UB_WORKSPACE_ID: selected,
      UB_HUB_URL: "local",
    });
    try {
      await session.client.callTool({ name: "create_doc", arguments: {
        title: "Explicit binding only", description: "Synthetic binding regression.",
      } });
      const result = await session.client.callTool({ name: "list_docs", arguments: {} });
      const content = result.content as { text: string }[];
      const listing = JSON.parse(content[0]!.text);
      expect(listing.workspace).toBe(selected);
      expect(listing.docs.map((doc: { title: string }) => doc.title)).toEqual(["Explicit binding only"]);
      const data = join(box.dataHome, "uberblick");
      expect(existsSync(join(data, `${selected}.sqlite`))).toBe(true);
      expect(existsSync(join(data, `${WORKSPACE}.sqlite`))).toBe(false);
      expect(existsSync(join(data, `${legacy}.sqlite`))).toBe(false);
    } finally {
      await session.close();
    }
  });

  // The two signals the server installs no handler for, so the child dies OF
  // them rather than exiting cleanly — which is what makes them the pair that
  // proves the wrapper's lifecycle. SIGHUP is what a vanished terminal sends;
  // SIGQUIT is Ctrl-\ and a supervisor escalating past SIGTERM.
  it.each(["SIGHUP", "SIGQUIT"] as const)(
    "forwards %s to the server, takes it down, and dies of it too",
    async (signal) => {
      const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
      const { childEnd, writer } = clientStdin(join(box.cwd, "client-stdin"));
      // Its own process group, so teardown can take a survivor down by group
      // even after the wrapper — the group's leader — is gone. `child.kill`
      // below still targets the wrapper's pid alone, which is the case at issue.
      const child = spawn(process.execPath, [UB_BIN, "mcp", "serve"], {
        cwd: box.cwd,
        env: box.env,
        stdio: [childEnd, "pipe", "pipe"],
        detached: true,
      });
      // Both pipes have to be consumed or their EOF is never observed and
      // `close` could not fire at all. stderr is read by `whenServing`.
      child.stdout?.resume();

      // `close`, not `exit`: it waits for the inherited stdio to close as well,
      // so an orphaned server keeps it from firing. That is the forwarding half.
      // Waiting on `exit` alone would prove nothing, because a wrapper that
      // forwards nothing still dies of the signal itself.
      const closed = new Promise<NodeJS.Signals | null>((resolve) => {
        child.on("close", (_code, closedBy) => resolve(closedBy));
      });

      try {
        // Readiness gets its own bound, and the forwarding clock starts only
        // once it is met: a server that dies before it ever says "serving"
        // would otherwise run into Vitest's outer timeout — which fails the test
        // without unwinding it, so teardown below would never run — and a slow
        // boot would eat the window the signal is supposed to be answered in.
        expect(await within(whenServing(child), 10_000, "never started")).toBe(
          "serving",
        );
        child.kill(signal);

        // And the wrapper's own death is the signal, not a plain exit with
        // 128+n: a supervisor reading WIFSIGNALED cannot tell it from a direct
        // spawn. That is the re-raise half.
        expect(
          await within(closed, 10_000, "the server outlived the wrapper"),
        ).toBe(signal);
      } finally {
        closeSync(writer);
        closeSync(childEnd);
        // Nothing should be left; kill the group in case something is, and wait
        // for the reaping so the suite never carries a survivor into the next
        // test. `child.pid` is undefined only if the spawn itself failed.
        try {
          if (child.pid !== undefined) {
            process.kill(-child.pid, "SIGKILL");
          }
        } catch {
          // ESRCH: the group is already gone, which is the expected case.
        }
        await within(closed, 2_000, "not reaped");
      }
    },
  );
});
