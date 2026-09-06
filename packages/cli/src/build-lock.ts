/**
 * The lock a build of the web bundle holds.
 *
 * Its own module because two commands build that one directory — `ub open`
 * rebuilds a stale bundle before serving it, and `ub update` refreshes it after
 * a fast-forward — and the whole point of the lock is that they agree on the
 * name. A second copy of this expression would be a lock that does not lock.
 *
 * **Named after the directory, because the directory is the resource.** The
 * hazard is two builds emptying and rewriting one `dist`, so what has to be
 * mutually exclusive is builds of the same output — not runs that happen to
 * share a configuration. Keying it on the config root instead would let two runs
 * of one checkout under different `XDG_CONFIG_HOME` values build at once, which
 * is exactly what this repository's own test rig and its parallel agents
 * produce.
 *
 * In the temp directory because the two other candidates are both wrong: a
 * checkout is not a place this CLI writes state into, and the config root is
 * the key that must not decide this. The name is a digest rather than the path
 * itself so that any directory — spaces, separators, length — yields one
 * portable file name. `wx` on it means a name somebody else already holds is a
 * refusal rather than a hijack.
 *
 * So the *name* is the output's, and the directory it lives in is
 * `os.tmpdir()` — which is the one thing two runs have to agree about. It is
 * environment (`TMPDIR`), nothing in `ub` or in this repository varies it, and
 * runs deliberately given different temp roots get two locks and no exclusion;
 * the cost when that happens is the transient broken serve, never lost work.
 * Which accounts share that root is the platform's answer: per-user on macOS,
 * usually the shared `/tmp` on Linux — whose sticky bit is why a timeout
 * message can only name a stale lock rather than promise it is yours to remove.
 */

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function buildLockPath(dir: string): string {
  const key = createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16);
  return join(tmpdir(), `uberblick-build-${key}.lock`);
}
