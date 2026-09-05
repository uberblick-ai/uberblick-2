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

/** The complete active catalog, in schema-owned deterministic name order. */
export function activeTagCatalog(catalog: Y.Doc): TagCatalogEntry[] {
  return listTagCatalog(catalog).filter((entry) => entry.state === "active");
}

/**
 * Whether this replica may call the catalog it holds the whole workspace one.
 *
 * With no hub configured this replica *is* the workspace, so what it holds is
 * all there is. With a hub, the seeded examples are only this replica's guess
 * until the settings room has actually exchanged state with it — a curated
 * vocabulary lives there, and answering `complete: true` before it arrives
 * tells an agent a false vocabulary is the whole one.
 *
 * `isRoomQuiet` is the conservative side of that question: it cannot be true
 * before the room synced, so this never dresses an unhydrated catalog up as a
 * complete one. It also reads false for the moment a local seed is still on
 * its way to the hub, which understates completeness rather than overstating
 * it — and every read settles first, so that moment is not one an agent waits
 * in.
 */
export function tagCatalogComplete(replicas: Replicas): boolean {
  return (
    !replicas.sync.enabled || replicas.isRoomQuiet(replicas.settings().room)
  );
}

/**
 * Refuse a whole call for tag values this catalog does not have.
 *
 * The recovery depends on what this replica knows. With the catalog complete,
 * the failure table's "call list_tags" is the whole answer. Where the settings
 * room has not reached this replica, `list_tags` cannot name the value either
 * — it may be a real workspace tag — so the failure says that instead of
 * sending the caller round a loop that cannot help.
 *
 * A retired blocker is the exception: this replica already holds the value and
 * already knows it is retired, and hydration cannot make it assignable again.
 * The table's `manual` stands for any refusal carrying one, so an agent is
 * never told to repeat a call only catalog curation can unblock.
 */
function refuseTagValues(
  replicas: Replicas,
  unknown: string[],
  retired: string[],
): never {
  const { message } = new InvalidTagAssignmentError(unknown, retired);
  throw new ToolError("invalid_tag_assignment", message, {
    unknown,
    retired,
    ...(retired.length > 0 || tagCatalogComplete(replicas)
      ? {}
      : incompleteCatalogRecovery(replicas.sync.state().status)),
  });
}

/**
 * Resolve an id or exact current name for a discovery filter.
 *
 * A selector nothing resolves is refused rather than answered with an empty
 * result: the same value refuses on a write, and an empty listing is
 * indistinguishable from the honest "no document carries this tag".
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
  return refuseTagValues(replicas, [selector], []);
}

/**
 * Resolve mutation selectors before any document write.
 *
 * Names select active entries only. Identities can additionally preserve a
 * retired or still-unresolved assignment the document already holds; this is
 * why reads return canonical ids beside display names.
 */
export function resolveTagSelectors(
  replicas: Replicas,
  selectors: readonly string[],
  existing: readonly TagAssignment[] = [],
): string[] {
  const catalog = replicas.settings().doc;
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
    refuseTagValues(replicas, unknown, retired);
  }
  return resolved;
}
