import type { z } from "zod";
import { DOCUMENT_MUTATING_TOOLS } from "../failures.js";
import type { Replica } from "../replica.js";
import type { ToolContext } from "./context.js";

/** Request information only; operations do not act on cancellation or metadata yet. */
export interface OperationRequest {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number | undefined; [key: string]: unknown } | undefined;
  progressToken?: string | number | undefined;
}

/**
 * Args must already be parsed with the tool's exported inputSchema. The MCP
 * SDK does this before calling the adapter; direct callers must do it too.
 */
export type Operation<Args, Payload extends object = object> = (
  context: ToolContext,
  args: Args,
  request: OperationRequest,
) => Promise<Payload>;

/**
 * The common prologue belongs to operations, including callers without MCP.
 * The schema infers Args here; input parsing remains the caller's responsibility.
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

/** Content locks and content-change nudges are separate existing guarantees. */
const DOCUMENT_WRITES = {
  edit_block: { content: true, contentDurability: true },
  insert_block: { content: true, contentDurability: true },
  delete_block: { content: true, contentDurability: true },
  link_range: { content: true, contentDurability: false },
  set_title: { content: true, contentDurability: false },
  set_tldr: { content: true, contentDurability: false },
  update_data: { content: true, contentDurability: false },
  set_description: { content: false, contentDurability: false },
  set_links: { content: false, contentDurability: false },
  set_tags: { content: false, contentDurability: false },
  set_status: { content: false, contentDurability: false },
  annotate: { content: false, contentDurability: false },
} as const;

/** Synchronous writes after settling retain the existing refusal and append order. */
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
    // The sidebar stores uuids and nothing else, so a typo pinned here is a
    // reference nothing can ever resolve. Identity is checked against the
    // directory — an archived document is still pinnable, deliberately:
    // archive_doc unpins, so this is the one way back to a pin, and
    // get_sidebar surfaces the archived state either way. Unknown pins must
    // remain removable, so the other sidebar operations have no check.
    if (tool === "pin_doc") context.requireStub((args as Args & { uuid: string }).uuid);
    const sidebar = context.replicas.sidebar();
    return { ...body(context, args, request, sidebar), ...context.durability(sidebar) };
  });
}
