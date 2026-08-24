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
    // enabled rather than disabled, and a mode on that credential worth warning
    // about — so resolution has something to write to stderr while stdout is
    // carrying the protocol.
    const box = sandbox({
      directoryFile: { workspace: "cli-serve-test", hubUrl: "ws://ignored:1" },
      credentials: { signingSecret: "cli-serve-signing-secret" },
      credentialsMode: 0o644,
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

      expect(session.stderr()).toMatch(/should be 0600/);
      expect(session.stderr()).not.toContain("cli-serve-signing-secret");
    } finally {
      await session.close();
    }
  });
});
