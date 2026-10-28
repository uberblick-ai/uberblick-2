import { randomUUID } from "node:crypto";
import { readDocumentHistory, readDocumentRevision, requireDocumentHistory, RevisionClientError,
  WorkspaceDetachedError, WorkspaceRemovedError, type UberblickMcpEngine } from "@uberblick/mcp-server";
import { isDocId } from "@uberblick/schema";
import * as Y from "yjs";

interface RevisionReply { status: number; body: object }
interface PendingRead {
  uuid: string;
  revision: string | null;
  refresh: boolean;
  result: Promise<RevisionReply>;
  settledAt: number | null;
}

const readsByEngine = new WeakMap<UberblickMcpEngine, Map<string, PendingRead>>();
const HTTP_WAIT_MS = 5_000;
const COMPLETED_READ_TTL_MS = 60_000;

function requireHistory(engine: UberblickMcpEngine, uuid: string): void {
  try { engine.replicas.store.assertWorkspacePresent(); }
  catch (error) {
    if (error instanceof WorkspaceDetachedError || error instanceof WorkspaceRemovedError) {
      throw new RevisionClientError("unreachable", { uuid, reason: "cache-superseded" });
    }
    throw error;
  }
  requireDocumentHistory(engine.replicas, uuid);
  if (engine.replicas.config.localWorkspace === true) throw new RevisionClientError("local-only");
}

function failedRead(error: unknown): RevisionReply {
  if (!(error instanceof RevisionClientError)) throw error;
  const { reason: cause, ...details } = error.details;
  return { status: 503, body: { error: "history_unavailable", ...details, reason: error.code,
    ...(cause === undefined ? {} : { cause }) } };
}

async function readRevision(engine: UberblickMcpEngine, uuid: string, revision: string | null, refresh: boolean): Promise<RevisionReply> {
  const options = { timeoutMs: 120_000, ...(refresh ? { refresh: true as const } : {}) };
  try {
    requireHistory(engine, uuid);
    if (revision === null) return { status: 200, body: await readDocumentHistory(engine.replicas, uuid, options) };
    const { doc, history } = await readDocumentRevision(engine.replicas, uuid, revision, options);
    try { return { status: 200, body: { state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"), history } }; }
    finally { doc.destroy(); }
  } catch (error) { return failedRead(error); }
}

/** Keep the original result through the browser's bounded wait, including snapshots outside retention. */
export async function serveRevisionRead(
  engine: UberblickMcpEngine,
  target: URL,
  reply: (status: number, body: object) => void,
): Promise<void> {
  const uuid = target.searchParams.get("uuid");
  if (uuid === null || !isDocId(uuid)) { reply(400, { error: "invalid_document" }); return; }
  const revision = target.searchParams.get("revision");
  if (revision !== null && (revision.length === 0 || revision.length > 256)) { reply(400, { error: "invalid_revision" }); return; }
  const refresh = target.searchParams.get("refresh") === "true";
  let reads = readsByEngine.get(engine);
  if (reads === undefined) { reads = new Map(); readsByEngine.set(engine, reads); }
  const cutoff = Date.now() - COMPLETED_READ_TTL_MS;
  for (const [id, pending] of reads) if (pending.settledAt !== null && pending.settledAt <= cutoff) reads.delete(id);

  const requestedId = target.searchParams.get("readId");
  const readId = requestedId ?? randomUUID();
  try { requireHistory(engine, uuid); }
  catch (error) {
    reads.delete(readId);
    const result = failedRead(error);
    reply(result.status, result.body);
    return;
  }
  let pending = reads.get(readId);
  if (requestedId !== null && (pending === undefined || pending.uuid !== uuid || pending.revision !== revision || pending.refresh !== refresh)) {
    reply(400, { error: "invalid_history_read" });
    return;
  }
  if (pending === undefined) {
    // A post-mutation refresh cannot reuse a catalog request sent before the acknowledgement.
    const previous = refresh ? [...reads.values()].filter(read => read.uuid === uuid).map(read => read.result) : [];
    const result = previous.length === 0 ? readRevision(engine, uuid, revision, refresh)
      : Promise.allSettled(previous).then(() => readRevision(engine, uuid, revision, refresh));
    pending = { uuid, revision, refresh, result, settledAt: null };
    reads.set(readId, pending);
    const started = pending;
    void started.result.then(() => { started.settledAt = Date.now(); }, () => { started.settledAt = Date.now(); });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([pending.result, new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), HTTP_WAIT_MS);
    })]);
    requireHistory(engine, uuid);
    if (result === null) {
      reply(503, { error: "history_unavailable", reason: "downloading", uuid,
        ...(revision === null ? {} : { revision }), readId });
    } else {
      reads.delete(readId);
      reply(result.status, result.body);
    }
  } catch (error) {
    reads.delete(readId);
    const result = failedRead(error);
    reply(result.status, result.body);
  }
  finally { clearTimeout(timer); }
}
