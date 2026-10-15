import type { z } from "zod";
import { DOCUMENT_MUTATING_TOOLS } from "../failures.js";
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
 * Callers must parse input; _input only infers Args. Keep settling and briefing
 * here so callers without MCP use the same gates.
 */
export function operation<Args, Payload extends object>(
  tool: string,
  _input: z.ZodType<Args>,
  body: (context: ToolContext, args: Args, request: OperationRequest) => Payload | Promise<Payload>,
): Operation<Args, Payload> {
  return async (context, args, request) => {
    // Diagnostics settle with requireHealthy:false; bundled help never reads
    // replicas. Every workspace operation uses the normal healthy settle.
    if (tool !== "sync_status" && tool !== "get_help") await context.replicas.settle();
    if (DOCUMENT_MUTATING_TOOLS.has(tool)) context.briefing.require();
    return body(context, args, request);
  };
}

/** Content locks and content-change nudges have separate scopes. */
const DOCUMENT_WRITES = {
  edit_block: { content: true, contentDurability: true },
  insert_block: { content: true, contentDurability: true },
  delete_block: { content: true, contentDurability: true },
  link_range: { content: true, contentDurability: false },
  update_data: { content: true, contentDurability: false },
  set_metadata: { content: false, contentDurability: false },
  set_status: { content: false, contentDurability: false },
  annotate: { content: false, contentDurability: false },
} as const;

/** Keep refusal, synchronous write and durability checking in this order. */
export function documentOperation<Args extends { uuid: string }, Payload extends object>(
  tool: keyof typeof DOCUMENT_WRITES,
  input: z.ZodType<Args>,
  body: (context: ToolContext, args: Args, request: OperationRequest, replica: Replica) => Payload,
) {
  return operation(tool, input, (context, args, request) => {
    const policy = DOCUMENT_WRITES[tool];
    const replica = context.requireWritableDoc(args.uuid, policy.content);
    const payload = body(context, args, request, replica);
    return {
      ...payload,
      ...(policy.contentDurability ? context.contentDurability(replica) : context.durability(replica)),
    };
  });
}

/** Sidebar writes share durability without acquiring document-write gates. */
export function sidebarOperation<Args extends object, Payload extends object>(
  tool: "pin_doc" | "unpin_doc" | "sidebar_group",
  input: z.ZodType<Args>,
  body: (context: ToolContext, args: Args, request: OperationRequest, sidebar: Replica) => Payload,
) {
  return operation(tool, input, (context, args, request) => {
    // New pins need a known stub, including archived stubs surfaced by get_sidebar.
    // Do not gate other operations: unknown pins must remain removable.
    if (tool === "pin_doc") context.requireStub((args as Args & { uuid: string }).uuid);
    if (tool === "unpin_doc") context.requireNotDeleted((args as Args & { uuid: string }).uuid);
    const sidebar = context.replicas.sidebar();
    return { ...body(context, args, request, sidebar), ...context.durability(sidebar) };
  });
}
