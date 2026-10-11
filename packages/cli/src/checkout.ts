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

/** Require both markers: mise.toml alone identifies any mise project. */
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
