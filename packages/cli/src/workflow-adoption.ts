/** `ub agents install|list|uninstall` — select a machine-stored workflow. */

import { parseArgs } from "node:util";
import { join } from "node:path";
import { type Io, processIo } from "./io.js";
import { readLaunchData } from "./launch.js";
import { resolveProjectDirectory } from "./project.js";
import {
  inspectWorkflowSelection,
  selectWorkflow,
  unselectWorkflow,
} from "./workflow-storage.js";
import { loadWorkflowPackage, type LoadedWorkflowPackage } from "./workflow-package.js";

export const AGENTS_INSTALL_HELP = `usage: ub agents install <workflow@version|package-path> [--project <dir>]

Validate and store one workflow under this machine's Uberblick data, then
select it for one project folder. Installing another exact version replaces
only that project's selection; an identical selection is idempotent. The
selected project is not modified. Published packages are downloaded without
authentication from the GitHub release for that exact version in
uberblick-ai/homebrew-tap.

options:
  --project <dir>        select a project folder; defaults to the current project
  -h, --help             show this help
`;

export const AGENTS_UPDATE_HELP = `usage: ub agents update <workflow@version|package-path> [--project <dir>]

This command has been retired. Run \`ub agents install <workflow@version|package-path>\`
to store and select another exact version for the project.

options:
  --project <dir>        accepted for compatibility; update changes nothing
  -h, --help             show this help
`;

export const AGENTS_UNINSTALL_HELP = `usage: ub agents uninstall [--project <dir>]

Remove this project folder's workflow selection. Stored installations and the
selections of other projects are not changed.

options:
  --project <dir>        select a project folder; defaults to the current project
  -h, --help             show this help
`;

export const AGENTS_LIST_HELP = `usage: ub agents list [--project <dir>]

Report the effective project folder, its selected workflow, source, exact
version, verified storage state and roles. With no external selection, report
the temporary project-tree fallback used by launch.

options:
  --project <dir>        select a project folder; defaults to the current project
  -h, --help             show this help
`;

export const WORKFLOW_OPTIONS = { project: { type: "string" } } as const;

class UsageError extends Error {}

function parseCommand(
  argv: string[],
  help: string,
  source: "required" | "absent",
): { source?: string; project?: string } | { help: true } {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const parsed = (() => {
    try {
      return parseArgs({ args: argv, options: WORKFLOW_OPTIONS, allowPositionals: true, strict: true });
    } catch (error) {
      throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n\n${help}`);
    }
  })();
  if (source === "required" && parsed.positionals.length !== 1) {
    throw new UsageError(`expected exactly one <workflow@version|package-path>\n\n${help}`);
  }
  if (source === "absent" && parsed.positionals.length !== 0) {
    throw new UsageError(`expected no positional arguments\n\n${help}`);
  }
  const supplied = parsed.positionals[0];
  if (source === "required" && supplied !== undefined) {
    if (supplied === "") throw new UsageError(`the workflow source cannot be empty\n\n${help}`);
    if (
      !supplied.includes("/") &&
      supplied.includes("@") &&
      !/^[a-z0-9][a-z0-9-]*@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(supplied)
    ) {
      throw new UsageError(`a published source must be workflow@MAJOR.MINOR.PATCH\n\n${help}`);
    }
  }
  return {
    ...(supplied === undefined ? {} : { source: supplied }),
    ...(parsed.values.project === undefined ? {} : { project: parsed.values.project }),
  };
}

function projectDirectory(selected: string | undefined): string {
  const resolved = resolveProjectDirectory(selected, process.cwd(), process.env);
  if (resolved.error !== undefined) throw new Error(resolved.error);
  return resolved.project.root;
}

function rolesOf(project: string, workflowRoot: string): string[] | "missing" | null {
  try {
    return Object.keys(readLaunchData(project, undefined, workflowRoot).entryRoles).sort();
  } catch (error) {
    if (String(error).includes(".agents/launch.json") && String(error).includes("missing")) return "missing";
    return null;
  }
}

function printRoles(io: Io, roles: ReturnType<typeof rolesOf>): void {
  const summary = roles === "missing"
    ? "unavailable; .agents/launch.json is missing; add the project's launch declaration before launching"
    : roles === null
      ? "unavailable; repair .agents/launch.json or its declared role files before launching"
      : roles.join(", ");
  io.out(`roles: ${summary}\n`);
}

export async function workflowCommand(
  command: "install" | "update" | "uninstall" | "list",
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  const help = {
    install: AGENTS_INSTALL_HELP,
    update: AGENTS_UPDATE_HELP,
    uninstall: AGENTS_UNINSTALL_HELP,
    list: AGENTS_LIST_HELP,
  }[command];
  try {
    if (command === "update") {
      if (argv.includes("--help") || argv.includes("-h")) io.out(help);
      else io.err("ub agents update: retired; run `ub agents install <source>` instead\n");
      return argv.includes("--help") || argv.includes("-h") ? 0 : 2;
    }
    const parsed = parseCommand(argv, help, command === "install" ? "required" : "absent");
    if ("help" in parsed) {
      io.out(help);
      return 0;
    }
    const project = projectDirectory(parsed.project);
    if (command === "list") {
      const inspected = inspectWorkflowSelection(project);
      io.out(`project: ${project}\n`);
      if (inspected.record === null) {
        io.out("selection: none; launch uses the temporary workflow files in the project tree\n");
        printRoles(io, rolesOf(project, project));
        return 0;
      }
      const selected = inspected.record.selected;
      if (selected === null) {
        io.out("selection: none; launch uses the temporary workflow files in the project tree while selection is pending\n");
        printRoles(io, rolesOf(project, project));
      } else {
        io.out(`workflow: ${selected.workflow}\n`);
        io.out(`version: ${selected.version}\n`);
        io.out(`source: ${selected.source.kind} ${selected.source.repository}@${selected.source.commit}\n`);
        io.out(`installation: ${selected.installation}\n`);
        if (inspected.selectedProblem === null) {
          io.out("state: verified\n");
          printRoles(io, rolesOf(project, join(selected.installation, "payload")));
        } else {
          io.out(`state: unusable — ${inspected.selectedProblem}\n`);
          printRoles(io, null);
          io.out("next action: run `ub agents install <source>` to repair the stored installation, or `ub agents uninstall` to remove this project's selection\n");
        }
      }
      if (inspected.record.pending !== null) {
        const target = inspected.record.pending.target;
        io.out(`pending: select ${target.workflow}@${target.version}\n`);
        io.out(`pending installation: ${target.installation}\n`);
        io.out(`pending storage: ${inspected.pendingProblem === null ? "ready" : `incomplete — ${inspected.pendingProblem}`}\n`);
        io.out("next action: rerun `ub agents install <source>` with the same package, or run `ub agents uninstall` to undo it\n");
      }
      return 0;
    }
    if (command === "uninstall") {
      unselectWorkflow(project);
      io.out(`Removed the workflow selection for ${project}; stored installations were kept.\n`);
      return 0;
    }
    let pkg: LoadedWorkflowPackage;
    try {
      pkg = await loadWorkflowPackage(parsed.source as string, process.cwd());
    } catch (error) {
      io.err(
        `ub agents install: ${error instanceof Error ? error.message : String(error)}; ` +
          "no selection was changed — correct or make the source reachable, then rerun `ub agents install <source>`\n",
      );
      return 1;
    }
    const selected = selectWorkflow(project, pkg);
    io.out(
      `${selected.changed ? "Selected" : "Already selected"} ${pkg.manifest.workflow}@${pkg.manifest.version} ` +
        `from ${pkg.sourceKind} source for ${project}.\n`,
    );
    return 0;
  } catch (error) {
    io.err(`ub agents ${command}: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
