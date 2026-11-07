import { ToolError } from "./failures.js";

export function assertWriteScope(scope: readonly string[]): void {
  if (!scope.includes("docs:write")) {
    throw new ToolError("insufficient_scope", "The session no longer has docs:write permission. Nothing was written.");
  }
}
