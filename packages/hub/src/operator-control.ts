/** Operator capabilities share the serving hub's database handle and private socket. */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { HubClaimState } from "./hub-claim.js";
import type { HubAdminRegistry } from "./hub-admins.js";
import type { HubLogger } from "./log.js";
import type { MembershipRegistry } from "./memberships.js";
import type { PrincipalRecord, PrincipalRegistry } from "./principals.js";
import { backupDatabase, checkDatabaseIntegrity } from "./operator-database.js";
import type { HubExtensionContext } from "./server.js";
import type { TeamHubConfig } from "./team-config.js";

export type OperatorRequest =
  | { action: "hub-status" | "hub-doctor" | "backup" }
  | { action: "hub-admin-add"; account: string }
  | { action: "hub-admin-add"; accountId: string }
  | { action: "workspace-admin-add"; workspaceId: string; account: string }
  | { action: "workspace-admin-add"; workspaceId: string; accountId: string };

export interface OperatorControls {
  run(request: OperatorRequest, signal: AbortSignal): Promise<unknown>;
}

function appointHubAdmin(principals: PrincipalRegistry, admins: HubAdminRegistry,
  target: Extract<OperatorRequest, { action: "hub-admin-add" }>, log: HubLogger) {
  const matches = "accountId" in target
    ? [principals.getByGithubAccountId(target.accountId)].filter(principal => principal !== null)
    : principals.findByGithubUsername(target.account);
  if (matches.length > 1) return { status: "ambiguous-account" };
  const identity = matches[0];
  if (identity === undefined) return { status: "account-not-found" };
  if (admins.isAdmin(identity.id)) return { status: "already-admin", identity };
  if (!principals.hasSignedIn(identity.id)) return { status: "sign-in-required" };
  // The single INSERT commits before any logging or socket reply can fail.
  admins.grant(identity.id);
  try { log({ event: "hub.admin.appointed", ...identity }); } catch { /* appointment is already committed */ }
  return { status: "complete", identity };
}

function addWorkspaceAdmin(principals: PrincipalRegistry, admins: HubAdminRegistry, memberships: MembershipRegistry,
  target: Extract<OperatorRequest, { action: "workspace-admin-add" }>, log: HubLogger) {
  let outcome = "failed";
  let identity: PrincipalRecord | undefined;
  const result = (status: string) => {
    outcome = status;
    return { status, ...((status === "complete" || status === "already-admin") && identity !== undefined ? { identity } : {}) };
  };
  try {
    if (!admins.hasWorkspace(target.workspaceId)) return result("workspace-not-found");
    const matches = "accountId" in target
      ? [principals.getByGithubAccountId(target.accountId)].filter(principal => principal !== null)
      : principals.findByGithubUsername(target.account);
    if (matches.length > 1) return result("ambiguous-account");
    identity = matches[0];
    if (identity === undefined) return result("account-not-found");
    if (memberships.roleFor(target.workspaceId, identity.id) === "admin") return result("already-admin");
    if (!principals.hasSignedIn(identity.id)) return result("sign-in-required");
    // One statement commits the role and marker before logging or replying.
    memberships.grantAdminOnHost(target.workspaceId, identity.id);
    return result("complete");
  } finally {
    try {
      log({ event: "hub.workspace-admin.add", workspaceId: target.workspaceId,
        ...("accountId" in target ? { accountId: target.accountId } : { account: target.account }),
        ...(identity === undefined ? {} : { identity }), outcome, time: new Date().toISOString() });
    } catch { /* Logging cannot undo a committed membership or hide the result. */ }
  }
}

function integrity(database: HubExtensionContext["database"]): string[] {
  try { checkDatabaseIntegrity(database.connection); return ["ok"]; }
  catch (error) { return [String(error)]; }
}

function databaseSize(path: string): number {
  try { return statSync(path).size; }
  catch { return 0; }
}

export function createOperatorControls(
  context: HubExtensionContext, config: TeamHubConfig, claims: HubClaimState | undefined,
  principals: PrincipalRegistry, admins: HubAdminRegistry, memberships: MembershipRegistry,
): OperatorControls {
  const { database } = context;
  return {
    async run(request, signal) {
      signal.throwIfAborted();
      if (request.action === "hub-admin-add") return appointHubAdmin(principals, admins, request, context.log);
      if (request.action === "workspace-admin-add") return addWorkspaceAdmin(principals, admins, memberships, request, context.log);
      const { action } = request;
      if (action === "backup") {
        await context.flush();
        signal.throwIfAborted();
        const path = await backupDatabase(database.connection, database.databasePath, signal, () => {
          const failure = context.storeFailure();
          if (failure !== null) throw new Error(`a document store failed: ${failure}`);
        });
        return { status: "complete", path };
      }
      const info = {
        databasePath: resolve(database.databasePath), size: action === "hub-status"
          ? statSync(database.databasePath).size : databaseSize(database.databasePath),
        ...(action === "hub-status" ? {
          documentCount: Number(database.connection.prepare("SELECT count(*) AS count FROM documents").get()?.count),
          claimed: claims === undefined || !claims.state(config.github !== undefined).unclaimed,
        } : {}),
        port: context.server().address.port, host: config.address,
        storeFailure: context.storeFailure(), githubClientId: config.github?.clientId ?? null,
        ...(action === "hub-doctor" ? { integrity: integrity(database) } : {}),
      };
      return { status: "ok", info };
    },
  };
}
