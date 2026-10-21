/** Tool operations over a private in-memory store, with no MCP client or transport. */
import { GuidanceBriefing } from "../src/briefing.js";
import type { McpConfig } from "../src/config.js";
import { ServerWork } from "../src/server-work.js";
import type { MirrorStore } from "../src/store.js";
import { seedTagCatalogOnce } from "../src/tag-catalog.js";
import { guarded } from "../src/tool-adapter.js";
import { createToolContext } from "../src/tools/context.js";
import { openWorkspaceReplicas } from "../src/workspace-replicas.js";
import type { WorkspaceReplicaSet } from "../src/workspace-replicas.js";
import { testConfig as integrationConfig, CLIENT_NAME, toolNamed } from "./shared.js";
import type { TestConfigOptions, ToolCall } from "./shared.js";

export * from "./shared.js";

export function testConfig(options: TestConfigOptions = {}): McpConfig {
  return integrationConfig({ databasePath: ":memory:", ...options });
}

export interface Rig {
  readonly instance: WorkspaceReplicaSet;
  readonly config: McpConfig;
  readonly clientName: string;
  call(name: string, args?: Record<string, unknown>): Promise<ToolCall>;
  ok(name: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

export async function startServer(config = testConfig(), store?: MirrorStore): Promise<Rig> {
  if (config.databasePath !== ":memory:" || (store && store.databasePath !== ":memory:")) {
    throw new Error("Core rigs require an in-memory store; use the integration rig for files.");
  }
  if (config.authSecret !== null || config.deviceLogin !== undefined) {
    throw new Error("Core rigs require hub-free configuration.");
  }
  const instance = openWorkspaceReplicas(config, { hubFree: true, ...(store === undefined ? {} : { store }) });
  const work = new ServerWork();
  const context = createToolContext(instance.replicas, new GuidanceBriefing(instance.replicas), work);
  instance.replicas.setAgentName(CLIENT_NAME);
  await seedTagCatalogOnce(instance.replicas);

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolCall> => {
    const tool = toolNamed(name);
    // Like MCP registration, refuse before admitting the operation or any write.
    const parsed = tool.input.safeParse(args);
    if (!parsed.success) return {
      isError: true,
      payload: { error: "schema_validation", message: parsed.error.message },
    };
    const result = await guarded(tool, context)(parsed.data, { signal: new AbortController().signal });
    const content = result.content[0];
    if (content?.type !== "text") throw new Error(`Tool ${name} returned no JSON text`);
    return { isError: result.isError === true, payload: JSON.parse(content.text) };
  };

  let closing: Promise<void> | undefined;
  return {
    instance, config, clientName: CLIENT_NAME, call,
    async ok(name, args) {
      const result = await call(name, args);
      if (result.isError) throw new Error(`tool ${name} failed: ${JSON.stringify(result.payload)}`);
      return result.payload;
    },
    close() {
      work.stop();
      closing ??= work.drain().then(() => instance.close());
      return closing;
    },
  };
}
