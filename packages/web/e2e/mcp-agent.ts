/** A real MCP client and its isolated machine state for browser proof points. */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const UB = join(repoRoot, "packages", "cli", "bin", "ub.mjs");
const GRACEFUL_EXIT_MS = 5_000;

/** A JSON-RPC response frame, as much of one as these clients read. */
interface Frame {
  id?: number;
  error?: unknown;
  result?: { content?: { type: string; text?: string }[]; isError?: boolean };
}

export interface McpClientInfo {
  name: string;
  title?: string;
}

interface McpAgentOptions {
  workspace: string;
  hubUrl: string;
  authSecret: string;
  statePrefix: string;
}

/**
 * An MCP client's private machine state and every server session using it.
 *
 * Each session explicitly pins the workspace and hub as a complete binding.
 * Keeping setup and cleanup here prevents one spec's protocol client from
 * drifting from another or leaving a server behind after a failed test.
 */
export class McpAgent {
  private readonly state: string;
  private readonly sessions = new Set<McpSession>();

  constructor(private readonly options: McpAgentOptions) {
    this.state = mkdtempSync(join(tmpdir(), options.statePrefix));

  }

  open(clientInfo: McpClientInfo): McpSession {
    const session = new McpSession(this.state, this.options, clientInfo);
    this.sessions.add(session);
    return session;
  }

  async closeSessions(): Promise<void> {
    await Promise.all([...this.sessions].map((session) => session.close()));
    this.sessions.clear();
  }

  async close(): Promise<void> {
    await this.closeSessions();
    rmSync(this.state, { recursive: true, force: true });
  }
}

/**
 * `ub mcp serve` in a child process, speaking newline-delimited JSON-RPC over
 * stdio. It is deliberately hand-rolled: the web package should not gain the
 * MCP SDK as a dependency for two browser proof points.
 */
export class McpSession {
  readonly ready: Promise<void>;

  private readonly child: ChildProcess;
  private readonly pending = new Map<number, (message: Frame) => void>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private closing: Promise<void> | null = null;

  constructor(
    state: string,
    options: McpAgentOptions,
    clientInfo: McpClientInfo,
  ) {
    this.child = spawn(process.execPath, [UB, "mcp", "serve"], {
      cwd: state,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        UB_WORKSPACE_ID: options.workspace,
        UB_HUB_URL: options.hubUrl,
        WORKSPACE_ID: undefined,
        HUB_URL: undefined,
        HUB_ADMISSION: undefined,
        HUB_AUTH_TOKEN: options.authSecret,
        UBERBLICK_DB: join(state, "agent.sqlite"),
        XDG_CONFIG_HOME: join(state, "config"),
        XDG_DATA_HOME: join(state, "data"),
      },
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let end = this.buffer.indexOf("\n");
      while (end !== -1) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (line !== "") {
          try {
            const message = JSON.parse(line) as Frame;
            if (typeof message.id === "number") {
              this.pending.get(message.id)?.(message);
              this.pending.delete(message.id);
            }
          } catch {
            this.stderr += `\nnot a JSON-RPC frame on stdout: ${line}`;
          }
        }
        end = this.buffer.indexOf("\n");
      }
    });
    this.ready = this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { ...clientInfo, version: "0.0.0" },
    }).then(() => {
      this.notify("notifications/initialized", {});
    });
  }

  private request(method: string, params: unknown): Promise<Frame> {
    const id = this.nextId++;
    return new Promise((settle, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`e2e: ${method} timed out\n${this.stderr}`));
      }, 30_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        settle(message);
      });
      this.child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  private notify(method: string, params: unknown): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.ready;
    const message = await this.request("tools/call", { name, arguments: args });
    const text = message.result?.content?.[0]?.text ?? "null";
    if (message.error !== undefined || message.result?.isError === true) {
      throw new Error(
        `e2e: ${name} failed: ${JSON.stringify(message.error ?? text)}`,
      );
    }
    return JSON.parse(text) as T;
  }

  /** Close stdin, then bound how long the server may take to leave. */
  close(): Promise<void> {
    this.closing ??= new Promise<void>((settle) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        settle();
        return;
      }
      const term = setTimeout(() => this.child.kill("SIGTERM"), GRACEFUL_EXIT_MS);
      const kill = setTimeout(
        () => this.child.kill("SIGKILL"),
        GRACEFUL_EXIT_MS * 2,
      );
      this.child.once("exit", () => {
        clearTimeout(term);
        clearTimeout(kill);
        settle();
      });
      this.child.stdin?.end();
    });
    return this.closing;
  }
}
