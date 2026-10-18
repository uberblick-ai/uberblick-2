/** Operator capabilities share the serving hub's database handle and private socket. */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { HubClaimState } from "./hub-claim.js";
import { backupDatabase, checkDatabaseIntegrity } from "./operator-database.js";
import type { HubExtensionContext } from "./server.js";
import type { TeamHubConfig } from "./team-config.js";

export interface OperatorControls {
  run(action: "hub-status" | "hub-doctor" | "backup", signal: AbortSignal): Promise<unknown>;
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
): OperatorControls {
  const { database } = context;
  return {
    async run(action, signal) {
      if (action === "backup") {
        await context.flush();
        signal.throwIfAborted();
        const path = await backupDatabase(database.connection, database.databasePath, signal, () => {
          const failure = context.storeFailure();
          if (failure !== null) throw new Error(`a document store failed: ${failure}`);
        });
        return { status: "complete", path };
      }
      const claimCode = action === "hub-status" ? claims?.operatorClaimCode() : undefined;
      const info = {
        databasePath: resolve(database.databasePath), size: action === "hub-status"
          ? statSync(database.databasePath).size : databaseSize(database.databasePath),
        ...(action === "hub-status" ? {
          documentCount: Number(database.connection.prepare("SELECT count(*) AS count FROM documents").get()?.count),
          claimed: claims === undefined || !claims.state(config.github !== undefined).unclaimed,
          ...(claimCode === undefined ? {} : { claimCode }),
        } : {}),
        port: context.server().address.port, host: config.address,
        storeFailure: context.storeFailure(), githubClientId: config.github?.clientId ?? null,
        ...(action === "hub-doctor" ? { integrity: integrity(database) } : {}),
      };
      return { status: "ok", info };
    },
  };
}
