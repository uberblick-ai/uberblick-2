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
 * already knows about worktrees and `.git` files, and a second implementation
 * of that walk would disagree with the `git worktree` calls the launcher makes
 * afterwards. Ambient repository selectors are removed first: an explicit
 * project path must not lose to a caller's `GIT_DIR` or `GIT_WORK_TREE`.
 * `findCheckoutRoot` in `checkout.ts` answers a different question — "is this
 * uberblick's own source" — and is not this.
 */

import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

export interface ProjectResolution {
  /** The Git root that owns the project's launch data and worktrees. */
  root: string;
  /** What the caller pointed at, for a message that can be acted on. */
  from: string;
}

/**
 * Git variables that can make a command operate on a repository other than its
 * cwd. Configuration variables stay intact, so normal credential helpers and
 * user configuration still work; only repository/object/worktree selection is
 * removed.
 */
const REPOSITORY_SELECTORS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;

export function withoutRepositorySelectors(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const name of REPOSITORY_SELECTORS) delete clean[name];
  return clean;
}

function contains(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
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
  let selectedPath: string;
  try {
    if (!statSync(from).isDirectory()) {
      return { error: `${from} is not a directory` };
    }
    selectedPath = realpathSync(from);
  } catch {
    return { error: `${from} does not exist` };
  }
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: selectedPath,
    env: withoutRepositorySelectors(env),
    encoding: "utf8",
    timeout: 30_000,
  });
  if ((top.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return { error: "git is not installed; install it before selecting a project" };
  }
  const reportedRoot = top.stdout.trim();
  if (top.status !== 0 || reportedRoot === "") {
    return { error: `no Git project at or above ${from}` };
  }
  let root: string;
  try {
    root = realpathSync(reportedRoot);
  } catch {
    return { error: `Git reported an unusable project root for ${from}` };
  }
  if (!contains(root, selectedPath)) {
    return { error: `Git resolved ${root} outside the selected directory ${from}` };
  }
  return { project: { root, from } };
}
