/**
 * Disposable serving-owner spike for #621.
 *
 * This is evidence, not a production entry point. It puts the existing MCP
 * server behind two local client shapes, exercises the real log/index/sync
 * path, prints one JSON result, and removes every file it creates.
 */

import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { createServer as createIpcServer, createConnection } from "node:net";
import type { Server as IpcServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createHub,
  importRootSecret,
  MAX_TOKEN_LIFETIME_SECONDS,
  mintToken,
  silentLogger,
} from "@uberblick/hub";
import type { Hub } from "@uberblick/hub";
import { wrapToken } from "@uberblick/hub/protocol";
import {
  editBlock,
  getBlocks,
  getMeta,
  setInlineLink,
} from "@uberblick/schema";
import * as Y from "yjs";
import type { McpConfig } from "../src/config.js";
import { createMcpServer } from "../src/server.js";
import type { UberblickMcpServer } from "../src/server.js";

const OWNER_PROTOCOL_VERSION = 1;
const WORKSPACE = "1d65af37-4a71-41de-8ac0-5e9471507aa3";
const SECRET = "shared-owner-spike-only-secret";
const WAIT_MS = 20_000;
const SAMPLE_COUNT = 30;

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

interface OwnerRequest {
  token: string;
  protocol: number;
  operation: "backlinks";
  uuid: string;
}

interface BacklinkRow {
  uuid: string;
  title: string;
  description: string | null;
}

interface BacklinksResult {
  uuid: string;
  backlinks: BacklinkRow[];
}

interface MutationResult {
  applied: boolean;
  synced: boolean;
}

interface SnapshotResult {
  uuid: string;
  update: string;
}

interface ErrorResult {
  error: string;
  synced: false;
}

interface DocumentBlock {
  id: string;
  text: string;
  rev: string;
}

interface DocumentResult {
  uuid: string;
  blocks: DocumentBlock[];
}

interface SyncStatusResult {
  hub: { status: string };
  pendingRooms: unknown[];
}

interface DiagnosticsResult {
  protocolVersion: number;
  workspace: string;
  hub: string;
  pendingRooms: number;
  pid: number;
  token?: unknown;
  databasePath?: unknown;
}

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
): Promise<number> {
  const started = performance.now();
  while (!(await predicate())) {
    if (performance.now() - started > WAIT_MS) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return performance.now() - started;
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((sorted.length - 1) * fraction),
  );
  return Number((sorted[index] ?? 0).toFixed(3));
}

async function closeServer(server: HttpServer | IpcServer): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(encoded),
    "content-type": "application/json",
  });
  response.end(encoded);
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_048_576) throw new Error("request-too-large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

class SharedOwner {
  readonly client: Client;
  readonly instance: UberblickMcpServer;
  readonly token: string;
  readonly url: string;
  readonly socketPath: string;

  private closed = false;

  private constructor(
    instance: UberblickMcpServer,
    client: Client,
    token: string,
    url: string,
    socketPath: string,
    private readonly http: HttpServer,
    private readonly ipc: IpcServer,
    private readonly lockPath: string,
    private readonly lockFd: number,
  ) {
    this.instance = instance;
    this.client = client;
    this.token = token;
    this.url = url;
    this.socketPath = socketPath;
  }

  static async start(
    root: string,
    databasePath: string,
    hubUrl: string,
  ): Promise<SharedOwner> {
    const lockPath = join(root, `${WORKSPACE}.owner.lock`);
    let lockFd: number;
    try {
      lockFd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      throw new Error(`owner-already-running: ${message(error)}`);
    }

    const token = randomBytes(24).toString("base64url");
    const socketPath = join(root, "owner.sock");
    const config: McpConfig = {
      workspaceId: WORKSPACE,
      hubUrl,
      authSecret: SECRET,
      databasePath,
      sessionId: `shared-owner-${randomUUID()}`,
      color: "#7b5ec7",
      connectTimeoutMs: 500,
      syncTimeoutMs: 2_000,
      reconnectMaxDelayMs: 250,
      cursorTtlMs: 30_000,
      compactAfter: 500,
      reconcileRetryMs: 0,
      updatedAtCoarsenessMs: 5 * 60_000,
    };
    const instance = createMcpServer(config);
    const client = new Client({
      name: "shared-owner-spike-mcp-client",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    let owner: SharedOwner | null = null;
    try {
      await Promise.all([
        instance.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const http = createHttpServer((request, response) => {
        void owner?.handleHttp(request, response).catch((error: unknown) => {
          json(response, 500, { error: message(error), synced: false });
        });
      });
      http.listen(0, "127.0.0.1");
      await once(http, "listening");
      const address = http.address();
      ensure(address !== null && typeof address !== "string", "HTTP owner did not bind TCP");

      const ipc = createIpcServer((socket) => {
        let input = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          input += chunk;
          const newline = input.indexOf("\n");
          if (newline === -1) return;
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          void owner
            ?.handleIpc(JSON.parse(line) as OwnerRequest)
            .then((result) => socket.end(`${JSON.stringify(result)}\n`))
            .catch((error: unknown) =>
              socket.end(`${JSON.stringify({ error: message(error), synced: false })}\n`),
            );
        });
      });
      ipc.listen(socketPath);
      await once(ipc, "listening");
      chmodSync(socketPath, 0o600);

      owner = new SharedOwner(
        instance,
        client,
        token,
        `http://127.0.0.1:${address.port}`,
        socketPath,
        http,
        ipc,
        lockPath,
        lockFd,
      );
      return owner;
    } catch (error) {
      await client.close().catch(() => {});
      await instance.close().catch(() => {});
      closeSync(lockFd);
      unlinkSync(lockPath);
      throw error;
    }
  }

  async tool<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const result = (await this.client.callTool({
      name,
      arguments: args,
    })) as ToolResult;
    const text = result.content.find((entry) => entry.type === "text")?.text;
    ensure(text !== undefined, `tool ${name} returned no JSON`);
    const payload = JSON.parse(text);
    if (result.isError) {
      throw new Error(`tool ${name} failed: ${JSON.stringify(payload)}`);
    }
    return payload as T;
  }

  private authorized(token: string, protocol: number): unknown {
    if (protocol !== OWNER_PROTOCOL_VERSION) {
      return {
        error: "protocol-incompatible",
        ownerProtocol: OWNER_PROTOCOL_VERSION,
        clientProtocol: protocol,
        synced: false,
      };
    }
    if (token !== this.token) {
      return { error: "unauthorized", synced: false };
    }
    return null;
  }

  private async backlinks(uuid: string): Promise<unknown> {
    await this.instance.replicas.settle();
    return {
      uuid,
      backlinks: this.instance.store.backlinks(uuid),
    };
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const protocol = Number(request.headers["x-uberblick-owner-protocol"]);
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const refusal = this.authorized(token, protocol);
    if (refusal !== null) {
      json(
        response,
        (refusal as { error: string }).error === "protocol-incompatible"
          ? 426
          : 401,
        refusal,
      );
      return;
    }

    const url = new URL(request.url ?? "/", "http://owner.local");
    const uuid = url.pathname.split("/")[2] ?? "";
    if (request.method === "GET" && url.pathname.startsWith("/snapshot/")) {
      await this.instance.replicas.settle();
      const replica = this.instance.replicas.replica(uuid);
      json(response, 200, {
        uuid,
        update: Buffer.from(Y.encodeStateAsUpdate(replica.doc)).toString("base64"),
      });
      return;
    }
    if (request.method === "POST" && url.pathname.startsWith("/updates/")) {
      const parsed = (await bodyOf(request)) as { update?: unknown };
      ensure(typeof parsed.update === "string", "update must be base64 text");
      await this.instance.replicas.settle();
      const replica = this.instance.replicas.replica(uuid);
      Y.applyUpdate(replica.doc, Buffer.from(parsed.update, "base64"));
      json(response, 200, {
        applied: true,
        synced: this.instance.replicas.isRoomQuiet(replica.room),
      });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/backlinks/")) {
      json(response, 200, await this.backlinks(uuid));
      return;
    }
    if (request.method === "GET" && url.pathname === "/diagnostics") {
      const status = await this.tool<SyncStatusResult>("sync_status");
      json(response, 200, {
        protocolVersion: OWNER_PROTOCOL_VERSION,
        workspace: WORKSPACE,
        hub: status.hub.status,
        pendingRooms: status.pendingRooms.length,
        pid: process.pid,
      });
      return;
    }
    json(response, 404, { error: "not-found", synced: false });
  }

  private async handleIpc(request: OwnerRequest): Promise<unknown> {
    const refusal = this.authorized(request.token, request.protocol);
    if (refusal !== null) return refusal;
    if (request.operation !== "backlinks") {
      return { error: "operation-not-supported", synced: false };
    }
    return await this.backlinks(request.uuid);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([closeServer(this.http), closeServer(this.ipc)]);
    await this.client.close();
    await this.instance.close();
    closeSync(this.lockFd);
    unlinkSync(this.lockPath);
  }
}

class WebLikeClient {
  constructor(
    private readonly ownerUrl: string,
    private readonly token: string,
    private readonly protocol = OWNER_PROTOCOL_VERSION,
  ) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      "x-uberblick-owner-protocol": String(this.protocol),
    };
  }

  async read<T = unknown>(
    path: string,
  ): Promise<{ status: number; payload: T }> {
    const response = await fetch(`${this.ownerUrl}${path}`, {
      headers: this.headers(),
    });
    return { status: response.status, payload: (await response.json()) as T };
  }

  async mutate(
    uuid: string,
    change: (doc: Y.Doc) => void,
  ): Promise<MutationResult> {
    const snapshot = await this.read<SnapshotResult>(`/snapshot/${uuid}`);
    ensure(snapshot.status === 200, "web-like snapshot failed");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(snapshot.payload.update, "base64"));
    const vector = Y.encodeStateVector(doc);
    change(doc);
    const update = Y.encodeStateAsUpdate(doc, vector);
    const response = await fetch(`${this.ownerUrl}/updates/${uuid}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ update: Buffer.from(update).toString("base64") }),
    });
    const payload = (await response.json()) as MutationResult;
    ensure(response.status === 200, `web-like update failed: ${JSON.stringify(payload)}`);
    return payload;
  }

  async backlinks(uuid: string): Promise<BacklinksResult> {
    const response = await this.read<BacklinksResult>(`/backlinks/${uuid}`);
    ensure(response.status === 200, "web-like backlinks failed");
    return response.payload;
  }
}

function ipcBacklinks(
  socketPath: string,
  token: string,
  uuid: string,
): Promise<BacklinksResult | ErrorResult> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const request: OwnerRequest = {
        token,
        protocol: OWNER_PROTOCOL_VERSION,
        operation: "backlinks",
        uuid,
      };
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      output += chunk;
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(output) as BacklinksResult | ErrorResult);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}

async function peer(port: number, room: string): Promise<{
  doc: Y.Doc;
  provider: HocuspocusProvider;
}> {
  const token = wrapToken(
    await mintToken(await importRootSecret(SECRET), {
      typ: "room",
      sub: "shared-owner-spike-peer",
      workspace: WORKSPACE,
      scope: "read-write",
      kid: null,
      lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    }),
  );
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: room,
    token,
    document: doc,
  });
  return { doc, provider };
}

async function benchmark(call: () => Promise<unknown>): Promise<{
  medianMs: number;
  p95Ms: number;
}> {
  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const started = performance.now();
    await call();
    samples.push(performance.now() - started);
  }
  return {
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
  };
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "uberblick-shared-owner-spike-"));
  const ownerDatabase = join(root, "owner.sqlite");
  const hubDatabase = join(root, "hub.sqlite");
  let hub: Hub | null = null;
  let owner: SharedOwner | null = null;
  let remote: Awaited<ReturnType<typeof peer>> | null = null;

  try {
    hub = await createHub({
      authSecret: SECRET,
      port: 0,
      databasePath: hubDatabase,
      log: silentLogger,
      debounce: 20,
      maxDebounce: 200,
      shutdownTimeoutMs: 5_000,
    });
    const hubPort = hub.port;
    const hubUrl = `ws://127.0.0.1:${hubPort}`;

    const coldStarted = performance.now();
    owner = await SharedOwner.start(root, ownerDatabase, hubUrl);
    const coldStartMs = performance.now() - coldStarted;
    const web = new WebLikeClient(owner.url, owner.token);

    const target = await owner.tool<DocumentResult>("create_doc", {
      title: "Target",
      description: "The target used by the serving-owner spike.",
    });
    const mcpSource = await owner.tool<DocumentResult>("create_doc", {
      title: "MCP source",
      description: "A source linked through the MCP-like client.",
      blocks: [{ type: "paragraph", text: "See target" }],
    });
    const mcpSourceBlock = mcpSource.blocks[0];
    ensure(mcpSourceBlock !== undefined, "MCP source has no block");
    await owner.tool("link_range", {
      uuid: mcpSource.uuid,
      block_id: mcpSourceBlock.id,
      start: 4,
      end: 10,
      doc_id: target.uuid,
      rev: mcpSourceBlock.rev,
    });
    const afterMcpLink = await web.backlinks(target.uuid);
    ensure(afterMcpLink.backlinks.length === 1, "web-like client missed MCP backlink");

    const webSource = await owner.tool<DocumentResult>("create_doc", {
      title: "Web source",
      description: "A source linked through the web-like loopback client.",
      blocks: [
        { type: "paragraph", text: "See target" },
        { type: "paragraph", text: "MCP base" },
      ],
    });
    await web.mutate(webSource.uuid, (doc) => {
      const block = getBlocks(doc)[0];
      ensure(block !== undefined, "web source has no block");
      setInlineLink(doc, block.id, { start: 4, end: 10 }, target.uuid, {
        rev: block.rev,
      });
    });
    const afterWebLink = await owner.tool<BacklinksResult>("backlinks", {
      uuid: target.uuid,
    });
    ensure(afterWebLink.backlinks.length === 2, "MCP-like client missed web backlink");

    const [simultaneousWeb, simultaneousMcp] = await Promise.all([
      web.backlinks(target.uuid),
      owner.tool<BacklinksResult>("backlinks", { uuid: target.uuid }),
    ]);
    ensure(
      JSON.stringify(simultaneousWeb) === JSON.stringify(simultaneousMcp),
      "simultaneous clients received different index answers",
    );

    const staleWebDoc = new Y.Doc();
    const staleSnapshot = await web.read<SnapshotResult>(
      `/snapshot/${webSource.uuid}`,
    );
    Y.applyUpdate(staleWebDoc, Buffer.from(staleSnapshot.payload.update, "base64"));
    const staleVector = Y.encodeStateVector(staleWebDoc);
    const [webBlock, mcpBlock] = getBlocks(staleWebDoc);
    ensure(webBlock !== undefined && mcpBlock !== undefined, "concurrency fixture is incomplete");
    editBlock(staleWebDoc, webBlock.id, webBlock.text, "Web concurrent", {
      rev: webBlock.rev,
    });
    await owner.tool("edit_block", {
      uuid: webSource.uuid,
      block_id: mcpBlock.id,
      old_text: mcpBlock.text,
      new_text: "MCP concurrent",
      rev: mcpBlock.rev,
    });
    const mergedUpdate = Y.encodeStateAsUpdate(staleWebDoc, staleVector);
    const mergeResponse = await fetch(`${owner.url}/updates/${webSource.uuid}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "content-type": "application/json",
        "x-uberblick-owner-protocol": String(OWNER_PROTOCOL_VERSION),
      },
      body: JSON.stringify({
        update: Buffer.from(mergedUpdate).toString("base64"),
      }),
    });
    ensure(mergeResponse.status === 200, "concurrent web update was refused");
    const merged = await owner.tool<DocumentResult>("get_doc", {
      uuid: webSource.uuid,
    });
    ensure(
      merged.blocks.some((block: { text: string }) => block.text === "Web concurrent") &&
        merged.blocks.some((block: { text: string }) => block.text === "MCP concurrent"),
      "concurrent web/MCP edits did not merge",
    );

    const localAwareness = owner.instance.replicas
      .replica(webSource.uuid)
      .awareness.getLocalState();
    const distinctAwareness =
      localAwareness?.client === "web" &&
      localAwareness?.session !== owner.instance.replicas.config.sessionId;
    ensure(!distinctAwareness, "the spike unexpectedly gained an awareness multiplexer");

    let secondOwner: string;
    try {
      const duplicate = await SharedOwner.start(root, ownerDatabase, hubUrl);
      await duplicate.close();
      secondOwner = "incorrectly-admitted";
    } catch (error) {
      secondOwner = message(error).split(":")[0] ?? "unknown";
    }
    ensure(secondOwner === "owner-already-running", "a second owner was admitted");

    const unauthorized = await new WebLikeClient(
      owner.url,
      "wrong-token",
    ).read<ErrorResult>("/diagnostics");
    const incompatible = await new WebLikeClient(
      owner.url,
      owner.token,
      OWNER_PROTOCOL_VERSION + 1,
    ).read<ErrorResult>("/diagnostics");
    ensure(unauthorized.status === 401, "loopback owner accepted a wrong token");
    ensure(incompatible.status === 426, "loopback owner accepted a mismatched protocol");

    const transport = {
      http: await benchmark(() => web.backlinks(target.uuid)),
      localIpc: await benchmark(() =>
        ipcBacklinks(owner?.socketPath ?? "", owner?.token ?? "", target.uuid),
      ),
    };
    const ipcAnswer = await ipcBacklinks(
      owner.socketPath,
      owner.token,
      target.uuid,
    );
    ensure(
      "backlinks" in ipcAnswer &&
        JSON.stringify(ipcAnswer) === JSON.stringify(simultaneousMcp),
      "local IPC did not return the shared index answer",
    );

    await hub.stop();
    hub = null;
    await waitUntil("the owner to report the hub down", async () => {
      const status = await owner?.tool<SyncStatusResult>("sync_status");
      return status?.hub.status === "hub-down";
    });
    const offline = await web.mutate(webSource.uuid, (doc) => {
      const block = getBlocks(doc)[0];
      ensure(block !== undefined, "offline source has no block");
      editBlock(doc, block.id, block.text, `${block.text} offline`, {
        rev: block.rev,
      });
    });
    ensure(offline.applied === true && offline.synced === false, "offline reply was dishonest");

    const oldUrl = owner.url;
    await owner.close();
    owner = null;
    let unavailable = "reachable";
    try {
      await fetch(`${oldUrl}/diagnostics`);
    } catch {
      unavailable = "connection-refused";
    }
    ensure(unavailable === "connection-refused", "closed owner still answered");

    const restartStarted = performance.now();
    owner = await SharedOwner.start(root, ownerDatabase, hubUrl);
    const restartMs = performance.now() - restartStarted;
    const restarted = await owner.tool<DocumentResult>("get_doc", {
      uuid: webSource.uuid,
    });
    ensure(
      restarted.blocks.some(
        (block: { text: string }) => block.text === "Web concurrent offline",
      ) &&
        restarted.blocks.some(
          (block: { text: string }) => block.text === "MCP concurrent",
        ),
      "merged offline state did not survive owner restart",
    );

    hub = await createHub({
      authSecret: SECRET,
      port: hubPort,
      databasePath: hubDatabase,
      log: silentLogger,
      debounce: 20,
      maxDebounce: 200,
      shutdownTimeoutMs: 5_000,
    });
    remote = await peer(hubPort, `${WORKSPACE}/${webSource.uuid}`);
    const [offlineToRemoteMs, reconnectMs] = await Promise.all([
      waitUntil("the remote replica to receive the merged offline state", () => {
        const texts = getBlocks(remote?.doc ?? new Y.Doc()).map(
          (block) => block.text,
        );
        return (
          texts.includes("Web concurrent offline") &&
          texts.includes("MCP concurrent")
        );
      }),
      waitUntil("the owner to report remote acknowledgement", async () => {
        const status = await owner?.tool<SyncStatusResult>("sync_status");
        return (
          status?.hub.status === "connected" && status?.pendingRooms.length === 0
        );
      }),
    ]);
    ensure(getMeta(remote.doc).title === "Web source", "remote replica missed metadata");

    const diagnostics = await new WebLikeClient(owner.url, owner.token).read<
      DiagnosticsResult
    >("/diagnostics");
    ensure(
      diagnostics.payload.protocolVersion === OWNER_PROTOCOL_VERSION &&
        diagnostics.payload.token === undefined &&
        diagnostics.payload.databasePath === undefined,
      "diagnostics leaked or omitted its contract",
    );

    const result = `${JSON.stringify(
        {
          schemaVersion: 1,
          fixture: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            workspaceCount: 1,
            documents: 3,
            clients: ["web-like loopback Y.Doc", "MCP in-memory transport"],
            samplesPerTransport: SAMPLE_COUNT,
            note: "Hub and disposable owner run in this process; RSS is comparative evidence, not a production capacity number.",
          },
          sharedIndex: {
            afterMcpLink: afterMcpLink.backlinks.map((row: { uuid: string }) => row.uuid),
            afterWebLink: afterWebLink.backlinks.map((row: { uuid: string }) => row.uuid),
            simultaneousAnswersEqual: true,
            clientsWroteDerivedTables: false,
          },
          durabilityAndSync: {
            concurrentEditsMerged: true,
            offlineReply: offline,
            restartReadable: true,
            separateHubReplicaConverged: true,
          },
          identityAndOwnership: {
            awarenessDistinct: distinctAwareness,
            publishedOwnerIdentity: localAwareness ?? null,
            identityCollapseIsNoGo: true,
            secondOwner,
          },
          failureReadings: {
            unauthorized: unauthorized.payload.error,
            incompatible: incompatible.payload.error,
            unavailable,
            localAcceptanceReportedSynced: offline.synced,
          },
          transport,
          lifecycle: {
            coldStartMs: Number(coldStartMs.toFixed(3)),
            restartMs: Number(restartMs.toFixed(3)),
            reconnectMs: Number(reconnectMs.toFixed(3)),
            offlineToRemoteMs: Number(offlineToRemoteMs.toFixed(3)),
            processRssBytes: process.memoryUsage().rss,
          },
        },
        null,
        2,
      )}\n`;
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(result, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } finally {
    remote?.provider.destroy();
    await owner?.close().catch(() => {});
    await hub?.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
// Undici and Hocuspocus may retain unref-unaware keepalive handles after every
// owned server/provider above has closed. This one-shot executable has already
// completed its awaited cleanup, so do not make the operator wait for them.
process.exit(0);
