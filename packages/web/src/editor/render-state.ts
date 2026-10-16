import { blockRev, canonicalJson, compareCodePoints } from "@uberblick/schema";
import type { JSONValue, RevInput } from "@uberblick/schema";

export interface RenderData {
  collections: readonly {
    name: string;
    schema: JSONValue | null;
    records: readonly { id: string; value: JSONValue }[];
  }[];
}

/** Only stored values participate, so MCP reads and write inputs produce the same revision. */
export function dataRevision(data: RenderData | null): string {
  const collections = data?.collections.map(collection => [collection.name, collection.schema,
    [...collection.records].sort((a, b) => compareCodePoints(a.id, b.id)).map(record => [record.id, record.value]),
  ] as const).sort((a, b) => compareCodePoints(a[0], b[0])) ?? [];
  return blockRev({ type: "code", language: "json", text: canonicalJson(collections, Infinity) });
}

/** Call after the synchronous drawing or error presentation, inside ignored node-view chrome. */
export function recordDraw(element: HTMLElement, source: RevInput, dataRev: string, succeeded: boolean): void {
  element.dataset.sourceRev = blockRev(source);
  element.dataset.dataRev = dataRev;
  element.dataset.drawState = succeeded ? "success" : "error";
}
