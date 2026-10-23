import type { z } from "zod";
import { cleanupDeletedDocumentTags } from "@uberblick/schema";
import type { Replica } from "../replica.js";
import type { ToolContext } from "./context.js";

/** Operations receive this information but do not act on cancellation or metadata. */
export interface OperationRequest {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number | undefined; [key: string]: unknown } | undefined;
  progressToken?: string | number | undefined;
}

/**
 * Args must be parsed with the exported inputSchema. The MCP SDK refuses
 * invalid args as plain text before the adapter runs; direct callers must parse too.
 */
export type Operation<Args, Payload extends object = object> = (
  context: ToolContext,
  args: Args,
  request: OperationRequest,
) => Promise<Payload>;

/**
 * What a call may write. A writing tool's failure says what became of the write.
 */
export type Writes = "document" | "sidebar" | null;

/** An operation together with the write class its wrapper enforces. */
export type ToolOperation<Args, Payload extends object = object, W extends Writes = Writes> =
  Operation<Args, Payload> & { readonly writes: W };

interface Gates<W extends Writes> {
  readonly writes: W;
  readonly settle: boolean;
}

/** Workspace reads settle first. */
export const READ: Gates<null> = { writes: null, settle: true };

/** Writes that manage their own rooms settle first. */
export const DOCUMENT_WRITE: Gates<"document"> = { writes: "document", settle: true };

/**
 * Diagnostics settle with requireHealthy:false; bundled help never reads
 * replicas. Neither takes the normal healthy settle.
 */
export const UNSETTLED_READ: Gates<null> = { writes: null, settle: false };

const SIDEBAR_WRITE: Gates<"sidebar"> = { writes: "sidebar", settle: true };

/**
 * Callers must parse input; _input only infers Args. Keep settling here so
 * callers without MCP use the same gates.
 */
export function operation<Args, Payload extends object, W extends Writes>(
  gates: Gates<W>,
  _input: z.ZodType<Args>,
  body: (context: ToolContext, args: Args, request: OperationRequest) => Payload | Promise<Payload>,
): ToolOperation<Args, Payload, W> {
  const run = async (context: ToolContext, args: Args, request: OperationRequest): Promise<Payload> => {
    if (gates.settle) await context.replicas.settle();
    return body(context, args, request);
  };
  return Object.assign(run, { writes: gates.writes });
}

/** Content locks and content-change nudges have separate scopes. */
export interface DocumentWrite {
  /** Refuse a decided record's answer blocks and data. */
  readonly content: boolean;
  /** Report the TL;DR review nudge with durability. */
  readonly contentDurability: boolean;
}

/** Keep refusal, synchronous write and durability checking in this order. */
export function documentOperation<Args extends { uuid: string }, Payload extends object>(
  policy: DocumentWrite,
  input: z.ZodType<Args>,
  body: (context: ToolContext, args: Args, request: OperationRequest, replica: Replica) => Payload,
) {
  return operation(DOCUMENT_WRITE, input, (context, args, request) => {
    const replica = context.requireWritableDoc(args.uuid, policy.content);
    let changed = false;
    const noteChange = () => { changed = true; };
    replica.doc.on("update", noteChange);
    let payload: Payload;
    try {
      payload = body(context, args, request, replica);
    } finally {
      replica.doc.off("update", noteChange);
    }
    if (changed) cleanupDeletedDocumentTags(replica.doc, context.tagCatalog());
    return {
      ...payload,
      ...(policy.contentDurability ? context.contentDurability(replica) : context.durability(replica)),
    };
  });
}

/** Sidebar writes share durability without acquiring document-write gates. */
export function sidebarOperation<Args extends object, Payload extends object>(
  policy: { readonly requireStub: boolean },
  input: z.ZodType<Args>,
  body: (context: ToolContext, args: Args, request: OperationRequest, sidebar: Replica) => Payload,
) {
  return operation(SIDEBAR_WRITE, input, (context, args, request) => {
    // New pins need a known stub, including archived stubs surfaced by get_sidebar.
    // Do not gate other operations: unknown pins must remain removable.
    if (policy.requireStub) context.requireStub((args as Args & { uuid: string }).uuid);
    const sidebar = context.replicas.sidebar();
    return { ...body(context, args, request, sidebar), ...context.durability(sidebar) };
  });
}
