import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { readRequestBody } from "@modelcontextprotocol/sdk/server/requestBody.js";
import { CallToolRequestSchema, isJSONRPCRequest, JSONRPCMessageSchema, type RequestId } from "@modelcontextprotocol/sdk/types.js";

/** Only executable tool requests consume call slots; the SDK refuses other shapes. */
export function hostToolCallId(message: unknown): RequestId | undefined {
  const parsed = JSONRPCMessageSchema.safeParse(message);
  if (!parsed.success || !isJSONRPCRequest(parsed.data) || !CallToolRequestSchema.safeParse(parsed.data).success) return;
  if (parsed.data.params?.task !== undefined) return;
  return parsed.data.id;
}

/** Use the SDK's body bound and message schema before reserving a whole batch. */
export async function readHostPost(request: IncomingMessage): Promise<{
  body: unknown;
  calls: RequestId[];
} | { status: 400 | 413 }> {
  const webRequest = new Request("http://mcp.invalid/", {
    method: "POST", body: Readable.toWeb(request), duplex: "half",
  } as RequestInit);
  const read = await readRequestBody(webRequest);
  if (read.tooLarge) return { status: 413 };
  try {
    const body: unknown = JSON.parse(read.text);
    const messages = Array.isArray(body) ? body : [body];
    const calls: RequestId[] = [];
    for (const message of messages) {
      const id = hostToolCallId(message);
      if (id !== undefined) calls.push(id);
    }
    return { body, calls };
  } catch {
    return { status: 400 };
  }
}
