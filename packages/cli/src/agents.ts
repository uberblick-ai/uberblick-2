/**
 * `ub agents` — select and run the agent workflow of a project folder.
 *
 * A group rather than a top-level verb because the surface is plural by
 * intent: installing, listing and removing a project's workflow selection are
 * the siblings this one is named for. The group keeps that lifecycle beside
 * launch without moving launch again.
 *
 * The CLI transports; it owns no role, no queue and no workflow. Everything it
 * knows about grants and bindings comes from project launch data; workflow
 * bytes come from the verified installation the project selects — see
 * `launch.ts`.
 */

import { type Io, processIo } from "./io.js";
import { launchCommand } from "./launch.js";
import { workflowCommand } from "./workflow-adoption.js";

export const AGENTS_HELP = `usage: ub agents <command>

commands:
  install <workflow@version|package-path>  store and select a published or local workflow
  list                                     report this project's selected workflow and roles
  update <workflow@version|package-path>   retired; use install to change the selection
  uninstall                                remove this project's workflow selection
  launch <role>                            keep one entry role of a project running in this terminal

options:
  -h, --help             show this help; after a command, that command's help
`;

export async function agentsCommand(
  argv: string[],
  io: Io = processIo,
): Promise<number> {
  // The subcommand first, so `ub agents launch --help` reaches the help of the
  // leaf it names rather than being answered by the group. A group's own
  // argument is that one word, so only that word can ask for help — an unknown
  // command is still an unknown command, `--help` after it or not.
  const [sub, ...rest] = argv;
  if (sub === "launch") {
    return await launchCommand(rest, io);
  }
  if (sub === "install" || sub === "list" || sub === "update" || sub === "uninstall") {
    return await workflowCommand(sub, rest, io);
  }
  if (sub === "help" || sub === "--help" || sub === "-h") {
    io.out(AGENTS_HELP);
    return 0;
  }
  const named = sub === undefined ? " nothing" : ` ${JSON.stringify(sub)}`;
  io.err(
    `ub agents: expected "install", "list", "update", "uninstall" or "launch", got${named}\n\n${AGENTS_HELP}`,
  );
  return 2;
}
