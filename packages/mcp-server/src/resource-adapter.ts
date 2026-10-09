/** The failure boundary shared by resource list and read callbacks. */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { PERSISTENCE_ERROR_MESSAGE } from "./failures.js";
import { log } from "./log.js";
import { PersistenceError } from "./replica.js";
import { ServerShuttingDownError } from "./server-work.js";

/** Only deliberate resource refusals may carry their message and data through. */
export class ClientSafeResourceError extends McpError {}

export const INTERNAL_RESOURCE_ERROR_MESSAGE =
  "The resource call failed for an unhandled reason; see this server's stderr log for the cause.";

export function guardedResource<Args extends unknown[], Result>(
  call: (...args: Args) => Result | Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await call(...args);
    } catch (error) {
      if (error instanceof ClientSafeResourceError || error instanceof ServerShuttingDownError) throw error;
      let message: string;
      if (error instanceof PersistenceError) {
        // The refused append already logged the original cause on stderr.
        message = PERSISTENCE_ERROR_MESSAGE;
      } else {
        log.error("resource call failed", error);
        message = INTERNAL_RESOURCE_ERROR_MESSAGE;
      }
      // The SDK forwards message/code/data verbatim. McpError adds a prefix to
      // its message, so use a plain error to send exactly the safe sentence.
      throw Object.assign(new Error(message), { code: ErrorCode.InternalError });
    }
  };
}
