import type { IncomingMessage } from "node:http";
import { mutateDocumentRevision, RevisionClientError, type UberblickMcpEngine } from "@uberblick/mcp-server";
import { isDocId } from "@uberblick/schema";
import { readJsonObject } from "./open-access.js";

/** The browser's displayed checksum passes through unchanged to the hub. */
export async function serveRevisionMutation(
  engine: UberblickMcpEngine,
  request: IncomingMessage,
  reply: (status: number, body: object) => void,
): Promise<void> {
  const body = await readJsonObject(request);
  const fields = body?.operation === "name" ? ["uuid", "operation", "expectedHash", "name"]
    : body?.operation === "rename" ? ["uuid", "operation", "revisionId", "name"]
    : body?.operation === "remove_name" ? ["uuid", "operation", "revisionId"] : [];
  if (body === null || typeof body.uuid !== "string" || !isDocId(body.uuid) || fields.length === 0 ||
    Object.keys(body).some(field => !fields.includes(field)) ||
    (body.operation === "name" && (typeof body.expectedHash !== "string" || !/^[a-f0-9]{64}$/u.test(body.expectedHash))) ||
    (body.operation !== "name" && (typeof body.revisionId !== "string" || body.revisionId.length === 0 || body.revisionId.length > 256)) ||
    (body.operation !== "remove_name" && typeof body.name !== "string")) {
    reply(400, { error: "invalid_request" });
    request.resume();
    return;
  }
  try {
    const mutation = body.operation === "name"
      ? { operation: "name" as const, checksum: body.expectedHash as string, name: body.name as string, surface: { kind: "browser" as const, name: "browser" } }
      : body.operation === "rename"
        ? { operation: "rename" as const, revisionId: body.revisionId as string, name: body.name as string }
        : { operation: "remove-name" as const, revisionId: body.revisionId as string };
    reply(200, { revision: await mutateDocumentRevision(engine.replicas, body.uuid, mutation) });
  } catch (error) {
    if (!(error instanceof RevisionClientError)) throw error;
    reply(409, { error: "revision_name_failed", reason: error.code, ...error.details });
  }
}
