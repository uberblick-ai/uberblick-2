import { strictInput } from "../inputs.js";
import { collectSyncStatus } from "../status.js";
import { UNSETTLED_READ, operation } from "./operation.js";

export const inputSchema = strictInput({});

export const syncStatusOperation = operation(UNSETTLED_READ, inputSchema, async (context, _args, _request) => await collectSyncStatus(context.replicas) );
