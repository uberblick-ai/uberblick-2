import type { IncomingMessage } from "node:http";
import { mutateDocumentRevision, restoreDocumentRevision, RevisionClientError, type UberblickMcpEngine } from "@uberblick/mcp-server";
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
    : body?.operation === "restore" ? ["uuid", "operation", "revisionId", "expectedHash"]
    : body?.operation === "rename" ? ["uuid", "operation", "revisionId", "name"]
    : body?.operation === "remove_name" ? ["uuid", "operation", "revisionId"] : [];
  if (body === null || typeof body.uuid !== "string" || !isDocId(body.uuid) || fields.length === 0 ||
    Object.keys(body).some(field => !fields.includes(field)) ||
    ((body.operation === "name" || body.operation === "restore") &&
      (typeof body.expectedHash !== "string" || !/^[a-f0-9]{64}$/u.test(body.expectedHash))) ||
    (body.operation !== "name" && (typeof body.revisionId !== "string" || body.revisionId.length === 0 || body.revisionId.length > 256)) ||
    ((body.operation === "name" || body.operation === "rename") && typeof body.name !== "string")) {
    reply(400, { error: "invalid_request" });
    request.resume();
    return;
  }
  try {
    if (body.operation === "restore") {
      reply(200, await restoreDocumentRevision(engine.replicas, body.uuid, {
        operation: "restore", revisionId: body.revisionId as string, checksum: body.expectedHash as string,
        surface: { kind: "browser", name: "browser" },
      }));
      return;
    }
    const mutation = body.operation === "name"
      ? { operation: "name" as const, checksum: body.expectedHash as string, name: body.name as string, surface: { kind: "browser" as const, name: "browser" } }
      : body.operation === "rename"
        ? { operation: "rename" as const, revisionId: body.revisionId as string, name: body.name as string }
        : { operation: "remove-name" as const, revisionId: body.revisionId as string };
    reply(200, { revision: await mutateDocumentRevision(engine.replicas, body.uuid, mutation) });
  } catch (error) {
    if (!(error instanceof RevisionClientError)) throw error;
    if (body.operation === "restore") {
      const { reason: cause, ...details } = error.details;
      reply(409, { error: "revision_restore_failed", ...details, reason: error.code,
        ...(cause === undefined ? {} : { cause }) });
      return;
    }
    reply(409, { error: "revision_name_failed", reason: error.code, ...error.details });
  }
}
