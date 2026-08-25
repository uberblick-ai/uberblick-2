/**
 * Workspace identity.
 *
 * A workspace id is a **uuid** — globally unique, opaque, never guessable. For
 * display it may be decorated with a cosmetic slug, `<slug>-<uuid>`, so a URL or
 * a config file can read as `uberblick-7f3a2c1e-…` instead of 36 hex
 * characters. The slug is presentation only: it is parsed off here, and nothing
 * two machines compare — a room name, a token claim, the SQLite filename — ever
 * carries one.
 *
 * Why a uuid and not a name: two independent parties both calling their
 * workspace `default` would silently *union* their corpora on one hub. The
 * directory is a Y.Map keyed by document uuid, so disjoint keys merge cleanly —
 * no conflict, no error, no way back. A uuid makes that collision impossible.
 *
 * This is the one parse, applied at every surface where a workspace id enters
 * the system: the environment, config files, CLI arguments, URLs. There is no
 * opaque-string fallback and no default workspace.
 */

import { InvalidWorkspaceIdError } from "./errors.js";

/**
 * `<slug>-<uuid>`, the slug optional.
 *
 * The slug is `[a-z0-9][a-z0-9-]*` but may not *end* in a hyphen: the character
 * joining a slug to the uuid is exactly one `-`, so `foo--<uuid>` is not a
 * workspace id. The uuid is lowercase 8-4-4-4-12 hex; the version and variant
 * nibbles are left unconstrained so an id from somewhere other than
 * `crypto.randomUUID` still parses.
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
 * Read a workspace id, rejecting anything that is not one.
 *
 * `label` names the source in the message — a bad value in `./uberblick.json`
 * must not report itself as a bad `WORKSPACE_ID`. The rejected value is
 * deliberately *not* in the message: `label` already says where to look, and a
 * secret mistakenly exported as `WORKSPACE_ID` would otherwise be printed by
 * the very error that refuses it.
 *
 * @throws InvalidWorkspaceIdError
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
  // Both groups are present whenever the pattern matched; the uuid group is not
  // optional, and the assertion is only here because the types say `string |
  // undefined`.
  if (uuid === undefined) {
    throw new InvalidWorkspaceIdError(label);
  }
  return { uuid, slug: slug ?? null };
}
