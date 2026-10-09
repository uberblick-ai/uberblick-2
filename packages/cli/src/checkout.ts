/**
 * Whether `ub` is being run inside an uberblick checkout.
 *
 * One question, one answer, and only ever used to decide whether to *mention*
 * the contributor tasks: the mise tasks exist in a checkout and nowhere else, so
 * `ub init` names `mise run dev` there and stays quiet outside. Nothing is
 * written by this detector. Development tasks resolve the project binding and
 * this machine's private credentials themselves.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function isUberblickPackage(dir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { name?: unknown }).name === "uberblick"
    );
  } catch {
    return false;
  }
}

/**
 * The nearest ancestor that is an uberblick checkout, or null.
 *
 * Both markers are required: `mise.toml` alone is any mise project.
 */
export function findCheckoutRoot(from: string): string | null {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, "mise.toml")) && isUberblickPackage(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}
