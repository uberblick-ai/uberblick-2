import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultWorkspaceDatabasePath, readWorkspaceFork, writeWorkspaceFork } from "@uberblick/mcp-server";
import { parseWorkspaceId } from "@uberblick/schema";
import { takeHelp } from "./help.js";
import { acquireInitLock } from "./init-lock.js";
import { type Io, shellArgument } from "./io.js";
import { NO_BINDING, resolveProjectBinding, writeProjectBinding } from "./project-binding.js";
import { reportEnvironmentBinding } from "./workspace-create.js";
import { readWorkspaceHub, withWorkspaceBindings } from "./workspace-registry.js";
import { useField, workspaceLabel } from "./workspace-use-output.js";

export const WORKSPACE_FORK_HELP = `usage: ub workspace fork

Copy this project's workspace into an independent local workspace with a new
workspace UUID, keeping its name and document UUIDs. Select the completed copy
in the nearest .uberblick.json, as workspace use does. The source stays unchanged.

Copies this computer's content, including local changes and archived documents.
No hub connection or sign-in is needed. Missing document content refuses the
copy; first complete a hub replica with ub workspace use <link>.
Publish the copy separately with ub workspace promote <hub>.

options:
  -h, --help        show this help
`;

export async function forkWorkspaceCommand(argv: string[], io: Io): Promise<number> {
  if (takeHelp(argv, io, WORKSPACE_FORK_HELP)) return 0;
  try {
    parseArgs({ args: argv, options: {}, allowPositionals: false });
  } catch (error) {
    io.err(`ub workspace fork: ${error instanceof Error ? error.message : "unexpected argument"}\n\n${WORKSPACE_FORK_HELP}`);
    return 2;
  }
  try {
    const lock = await acquireInitLock(process.env, { command: "ub workspace fork" });
    let output: string;
    try {
      const selected = resolveProjectBinding();
      if (selected.binding === null) throw new Error(selected.bindingProblem ?? NO_BINDING);
      const previous = resolveProjectBinding({ env: {} }).binding;
      const source = parseWorkspaceId(selected.binding.workspaceId).uuid;
      const sourcePath = process.env.UBERBLICK_DB?.trim() || defaultWorkspaceDatabasePath(source);
      if (!existsSync(sourcePath)) throw new Error("this computer has no local copy; fetch it with `ub workspace use <link>` first");
      const snapshot = readWorkspaceFork(sourcePath, source);
      if (snapshot.missing.length > 0) {
        const recorded = readWorkspaceHub(source);
        const hub = recorded === undefined ? selected.binding.hubUrl : recorded;
        const recovery = hub === null
          ? "Restore the missing content before forking."
          : `Complete this computer's copy first: ub workspace use ${shellArgument(`${hub}/${source}`)}`;
        throw new Error(`local copy lacks content for:\n${snapshot.missing.map(doc => `  ${doc.title} (${doc.uuid})`).join("\n")}\n${recovery}`);
      }
      const uuid = randomUUID();
      const destination = defaultWorkspaceDatabasePath(uuid);
      if (existsSync(destination)) throw new Error("generated workspace already exists; retry fork");
      writeWorkspaceFork(destination, uuid, snapshot);
      const binding = { workspaceId: uuid, hubUrl: null };
      // Register only the copy: even an unrecorded source must remain untouched.
      const path = withWorkspaceBindings([binding], () => writeProjectBinding(binding, { record: false }));
      output = useField("forked", workspaceLabel(binding)) + useField("wrote", path);
      if (previous !== null) {
        output += useField("previous", workspaceLabel(previous)) +
          `switch back with: ub workspace use ${shellArgument(previous.workspaceId)}\n`;
      }
    } finally { lock.release(); }
    io.out(output);
    reportEnvironmentBinding(io);
    if (process.env.UBERBLICK_DB?.trim()) {
      io.err("ub: UBERBLICK_DB still selects the source database; unset it to use the fork's default database.\n");
    }
    return 0;
  } catch (error) {
    io.err(`ub workspace fork: ${error instanceof Error ? error.message : "copy failed"}\nProject binding unchanged.\n`);
    return 1;
  }
}
