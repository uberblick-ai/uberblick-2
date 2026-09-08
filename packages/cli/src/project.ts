/**
 * Which project a command acts on, when that is not the checkout `ub` came from.
 *
 * An installed `ub` has no project of its own: the executable may live in a
 * Homebrew cellar, an install payload or a checkout, and none of those three
 * locations may decide whose roles run. So the project is resolved from what
 * the caller pointed at — `--project <dir>`, or the working directory — and the
 * answer is that directory's Git root, because a project's launch data, role
 * contracts, runtime adapters and worktrees all hang off that one root.
 *
 * Git is asked rather than walked by hand: `git rev-parse --show-toplevel`
 * already knows about worktrees, `.git` files and `GIT_DIR`, and a second
 * implementation of that walk would disagree with the `git worktree` calls the
 * launcher makes afterwards. `findCheckoutRoot` in `checkout.ts` answers a
 * different question — "is this uberblick's own source" — and is not this.
 */

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";

export interface ProjectResolution {
  /** The Git root that owns the project's launch data and worktrees. */
  root: string;
  /** What the caller pointed at, for a message that can be acted on. */
  from: string;
}

/**
 * The project root `selected` or `cwd` names, or why there is none.
 *
 * `--project` names a directory *in* the project, not necessarily its root: one
 * rule for both spellings, so `--project .` and no option at all agree.
 */
export function resolveProjectRoot(
  selected: string | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): { project: ProjectResolution; error?: undefined } | { error: string; project?: undefined } {
  const from = resolve(cwd, selected ?? ".");
  try {
    if (!statSync(from).isDirectory()) {
      return { error: `${from} is not a directory` };
    }
  } catch {
    return { error: `${from} does not exist` };
  }
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: from,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if ((top.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return { error: "git is not installed; install it before selecting a project" };
  }
  const root = top.stdout.trim();
  if (top.status !== 0 || root === "") {
    return { error: `no Git project at or above ${from}` };
  }
  return { project: { root, from } };
}
