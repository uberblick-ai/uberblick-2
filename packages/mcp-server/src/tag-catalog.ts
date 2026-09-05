/** MCP-side use of the schema-owned workspace tag catalog. */

import type * as Y from "yjs";
import {
  InvalidTagAssignmentError,
  canonicalDocumentUuid,
  getTagCatalogEntry,
  isTagCatalogSeeded,
  listTagCatalog,
  seedTagCatalog,
} from "@uberblick/schema";
import type { TagAssignment, TagCatalogEntry } from "@uberblick/schema";
import { log } from "./log.js";
import type { Replicas } from "./replica.js";

/** Seed the ordinary examples after the settings room's bounded first settle. */
export async function seedTagCatalogOnce(replicas: Replicas): Promise<void> {
  try {
    await replicas.settle({ requireHealthy: false });
  } catch (error) {
    log.warn("the tag catalog could not settle before seeding", error);
    return;
  }
  if (replicas.persistenceError() !== null) return;

  const settings = replicas.settings();
  if (isTagCatalogSeeded(settings.doc)) return;
  seedTagCatalog(settings.doc);

  const failure = replicas.persistenceError();
  if (failure !== null) {
    log.error("the tag catalog seed did not reach the update log", {
      room: settings.room,
      applied: false,
      message: failure.message,
    });
    return;
  }
  log.info("seeded the workspace tag catalog", {
    room: settings.room,
    applied: true,
    synced: replicas.isRoomQuiet(settings.room),
  });
}

/** The complete active catalog, in schema-owned deterministic name order. */
export function activeTagCatalog(catalog: Y.Doc): TagCatalogEntry[] {
  return listTagCatalog(catalog).filter((entry) => entry.state === "active");
}

/** Resolve an id or exact current name for a discovery filter. */
export function resolveTagFilter(
  catalog: Y.Doc,
  selector: string,
): string | null {
  const byIdentity = getTagCatalogEntry(catalog, selector);
  if (byIdentity !== null) return byIdentity.id;
  return listTagCatalog(catalog).find((entry) => entry.name === selector)?.id ?? null;
}

/**
 * Resolve mutation selectors before any document write.
 *
 * Names select active entries only. Identities can additionally preserve a
 * retired or still-unresolved assignment the document already holds; this is
 * why reads return canonical ids beside display names.
 */
export function resolveTagSelectors(
  catalog: Y.Doc,
  selectors: readonly string[],
  existing: readonly TagAssignment[] = [],
): string[] {
  const entries = listTagCatalog(catalog);
  const activeNames = new Map(
    entries
      .filter((entry) => entry.state === "active")
      .map((entry) => [entry.name, entry] as const),
  );
  const retiredNames = new Set(
    entries
      .filter((entry) => entry.state === "retired")
      .map((entry) => entry.name),
  );
  const assigned = new Set(existing.map((entry) => entry.id));
  const unknown: string[] = [];
  const retired: string[] = [];
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const selector of selectors) {
    const identity = canonicalDocumentUuid(selector);
    const entry = identity === null ? null : getTagCatalogEntry(catalog, identity);
    let id: string | null = null;

    if (entry !== null) {
      if (entry.state === "retired" && !assigned.has(entry.id)) {
        retired.push(selector);
        continue;
      }
      id = entry.id;
    } else if (identity !== null && assigned.has(identity)) {
      id = identity;
    } else {
      const named = activeNames.get(selector);
      if (named !== undefined) id = named.id;
      else if (retiredNames.has(selector)) retired.push(selector);
      else unknown.push(selector);
    }

    if (id !== null && !seen.has(id)) {
      seen.add(id);
      resolved.push(id);
    }
  }

  if (unknown.length > 0 || retired.length > 0) {
    throw new InvalidTagAssignmentError(unknown, retired);
  }
  return resolved;
}
