/**
 * UUID identity prevents same-named workspaces from merging on one hub. Slugs
 * are display only: room keys, token claims and database filenames use bare UUIDs.
 * All input surfaces share this parser, with no default or opaque-string fallback.
 */

import { InvalidWorkspaceIdError } from "./errors.js";

/**
 * Optional slug uses exactly one joining hyphen; a trailing hyphen is invalid.
 * Lowercase UUIDs accept any version/variant, including other generators' ids.
 */
const WORKSPACE_ID =
  /^(?:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export interface WorkspaceId {
  /** The identity. Everything two machines compare is this string. */
  uuid: string;
  /** The cosmetic prefix, or null when the id was written bare. */
  slug: string | null;
}

/**
 * Labels identify the failing input source; never print its rejected value,
 * which may be a secret mistakenly supplied as a workspace id.
 */
export function parseWorkspaceId(
  value: string,
  label = "WORKSPACE_ID",
): WorkspaceId {
  const match = WORKSPACE_ID.exec(value);
  if (match === null) {
    throw new InvalidWorkspaceIdError(label);
  }
  const [, slug, uuid] = match;
  // The UUID capture is required by the pattern but typed as optional.
  if (uuid === undefined) {
    throw new InvalidWorkspaceIdError(label);
  }
  return { uuid, slug: slug ?? null };
}
