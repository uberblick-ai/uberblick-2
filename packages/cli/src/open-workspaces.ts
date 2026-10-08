/** Frozen browser destinations and the serving replicas this foreground owns. */
import { statSync } from "node:fs";
import { parseWorkspaceId } from "@uberblick/schema";
import {
  createMcpEngine,
  ServingReplicaHeldError,
  type McpConfig,
  type UberblickMcpEngine,
} from "@uberblick/mcp-server";
import { resolveConfig } from "./config.js";
import { resolveMcpConfig } from "./budget.js";
import { localBrowserKey } from "./browser-key.js";
import type { ProjectBinding } from "./project-binding.js";
import { readWorkspaceHub } from "./workspace-registry.js";
import { listWorkspaces } from "./workspace.js";

export interface ServedWorkspace {
  workspace: string;
  browserKey: string;
  binding: ProjectBinding;
  config: McpConfig;
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

/** Only an existing replica with explicit machine knowledge is a destination. */
export function browserWorkspaces(
  startup: ProjectBinding,
  startupConfig: McpConfig,
  env: NodeJS.ProcessEnv,
): Map<string, ServedWorkspace> {
  const id = parseWorkspaceId(startup.workspaceId).uuid;
  const result = new Map<string, ServedWorkspace>([[id, {
    workspace: startup.workspaceId,
    browserKey: localBrowserKey(id, env),
    binding: startup,
    config: startupConfig,
  }]]);
  for (const entry of listWorkspaces({ env }).entries) {
    if (entry.uuid === id || !isFile(entry.databasePath)) continue;
    const hubUrl = readWorkspaceHub(entry.uuid, env);
    if (hubUrl === undefined) continue;
    const selected: NodeJS.ProcessEnv = { ...env, UB_WORKSPACE_ID: entry.uuid, UB_HUB_URL: hubUrl ?? "local" };
    // The primary database override and legacy resolved selection cannot leak
    // into another destination. Resolve endpoint admission independently too.
    delete selected.UBERBLICK_DB;
    delete selected.WORKSPACE_ID;
    delete selected.HUB_URL;
    const resolved = resolveConfig({ env: selected });
    const config = resolveMcpConfig(resolved.env);
    const { deviceLogin: _deviceLogin, ...localConfig } = config;
    result.set(entry.uuid, {
      workspace: entry.uuid,
      browserKey: localBrowserKey(entry.uuid, env),
      binding: { workspaceId: entry.uuid, hubUrl },
      // Local-only is explicit, never an invitation to dial the default hub.
      config: hubUrl === null ? { ...localConfig, authSecret: null } : config,
    });
  }
  return result;
}

export type ReplicaUnavailableReason = "replica-held" | "replica-quarantined" | "replica-failed";

export class BrowserReplicaUnavailable extends Error {
  constructor(readonly reason: ReplicaUnavailableReason) {
    super(reason);
  }
}

function requireHealthy(engine: UberblickMcpEngine): void {
  if (engine.health.status === "quarantined") throw new BrowserReplicaUnavailable("replica-quarantined");
  if (engine.refreshStatus.status === "failed") throw new BrowserReplicaUnavailable("replica-failed");
}

/** One lazy start per destination; a tab switch never closes another replica. */
export class BrowserReplicas {
  private readonly engines = new Map<string, UberblickMcpEngine>();
  private readonly starts = new Map<string, Promise<UberblickMcpEngine>>();
  private readonly unsubscribes: (() => void)[] = [];
  private closing = false;

  constructor(
    readonly workspaces: ReadonlyMap<string, ServedWorkspace>,
    startup: UberblickMcpEngine,
    private readonly refresh: (workspaceId: string) => void,
  ) {
    const id = startup.replicas.config.workspaceId;
    this.engines.set(id, startup);
    this.unsubscribes.push(startup.onRefresh(() => refresh(id)));
  }

  read(id: string): UberblickMcpEngine {
    const engine = this.engines.get(id);
    if (engine === undefined || this.closing) throw new BrowserReplicaUnavailable("replica-failed");
    requireHealthy(engine);
    return engine;
  }

  async prepare(id: string): Promise<UberblickMcpEngine> {
    if (this.closing) throw new BrowserReplicaUnavailable("replica-failed");
    if (this.engines.has(id)) return this.read(id);
    const workspace = this.workspaces.get(id);
    if (workspace === undefined) throw new BrowserReplicaUnavailable("replica-failed");
    let started = this.starts.get(id);
    if (started === undefined) {
      started = createMcpEngine(workspace.config, { serving: true }).then(engine => {
        this.engines.set(id, engine);
        if (!this.closing) this.unsubscribes.push(engine.onRefresh(() => this.refresh(id)));
        requireHealthy(engine);
        return engine;
      }).catch(error => {
        if (error instanceof BrowserReplicaUnavailable) throw error;
        throw new BrowserReplicaUnavailable(error instanceof ServingReplicaHeldError ? "replica-held" : "replica-failed");
      });
      this.starts.set(id, started);
    }
    await started;
    return this.read(id);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    await Promise.allSettled(this.starts.values());
    const results = await Promise.allSettled([...this.engines.values()].map(engine => engine.close()));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
}
