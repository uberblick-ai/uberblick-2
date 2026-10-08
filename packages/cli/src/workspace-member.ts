import { createInterface } from "node:readline/promises";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { isGithubAccountId, isGithubUsername } from "@uberblick/hub";
import { ensureDeviceLogin, readDeviceLogin } from "@uberblick/hub/device-login";
import { authenticationOrigin } from "@uberblick/hub/remote-url";
import { parseWorkspaceId } from "@uberblick/schema";
import { ManagementResponseError, manageRequest } from "./access-management.js";
import type { ManagementAction } from "./access-management.js";
import { requireBinding, resolveConfig } from "./config.js";
import { takeHelp } from "./help.js";
import type { Io } from "./io.js";

export const WORKSPACE_MEMBER_HELP = `usage: ub workspace member <command>

Manage access to the project's bound hub workspace as a workspace admin.
Uses this machine's stored device login; never starts a GitHub sign-in.

<member> is a GitHub login (case-insensitive) or permanent account ID.
The project binding and UB_WORKSPACE_ID/UB_HUB_URL select the target.

commands:
  add <github-handle> [--role admin|member]  confirm a resolved account and grant access
  list [--json]                              list members, account IDs and roles
  role <member> <admin|member>               change a member's role
  remove <member>                            end a member's access on every device

options:
  -h, --help        show this help
`;

export const WORKSPACE_MEMBER_SUBCOMMAND_HELP = {
  add: `usage: ub workspace member add <github-handle> [--role admin|member]

Resolve a GitHub user at the bound hub, then confirm the hub origin, workspace
UUID, login, permanent account ID and role at a terminal prompt. Only y or yes
grants access; the default is no. Non-terminal input cannot grant access.
The default role is member. An existing membership keeps its role.

options:
  --role admin|member   role for a new membership (default: member)
  -h, --help            show this help
`,
  list: `usage: ub workspace member list [--json]

List the bound workspace's current members: GitHub login, account ID and role.

options:
  --json           print only JSON on stdout
  -h, --help       show this help
`,
  role: `usage: ub workspace member role <member> <admin|member>

Change a current member's role in the bound workspace. Match a GitHub login
(case-insensitive) or account ID; ambiguous matches are refused.
The last admin cannot be demoted.

options:
  -h, --help        show this help
`,
  remove: `usage: ub workspace member remove <member>

Remove a current member from the bound workspace, by GitHub login
(case-insensitive) or account ID. Ambiguous matches are refused.
This ends that account's access to this workspace on every device. It revokes
no devices and leaves other workspaces alone. The last admin cannot be removed.

options:
  -h, --help        show this help
`,
} as const;

export const WORKSPACE_MEMBER_ADD_OPTIONS = { role: { type: "string" } } as const;
export const WORKSPACE_MEMBER_LIST_OPTIONS = { json: { type: "boolean" } } as const;

type Role = "admin" | "member";
interface Member {
  principalId: string;
  githubUsername: string;
  githubAccountId: string;
  role: Role;
}
class MemberRefusal extends Error {}

function isRole(value: unknown): value is Role { return value === "admin" || value === "member"; }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function member(value: unknown): Member {
  if (!object(value) || typeof value.principalId !== "string" || value.principalId.length === 0 ||
    typeof value.githubUsername !== "string" || value.githubUsername.length === 0 ||
    !isGithubAccountId(value.githubAccountId) || !isRole(value.role)) {
    throw new MemberRefusal("hub returned an invalid member response; update the hub and retry");
  }
  return { principalId: value.principalId, githubUsername: value.githubUsername,
    githubAccountId: value.githubAccountId, role: value.role };
}
function describe(value: Pick<Member, "githubUsername" | "githubAccountId">): string {
  // Stored logins can be stale or contain terminal controls; they are display data.
  return `${JSON.stringify(value.githubUsername)} (GitHub account ${value.githubAccountId})`;
}
function already(value: Member, io: Io): void {
  io.out(`already a member: ${describe(value)} as ${value.role}; use \`ub workspace member role ${value.githubAccountId} <admin|member>\` to change the role\n`);
}

export async function workspaceMemberCommand(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || ["help", "--help", "-h"].includes(command)) {
    io.out(WORKSPACE_MEMBER_HELP); return 0;
  }
  const help = Object.hasOwn(WORKSPACE_MEMBER_SUBCOMMAND_HELP, command) ? WORKSPACE_MEMBER_SUBCOMMAND_HELP[command as keyof typeof WORKSPACE_MEMBER_SUBCOMMAND_HELP] : undefined;
  if (help === undefined) {
    io.err(`ub workspace member: unknown command ${JSON.stringify(command)}\n\n${WORKSPACE_MEMBER_HELP}`); return 2;
  }
  if (takeHelp(rest, io, help)) return 0;
  let positionals: string[];
  let role: Role = "member";
  let json = false;
  try {
    const options: ParseArgsOptionsConfig =
      command === "add" ? WORKSPACE_MEMBER_ADD_OPTIONS :
      command === "list" ? WORKSPACE_MEMBER_LIST_OPTIONS : {};
    const parsed = parseArgs({ args: rest, allowPositionals: true, options });
    positionals = parsed.positionals;
    const count = command === "list" ? 0 : command === "role" ? 2 : 1;
    if (positionals.length !== count) throw new Error(`expected ${count} argument${count === 1 ? "" : "s"}`);
    if (command === "add") {
      if (!isGithubUsername(positionals[0])) throw new Error("malformed GitHub handle; use a GitHub user login without @ or path syntax");
      const requested = parsed.values.role ?? "member";
      if (!isRole(requested)) throw new Error("role must be admin or member");
      role = requested;
    }
    if (command === "role") {
      if (!isRole(positionals[1])) throw new Error("role must be admin or member");
      role = positionals[1];
    }
    json = parsed.values.json === true;
  } catch (error) {
    io.err(`ub workspace member ${command}: ${error instanceof Error ? error.message : "invalid arguments"}\n\n${help}`);
    return 2;
  }

  try {
    const { resolved, binding } = (() => {
      try {
        const resolved = resolveConfig();
        return { resolved, binding: requireBinding(resolved) };
      } catch (error) {
        throw new MemberRefusal(error instanceof Error ? error.message : "invalid project binding");
      }
    })();
    if (binding.hubUrl === null) throw new MemberRefusal("the selected workspace is local-only and has no members; promote it to a hub first");
    const endpoint = binding.hubUrl;
    const origin = authenticationOrigin(endpoint);
    const workspaceId = parseWorkspaceId(binding.workspaceId).uuid;
    for (const warning of resolved.warnings) io.err(`ub: warning: ${warning}\n`);
    const before = readDeviceLogin(endpoint, workspaceId);
    let current = await ensureDeviceLogin(endpoint, workspaceId);
    if (current.status !== "ready") throw new MemberRefusal(current.message);
    // A missing-workspace renewal counts toward the command's single retry.
    let renewed = before.status === "ready" && before.login.credential.record.id !== current.login.credential.record.id;
    let login = current.login;
    const request = async (action: ManagementAction, affected?: Member): Promise<Record<string, unknown>> => {
      let reply = await manageRequest(origin, action, login);
      if (reply.status === 401 && reply.body.status === "sign-in-required" && !renewed) {
        renewed = true;
        current = await ensureDeviceLogin(endpoint, workspaceId, { rejected: login });
        if (current.status !== "ready") throw new MemberRefusal(current.message);
        login = current.login;
        reply = await manageRequest(origin, action, login);
      }
      if (reply.status === 200 && ["ok", "already-member"].includes(String(reply.body.status))) return reply.body;
      const reasons: Record<string, [number, string]> = {
        "sign-in-required": [401, `sign-in is required; run \`ub auth login ${origin}\``],
        forbidden: [403, "forbidden: a current workspace admin is required"],
        "protocol-mismatch": [409, "protocol-mismatch: hub and client sync versions differ; update them together"],
        "not-configured": [503, "not-configured: this hub does not support authenticated member management; configure GitHub sign-in and update the hub"],
        "account-not-found": [404, "no such GitHub user (unknown or non-user account); nothing was granted"],
        "lookup-unavailable": [503, "GitHub lookup unavailable, retry later; nothing was granted"],
        "member-not-found": [404, "the member no longer belongs to this workspace; refresh the member list"],
        "last-admin": [409, "last-admin: the last workspace admin cannot be removed or demoted; add another admin first"],
        failed: [500, "failed: the hub could not complete member management; retry later"],
      };
      if (reply.status === 500 && reply.body.status === "closure-failed" && reply.body.applied === true) {
        throw new MemberRefusal(`closure-failed: the change${affected === undefined ? "" : ` for ${describe(affected)}`} was committed, but the hub could not close every active connection; repair the hub before relying on access closure. Removal ends this account's access to this workspace on every device, revokes no devices and leaves other workspaces alone.`);
      }
      const refusal = reasons[String(reply.body.status)];
      throw new MemberRefusal(refusal?.[0] === reply.status ? refusal[1] : "hub returned an invalid member-management response; update the hub and retry");
    };
    const members = async (): Promise<Member[]> => {
      const body = await request({ operation: "list-members", workspaceId });
      if (body.status !== "ok" || !Array.isArray(body.members)) throw new MemberRefusal("hub returned an invalid member list; update the hub and retry");
      return body.members.map(member);
    };
    if (command === "list") {
      const rows = (await members()).map(({ githubUsername, githubAccountId, role }) => ({ githubUsername, githubAccountId, role }));
      if (json) io.out(`${JSON.stringify({ hub: origin, workspaceId, members: rows })}\n`);
      else {
        io.out(`hub ${origin}\nworkspace ${workspaceId}\n`);
        for (const row of rows) io.out(`${describe(row)} | ${row.role}\n`);
        if (rows.length === 0) io.out("no members\n");
      }
      return 0;
    }
    if (command === "add") {
      const resolved = await request({ operation: "resolve-account", workspaceId, githubUsername: positionals[0] ?? "" });
      if (resolved.status !== "ok" || !isGithubUsername(resolved.githubUsername) || !isGithubAccountId(resolved.githubAccountId)) {
        throw new MemberRefusal("hub returned an invalid GitHub account resolution; nothing was granted");
      }
      const account = { githubUsername: resolved.githubUsername, githubAccountId: resolved.githubAccountId };
      const existing = (await members()).find(row => row.githubAccountId === account.githubAccountId);
      if (existing !== undefined) { already(existing, io); return 0; }
      if (!process.stdin.isTTY) throw new MemberRefusal("granting access requires explicit confirmation at a terminal; non-terminal stdin grants nothing");
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      let answer: string;
      try {
        answer = await terminal.question(`Grant access on ${origin} to workspace ${workspaceId} for ${describe(account)} as ${role}? [y/N] `);
      } catch { throw new MemberRefusal("confirmation ended; nothing was granted"); }
      finally { terminal.close(); }
      if (!/^(y|yes)$/i.test(answer.trim())) { io.out("cancelled; nothing was granted\n"); return 0; }
      const result = await request({ operation: "grant-member", workspaceId, githubAccountId: account.githubAccountId, role });
      const added = member(result.member);
      if (added.githubAccountId !== account.githubAccountId) throw new MemberRefusal("hub returned a different account after the grant; check the member list");
      if (result.status === "already-member") already(added, io);
      else io.out(`added ${describe(added)} as ${added.role}\nAccess is discovered on sign-in or credential renewal; select the workspace explicitly with \`ub workspace use ${origin}/${workspaceId}\`.\n`);
      return 0;
    }
    const target = positionals[0] ?? "";
    const matches = (await members()).filter(row => row.githubAccountId === target || row.githubUsername.toLowerCase() === target.toLowerCase());
    if (matches.length === 0) throw new MemberRefusal("no matching member; use the current GitHub login or account ID from `ub workspace member list`");
    if (matches.length !== 1) throw new MemberRefusal("ambiguous member; more than one current member matches; use an unambiguous account ID from `ub workspace member list`");
    const selected = matches[0] as Member;
    const result = await request(command === "role"
      ? { operation: "change-role", workspaceId, principalId: selected.principalId, role }
      : { operation: "remove-member", workspaceId, principalId: selected.principalId }, selected);
    if (result.status !== "ok") throw new MemberRefusal("hub returned an invalid change response; check the member list");
    if (command === "role") io.out(`changed ${describe(selected)} to ${role}\n`);
    else io.out(`removed ${describe(selected)}\nThis ends that account's access to this workspace on every device. It revokes no devices and leaves other workspaces alone.\n`);
    return 0;
  } catch (error) {
    // Network/provider exceptions can contain private proofs or keys. Only
    // known refusals and local configuration diagnostics may reach output.
    const message = error instanceof MemberRefusal ? error.message : error instanceof ManagementResponseError
      ? "hub returned an invalid member-management response; update the hub and retry"
      : "hub unreachable or request unavailable; retry later";
    io.err(`ub workspace member ${command}: ${message}\n`);
    return 1;
  }
}
