import { strictInput } from "../inputs.js";
import { collectSyncStatus } from "../status.js";
import { operation } from "./operation.js";

export const inputSchema = strictInput({});

export const syncStatusOperation = operation("sync_status", inputSchema, async (context, _args, _request) => await collectSyncStatus(context.replicas) );
