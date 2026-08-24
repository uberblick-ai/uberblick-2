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
import { closeSync, openSync } from "node:fs";
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
      // A real client outlives the wrapper and holds the server's stdin open;
      // that is the only condition under which failing to forward is visible.
      // An ordinary pipe cannot reproduce it — Node closes our write end when
      // the wrapper exits, the orphan then shuts down on stdin-close, and an
      // unforwarded signal would look exactly like a forwarded one. A FIFO we
      // keep open ourselves never reaches EOF, so a server the wrapper did not
      // signal simply lives on, holding the inherited stdout and stderr.
      const stdin = join(box.cwd, "client-stdin");
      execFileSync("mkfifo", [stdin]);
      // "r+" so this end is a writer too: the FIFO stays open with no reader.
      const held = openSync(stdin, "r+");

      const child = spawn(process.execPath, [UB_BIN, "mcp", "serve"], {
        cwd: box.cwd,
        env: box.env,
        stdio: [held, "pipe", "pipe"],
      });
      // Both pipes have to be consumed or their EOF is never observed and
      // `close` could not fire at all. stderr is read by `whenServing`.
      child.stdout?.resume();

      // `close`, not `exit`: it waits for the inherited stdio to close as well,
      // so an orphaned server keeps it from firing and the test times out. That
      // is the forwarding half. Waiting on `exit` alone would prove nothing,
      // because a wrapper that forwards nothing still dies of the signal.
      const closed = new Promise<NodeJS.Signals | null>((resolve) => {
        child.on("close", (_code, closedBy) => resolve(closedBy));
      });
      try {
        await whenServing(child);
        child.kill(signal);

        // And the wrapper's own death is the signal, not a plain exit with
        // 128+n: a supervisor reading WIFSIGNALED cannot tell it from a direct
        // spawn. That is the re-raise half.
        expect(await closed).toBe(signal);
      } finally {
        closeSync(held);
      }
    },
  );
});
