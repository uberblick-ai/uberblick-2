/**
 * Proof 0 instrumentation (throwaway, worktree-only). Enabled by PROOF0_TRACE.
 *
 * Every line is one JSON object on stderr prefixed with `P0 ` so a driver can
 * pick it out of ordinary log output.
 */

import { HocuspocusProvider } from "@hocuspocus/provider";
import { getBlocksFragment } from "@uberblick/schema";
import * as Y from "yjs";

export const traceEnabled = process.env.PROOF0_TRACE === "1";

export function trace(record: Record<string, unknown>): void {
  if (!traceEnabled) return;
  process.stderr.write(`P0 ${JSON.stringify({ t: Date.now(), ...record })}\n`);
}

export interface RawBlock {
  index: number;
  id: string | null;
  type: string;
  text: string;
  /** The Yjs id of the element's own item: which client created it. */
  item: string | null;
}

/** The plain text of one block element: every Y.XmlText child's inserts. */
export function elementText(element: Y.XmlElement): string {
  return element
    .toArray()
    .map((child) =>
      child instanceof Y.XmlText
        ? child
            .toDelta()
            .map((op: { insert?: unknown }) => (typeof op.insert === "string" ? op.insert : ""))
            .join("")
        : "",
    )
    .join("");
}

/** Every element in the blocks fragment — shadowed duplicates included. */
export function rawBlocks(doc: Y.Doc): RawBlock[] {
  const out: RawBlock[] = [];
  const children = getBlocksFragment(doc).toArray();
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!(child instanceof Y.XmlElement)) {
      out.push({
        index,
        id: null,
        type: `foreign:${child?.constructor?.name ?? typeof child}`,
        text: "",
        item: null,
      });
      continue;
    }
    const item = child._item;
    out.push({
      index,
      id: child.getAttribute("id") ?? null,
      type: child.nodeName,
      text: elementText(child),
      item: item ? `${item.id.client}:${item.id.clock}` : null,
    });
  }
  return out;
}

export interface UpdateSummary {
  /** Per creating client: how many structs and the string content they carry. */
  structs: Record<string, { count: number; length: number; strings: string[] }>;
  /** Delete set, keyed by the *deleted* item's client (not the deleter). */
  deletes: Record<string, [number, number][]>;
  bytes: number;
}

export function describeUpdate(payload: Uint8Array): UpdateSummary {
  const summary: UpdateSummary = { structs: {}, deletes: {}, bytes: payload.byteLength };
  try {
    const decoded = Y.decodeUpdate(payload);
    for (const struct of decoded.structs) {
      const key = String(struct.id.client);
      const entry = (summary.structs[key] ??= { count: 0, length: 0, strings: [] });
      entry.count += 1;
      entry.length += struct.length;
      const content = (struct as { content?: { str?: string } }).content;
      if (content && typeof content.str === "string") {
        entry.strings.push(content.str.slice(0, 60));
      }
    }
    decoded.ds.clients.forEach((items, client) => {
      summary.deletes[String(client)] = items.map((item) => [item.clock, item.len]);
    });
  } catch (error) {
    (summary as { error?: string }).error = String(error);
  }
  return summary;
}

/** Name a transaction origin without leaking objects into the log. */
export function describeOrigin(
  origin: unknown,
  isHubProvider: (origin: unknown) => boolean,
): string {
  if (origin === null) return "null";
  if (origin === undefined) return "undefined";
  if (origin instanceof HocuspocusProvider) {
    return isHubProvider(origin) ? `hub-provider:${origin.configuration.name}` : `other-provider:${origin.configuration.name}`;
  }
  if (typeof origin === "string" || typeof origin === "number") return `scalar:${String(origin)}`;
  if (typeof origin === "symbol") return `symbol:${origin.description ?? ""}`;
  return `object:${(origin as { constructor?: { name?: string } })?.constructor?.name ?? "?"}`;
}
