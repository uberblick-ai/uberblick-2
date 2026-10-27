import type { IncomingMessage } from "node:http";
import { parseHistoryRetention, type UberblickMcpEngine, type WorkspaceSize } from "@uberblick/mcp-server";
import { readJsonObject } from "./open-access.js";

function localSettings(engine: UberblickMcpEngine, hubConnected: boolean): object {
  let size: WorkspaceSize | null = null;
  try { size = engine.store.workspaceSize(); } catch { /* A later reading can retry an unavailable figure. */ }
  return {
    ...(hubConnected ? { retention: engine.store.readHistoryRetention() } : {}),
    size,
  };
}

export async function serveLocalSettingsRequest(
  engine: UberblickMcpEngine,
  request: IncomingMessage,
  expectedOrigin: string,
  hubConnected: boolean,
  reply: (status: number, body: object, headers?: Record<string, string>) => void,
): Promise<void> {
  if (request.method === "GET") {
    reply(200, localSettings(engine, hubConnected));
    return;
  }
  if (request.method !== "POST") {
    reply(405, { error: "method_not_allowed" }, { allow: "GET, POST" });
    return;
  }
  if (request.headers.origin !== expectedOrigin) {
    reply(403, { status: "origin-refused" });
    return;
  }
  if (!hubConnected) {
    reply(400, { error: "local_only_workspace" });
    request.resume();
    return;
  }
  const body = await readJsonObject(request);
  const retention = body === null ? null : parseHistoryRetention(body.retention);
  if (body === null || Object.keys(body).length !== 1 || retention === null) {
    reply(400, { error: "invalid_request" });
    request.resume();
    return;
  }
  engine.store.setHistoryRetention(retention);
  reply(200, localSettings(engine, hubConnected));
}
