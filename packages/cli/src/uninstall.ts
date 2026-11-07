import { lstatSync, readdirSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { acquireWorkspaceRemovalRole, readStoredSyncStatus, readWorkspaceName } from "@uberblick/mcp-server";
import { readHubLogins } from "@uberblick/mcp-server/auth-store";
import { acquireInitLock, type InitLock } from "@uberblick/mcp-server/init-lock";
import { resolveStorage, WORKSPACE_DATABASE_FILE } from "@uberblick/mcp-server/storage";
import { readWorkspaceHub } from "@uberblick/mcp-server/workspace-registry";
import type { CommandArgs } from "./command.js";
import { confirm } from "./confirmation.js";
import type { Io } from "./io.js";
import { openRunPaths } from "./open-run.js";
import { errorMessage } from "./strings.js";
import { classify, FORMULA, processHost, type UpdateHost } from "./update.js";
import { cliVersion } from "./version.js";

export const UNINSTALL_OPTIONS = {
  yes: { type: "boolean", default: false },
  "delete-data": { type: "boolean", default: false },
} as const;

export const UNINSTALL_HELP = `usage: ub uninstall [--yes] [--delete-data]

Remove the Homebrew installation, with a choice to delete this computer's data.
Lists the resolved config and data roots, workspace copy-loss risks and logins
before asking. Both answers default to no; only y or yes confirms.

options:
  --yes             uninstall without asking; keep local data unless --delete-data
  --delete-data     delete both local roots; without --yes, still confirm uninstall
  -h, --help        show this help and do nothing else

Without terminal stdin, --yes is required. Data deletion refuses while a running
\`ub open\` serves a workspace; stop it first. Deletion happens before Homebrew,
so a deletion failure leaves the program installed. \`brew uninstall\` alone
keeps the data. Absolute XDG_CONFIG_HOME and XDG_DATA_HOME select the roots.

External UBERBLICK_DB and HUB_DB_PATH databases, project .uberblick.json files,
MCP client registrations and anything on a hub are kept. Running agent sessions
are not detected; stop them too if the roots must stay gone.
`;

export interface UninstallHost extends UpdateHost {
  isTerminal: boolean;
  confirm(question: string): Promise<boolean>;
}

function processUninstallHost(): UninstallHost {
  return { ...processHost(), isTerminal: process.stdin.isTTY === true, confirm };
}

function children(path: string): string[] | null {
  try { return readdirSync(path).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function inventory() {
  const roots = resolveStorage();
  const data = children(roots.dataDir);
  const config = children(roots.configDir);
  const workspaces = (data ?? []).flatMap(file => {
    const id = WORKSPACE_DATABASE_FILE.exec(file)?.[1];
    if (id === undefined) return [];
    const path = join(roots.dataDir, file);
    return [{
      id, path, name: readWorkspaceName(path, id), hub: readWorkspaceHub(id),
      pending: readStoredSyncStatus(path, id).pendingRooms,
    }];
  });
  const logins = readHubLogins();
  if (logins.state === "refused" || logins.state === "unreadable") throw new Error(logins.diagnostic);
  const hubs = [...new Set([...Object.keys(logins.logins), ...logins.unreadableHubs, ...logins.signedOutHubs])].sort();
  return { roots, data, config, workspaces, hubs };
}

type Inventory = ReturnType<typeof inventory>;

function showInventory(found: Inventory, io: Io): void {
  io.out(`Uberblick ${cliVersion()}, installed with Homebrew.\n\n`);
  if (found.data === null && found.config === null) {
    io.out("There is no local data on this computer.\n\n");
    return;
  }
  io.out("Local data on this computer:\n");
  if (found.data !== null) {
    const local = found.workspaces.filter(workspace => workspace.hub === null).length;
    const unknown = found.workspaces.filter(workspace => workspace.hub === undefined).length;
    const pending = found.workspaces.filter(workspace => workspace.pending.length > 0).length;
    io.out(`  ${found.roots.dataDir}/  ${found.workspaces.length} workspace replicas ` +
      `(${local} local-only, ${unknown} with no hub record; ${pending} with unacknowledged changes)\n`);
    const other = found.data.filter(file => !WORKSPACE_DATABASE_FILE.test(file));
    if (other.length > 0) io.out(`    also: ${other.map(file => JSON.stringify(file)).join(", ")}\n`);
    for (const workspace of found.workspaces) {
      const warnings = [
        ...(workspace.hub === null ? ["local-only: this is its only copy"] : []),
        ...(workspace.hub === undefined ? ["no hub record: this may be the only copy"] : []),
        ...(workspace.pending.length > 0 ? ["changes no hub has acknowledged will be lost"] : []),
      ];
      if (warnings.length > 0) {
        io.out(`    ${workspace.name === null ? workspace.id : `${JSON.stringify(workspace.name)} (${workspace.id})`}: ${warnings.join("; ")}\n`);
      }
    }
  }
  if (found.config !== null) {
    io.out(`  ${found.roots.configDir}/  ${found.config.length === 0 ? "empty" : found.config.map(file => JSON.stringify(file)).join(", ")}\n`);
    io.out(`    ${found.hubs.length === 0 ? "no hub logins" : `logins for ${found.hubs.join(", ")}`}\n`);
  }
  io.out("\n");
}

/** Keep the init lock and its ancestors until every recursive removal is over. */
function removeRoots(roots: Inventory["roots"], lock: InitLock): void {
  const lockPath = realpathSync(lock.path);
  const retained = new Set<string>();
  const remove = (path: string): void => {
    if (path === lockPath) return;
    if (lockPath.startsWith(`${path}${sep}`) && lstatSync(path).isDirectory()) {
      for (const name of readdirSync(path)) remove(join(path, name));
      retained.add(path);
    } else rmSync(path, { recursive: true, force: true });
  };
  // A nested or identical root can have disappeared in the first removal.
  for (const path of new Set([roots.dataDir, roots.configDir])) {
    try { remove(realpathSync(path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`could not delete ${path}: ${errorMessage(error)}`);
      }
    }
  }
  lock.release();
  // A new writer after release can only make rmdir fail, never lose its files.
  for (const path of [...retained].sort((a, b) => b.length - a.length)) rmdirSync(path);
}

async function deleteData(found: Inventory, confirmedInteractively: boolean): Promise<void> {
  if (found.data === null && found.config === null) return;
  // known limit: deletion refuses symlinked storage roots; revisit when a supported setup needs them.
  for (const path of [found.roots.dataDir, found.roots.configDir]) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error(`cannot delete symlinked storage root ${path}; move it aside first`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const lock = await acquireInitLock(process.env, { command: "ub uninstall --delete-data" });
  const roles: { close(): void }[] = [];
  try {
    const current = inventory();
    // The lock itself is new; compare only copy-loss facts and login destinations.
    if (confirmedInteractively && JSON.stringify([current.workspaces, current.hubs]) !== JSON.stringify([found.workspaces, found.hubs])) {
      throw new Error("local data changed during confirmation; nothing was removed, run the command again");
    }
    for (const path of [...openRunPaths(process.env), ...current.workspaces.map(workspace => workspace.path)]) {
      roles.push(acquireWorkspaceRemovalRole(path));
    }
    // known limit: running ub mcp serve can recreate the config root; revisit when uninstall must keep both roots gone.
    removeRoots(current.roots, lock);
  } finally {
    for (const role of roles.reverse()) role.close();
    lock.release();
  }
}

export async function uninstallCommand(
  { values }: CommandArgs<typeof UNINSTALL_OPTIONS>, io: Io,
  host: UninstallHost = processUninstallHost(),
): Promise<number> {
  if (classify(host).kind !== "homebrew") {
    io.err("ub uninstall: this command only uninstalls Homebrew installations. Nothing has changed.\n");
    return 1;
  }
  let found: Inventory;
  let deletes = values["delete-data"];
  try {
    found = inventory();
    showInventory(found, io);
    if (!values.yes) {
      if (!host.isTerminal) {
        throw new Error("uninstalling requires confirmation at a terminal; pass --yes to uninstall and keep local data, or --yes --delete-data to delete it too");
      }
      if (!await host.confirm("Uninstall Uberblick?")) {
        io.out("cancelled; nothing was removed\n");
        return 0;
      }
      if (!deletes && (found.data !== null || found.config !== null)) {
        deletes = await host.confirm("Also delete the local data above?");
      }
    }
    if (deletes) await deleteData(found, !values.yes);
  } catch (error) {
    io.err(`ub uninstall: ${errorMessage(error)}. The program was not uninstalled.\n`);
    return 1;
  }
  const dataResult = deletes ? "Local data was deleted." : `Local data was kept in ${found.roots.dataDir} and ${found.roots.configDir}.`;
  io.out(`${dataResult} Removing the program...\n`);
  // All dependencies used after Homebrew removes the running payload are loaded.
  const failure = await host.run("brew", ["uninstall", FORMULA]);
  if (failure !== null) {
    io.err(`ub uninstall: ${failure.message}. ${dataResult}\n`);
    return failure.status;
  }
  return 0;
}
