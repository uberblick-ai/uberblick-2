/**
 * `ub agents` — adopt and run the agent workflow of a project you select.
 *
 * A group rather than a top-level verb because the surface is plural by
 * intent: adopting, listing and updating a project's workflow are the siblings
 * this one is named for. The group keeps that lifecycle beside launch without
 * moving launch again.
 *
 * The CLI transports; it owns no role, no queue and no workflow. Everything it
 * knows about a project comes out of that project's own launch data — see
 * `launch.ts`.
 */

import { type Io, processIo } from "./io.js";
import { launchCommand } from "./launch.js";
import { workflowCommand } from "./workflow-adoption.js";

export const AGENTS_HELP = `usage: ub agents <command>

commands:
  install <source>       adopt a published or local workflow package
  list                   report the workflow and roles this project adopted
  update <source>        move the adopted workflow to another version
  uninstall              remove unchanged resources the workflow still owns
  launch <role>          keep one entry role of a project running in this terminal

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
