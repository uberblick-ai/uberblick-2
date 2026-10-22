#!/usr/bin/env node
/**
 * The source-checkout entry needs tsx at runtime, supplied by devDependencies.
 * Resolve its loader from this file; a --import tsx shebang resolves against
 * the caller's directory and fails when ub is launched elsewhere.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function isFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function checkoutEntry() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  // Archives and primary working trees run themselves. Git files can also
  // describe submodules or separate git dirs, so let Git identify the primary.
  if (!isFile(join(root, ".git"))) return import.meta.url;
  const optIn = join(root, ".uberblick-use-shared-replicas");
  try {
    if (!lstatSync(optIn).isFile()) throw new Error("opt-in must be a regular file");
    return import.meta.url;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const env = { ...process.env };
  // Repository selection must follow this executable, not the calling shell.
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  const git = (args) => execFileSync("git", ["-C", root, ...args], {
    env, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
  });
  const directory = git(["rev-parse", "--path-format=absolute", "--git-dir"]);
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (directory === common) return import.meta.url;
  const listing = git(["worktree", "list", "--porcelain", "-z"]);
  const first = listing.split("\0")[0];
  if (!first.startsWith("worktree ")) throw new Error("primary working tree not found");
  const primary = first.slice("worktree ".length);
  if (realpathSync(primary) === realpathSync(root)) return import.meta.url;
  const entry = join(primary, "packages", "cli", "bin", "ub.mjs");
  const manifest = JSON.parse(readFileSync(join(primary, "package.json"), "utf8"));
  if (manifest.name !== "uberblick" || !isFile(join(primary, "mise.toml")) || !isFile(entry)) {
    throw new Error("primary checkout entry missing");
  }
  return pathToFileURL(entry).href;
}

let entry;
try {
  entry = checkoutEntry();
} catch (error) {
  process.stderr.write(`ub: cannot safely select primary checkout: ${error.message}\n`);
  process.stderr.write("restore/setup the primary checkout, or deliberately opt this checkout into shared replicas with a regular .uberblick-use-shared-replicas file at its root\n");
  process.exit(1);
}

if (entry !== import.meta.url) {
  // Loading the primary entry in this process preserves cwd, arguments, stdio
  // and signal handling, including the MCP server's shutdown drain.
  await import(entry);
} else {
  const { register } = await import("tsx/esm/api");
  // A caller's tsconfig aliases must not redirect the selected checkout's
  // package imports back into a branch. The MCP child inherits the same pin.
  const tsconfig = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
  process.env.TSX_TSCONFIG_PATH = tsconfig;
  // Keep warning policy in main.ts so this shim and the compiled bundle agree.
  register({ tsconfig });
  await import(new URL("../src/main.ts", import.meta.url).href);
}
