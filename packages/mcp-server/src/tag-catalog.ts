/** MCP-side use of the schema-owned workspace tag catalog. */

import type * as Y from "yjs";
import {
  InvalidTagAssignmentError,
  getTagCatalogEntry,
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
  if (replicas.config.localWorkspace !== true) return;
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

/** Existing tags, in schema-owned deterministic name order. */
export function activeTagCatalog(catalog: Y.Doc): TagCatalogEntry[] {
  return listTagCatalog(catalog);
}

/**
 * A hub workspace's catalog needs the settings handshake and acknowledgement;
 * a pending seed conservatively reads incomplete. Catalog reads settle first.
 */
export function tagCatalogComplete(replicas: Replicas): boolean {
  return replicas.roomComplete(replicas.settings().room);
}

/** A read filter writes nothing, so its recovery does not talk about stored assignments. */
const UNKNOWN_FILTER_RECOVERY =
  "Call list_tags for the complete existing catalog, then filter by an existing id or name (case ignored). " +
  "An unknown tag is refused rather than answered with an empty list, which would read as a tag with no documents.";

/**
 * An incomplete catalog may explain an unknown value, so recovery waits for it.
 */
function refuseTagValues(
  replicas: Replicas,
  unknown: string[],
  use: "assignment" | "filter" = "assignment",
): never {
  const { message } = new InvalidTagAssignmentError(unknown);
  throw new ToolError("invalid_tag_assignment", message, {
    unknown,
    ...(tagCatalogComplete(replicas)
      ? use === "filter" ? { recovery: UNKNOWN_FILTER_RECOVERY } : {}
      : incompleteCatalogRecovery(replicas.hubState().status)),
  });
}

/**
 * Refuse unknown filters: an empty result would falsely imply a known tag has
 * no documents. Accept an id or current name, ignoring name case.
 */
export function resolveTagFilter(
  replicas: Replicas,
  selector: string,
): string {
  const catalog = replicas.settings().doc;
  const byIdentity = getTagCatalogEntry(catalog, selector);
  if (byIdentity !== null) return byIdentity.id;
  const name = selector.toLowerCase();
  const byName = listTagCatalog(catalog).find(
    (entry) => entry.name === name,
  );
  if (byName !== undefined) return byName.id;
  return refuseTagValues(replicas, [selector], "filter");
}

/**
 * Resolve mutation selectors before any document write.
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
    const entry = getTagCatalogEntry(catalog, selector) ?? names.get(selector.toLowerCase());
    const id = entry?.id ?? null;
    if (id === null) unknown.push(selector);

    if (id !== null && !seen.has(id)) {
      seen.add(id);
      resolved.push(id);
    }
  }

  if (unknown.length > 0) refuseTagValues(replicas, unknown);
  return resolved;
}
