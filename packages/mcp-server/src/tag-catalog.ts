/** MCP-side use of the schema-owned workspace tag catalog. */

import type * as Y from "yjs";
import {
  InvalidTagAssignmentError,
  canonicalDocumentUuid,
  getTagCatalogEntry,
  isTagCatalogIdentityDeleted,
  isTagCatalogSeeded,
  listTagCatalog,
  seedTagCatalog,
} from "@uberblick/schema";
import type { TagCatalogEntry } from "@uberblick/schema";
import { ToolError, incompleteCatalogRecovery } from "./failures.js";
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

/** Existing catalog entries, in schema-owned deterministic name order. */
export function existingTagCatalog(catalog: Y.Doc): TagCatalogEntry[] {
  return listTagCatalog(catalog);
}

/**
 * With sync disabled, the local catalog is complete. Otherwise require the
 * settings handshake and acknowledgement; a pending seed conservatively reads
 * incomplete. Catalog reads settle first.
 */
export function tagCatalogComplete(replicas: Replicas): boolean {
  return (
    !replicas.sync.enabled || replicas.isRoomQuiet(replicas.settings().room)
  );
}

/**
 * An incomplete catalog may explain an unknown value, so recovery waits for it.
 * Positive deletion evidence means waiting cannot make an identity assignable.
 */
function refuseTagValues(
  replicas: Replicas,
  unknown: string[],
): never {
  const { message } = new InvalidTagAssignmentError(unknown);
  throw new ToolError("invalid_tag_assignment", message, {
    unknown,
    ...(unknown.some((value) => isTagCatalogIdentityDeleted(replicas.settings().doc, value)) || tagCatalogComplete(replicas)
      ? {}
      : incompleteCatalogRecovery(replicas.sync.state().status)),
  });
}

/**
 * Refuse unknown filters: an empty result would falsely imply a known tag has
 * no documents. Accept an id or exact current name.
 */
export function resolveTagFilter(
  replicas: Replicas,
  selector: string,
): string {
  const catalog = replicas.settings().doc;
  const byIdentity = getTagCatalogEntry(catalog, selector);
  if (byIdentity !== null) return byIdentity.id;
  const byName = listTagCatalog(catalog).find(
    (entry) => entry.name === selector,
  );
  if (byName !== undefined) return byName.id;
  return refuseTagValues(replicas, [selector]);
}

/**
 * Resolve mutation selectors before any document write.
 *
 * Only existing entries can be selected. Schema assignment preserves delayed
 * references already stored in the document without accepting them as input.
 */
export function resolveTagSelectors(
  replicas: Replicas,
  selectors: readonly string[],
): string[] {
  const catalog = replicas.settings().doc;
  const entries = listTagCatalog(catalog);
  const names = new Map(entries.map((entry) => [entry.name, entry] as const));
  const unknown: string[] = [];
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const selector of selectors) {
    const identity = canonicalDocumentUuid(selector);
    const entry = identity === null ? null : getTagCatalogEntry(catalog, identity);
    let id: string | null = null;

    if (entry !== null) {
      id = entry.id;
    } else {
      const named = names.get(selector);
      if (named !== undefined) id = named.id;
      else unknown.push(selector);
    }

    if (id !== null && !seen.has(id)) {
      seen.add(id);
      resolved.push(id);
    }
  }

  if (unknown.length > 0) {
    refuseTagValues(replicas, unknown);
  }
  return resolved;
}
