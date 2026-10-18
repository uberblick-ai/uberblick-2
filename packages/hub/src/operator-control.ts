/** Operator capabilities share the serving hub's database handle and private socket. */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { HubClaimState } from "./hub-claim.js";
import type { HubAdminRegistry } from "./hub-admins.js";
import type { HubLogger } from "./log.js";
import type { PrincipalRegistry } from "./principals.js";
import { backupDatabase, checkDatabaseIntegrity } from "./operator-database.js";
import type { HubExtensionContext } from "./server.js";
import type { TeamHubConfig } from "./team-config.js";

export type OperatorRequest =
  | { action: "hub-status" | "hub-doctor" | "backup" }
  | { action: "hub-admin-add"; account: string }
  | { action: "hub-admin-add"; accountId: string };

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
  principals: PrincipalRegistry, admins: HubAdminRegistry,
): OperatorControls {
  const { database } = context;
  return {
    async run(request, signal) {
      signal.throwIfAborted();
      if (request.action === "hub-admin-add") return appointHubAdmin(principals, admins, request, context.log);
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
