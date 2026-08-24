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
import { closeSync, constants, openSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";
import { DEAD_HUB_URL, UB_BIN, removeTempDirs, sandbox } from "./helpers.js";
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
function whenServing(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    let seen = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      if (seen.includes("serving")) {
        resolve();
      }
    });
  });
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

describe("ub mcp serve", () => {
  it("serves the shipped tool set to a client that spawns it", async () => {
    const session = await connect(sandbox());
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

  it("passes the resolved configuration through, warnings and all", async () => {
    // A directory file that binds the workspace, a credential so the hub is
    // enabled rather than disabled, and a secret in the committable file — which
    // is refused with a warning, so resolution has something to write to stderr
    // while stdout is carrying the protocol. The `HUB_URL` override below is
    // also what lets the stored secret apply at all: it makes the hub the user's
    // choice rather than the directory file's.
    const box = sandbox({
      directoryFile: {
        workspace: "cli-serve-test",
        hubUrl: "ws://ignored:1",
        signingSecret: "cli-serve-misplaced-secret",
      },
      credentials: { signingSecret: "cli-serve-signing-secret" },
    });

    // The environment override has to survive the exec: this is the value the
    // server must report, not the one in the directory file.
    const session = await connect(box, { HUB_URL: DEAD_HUB_URL });
    try {
      const result = await session.client.callTool({
        name: "sync_status",
        arguments: {},
      });
      const content = result.content as { text: string }[];
      const status = JSON.parse(content[0]!.text);

      expect(status.workspace).toBe("cli-serve-test");
      expect(status.hub.url).toBe(DEAD_HUB_URL);
      expect(status.database).toMatch(/cli-serve-test\.sqlite$/);

      expect(session.stderr()).toMatch(/belongs in credentials\.json/);
      expect(session.stderr()).not.toContain("cli-serve-signing-secret");
      expect(session.stderr()).not.toContain("cli-serve-misplaced-secret");
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
      const box = sandbox();
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
      const closed = new Promise<NodeJS.Signals | null | "the server outlived the wrapper">(
        (resolve) => {
          child.on("close", (_code, closedBy) => resolve(closedBy));
        },
      );

      // Bounded here rather than at Vitest's outer timeout: that one fails the
      // test without unwinding it, so `finally` would never run and a live MCP
      // server would leak out of the suite. This resolves instead, so teardown
      // always happens and the failure is the assertion below.
      let timer: NodeJS.Timeout | undefined;
      const outlived = new Promise<"the server outlived the wrapper">((resolve) => {
        timer = setTimeout(() => resolve("the server outlived the wrapper"), 10_000);
      });

      try {
        await whenServing(child);
        child.kill(signal);

        // And the wrapper's own death is the signal, not a plain exit with
        // 128+n: a supervisor reading WIFSIGNALED cannot tell it from a direct
        // spawn. That is the re-raise half.
        expect(await Promise.race([closed, outlived])).toBe(signal);
      } finally {
        clearTimeout(timer);
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
        await Promise.race([
          closed,
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
    },
  );
});
