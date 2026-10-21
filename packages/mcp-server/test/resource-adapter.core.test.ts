import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { log } from "../src/log.js";
import { PersistenceError } from "../src/replica.js";
import { guardedResource, INTERNAL_RESOURCE_ERROR_MESSAGE } from "../src/resource-adapter.js";
import { WorkspaceRemovedError } from "../src/store.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  new WorkspaceRemovedError(),
  new PersistenceError("removed-room", new WorkspaceRemovedError()),
])("returns the removal refusal without logging an unhandled failure: %s", async (cause) => {
  const reported = vi.spyOn(log, "error").mockImplementation(() => {});
  const handler = guardedResource(() => { throw cause; });

  await expect(handler()).rejects.toMatchObject({
    code: ErrorCode.InternalError,
    message: new WorkspaceRemovedError().message,
  });
  expect(reported).not.toHaveBeenCalled();
});

it("contains asynchronous resource rejections, including arbitrary protocol error messages and data", async () => {
  const cause = new McpError(-32042, "Private SQL failure at /private/workspace.sqlite", {
    sql: "SELECT secret FROM records",
  });
  const reported = vi.spyOn(log, "error").mockImplementation(() => {});
  const handler = guardedResource(async () => {
    await Promise.resolve();
    throw cause;
  });
  const refused = await handler().catch((error: unknown) => error);

  expect(refused).toBeInstanceOf(Error);
  expect(refused).toMatchObject({
    code: ErrorCode.InternalError,
    message: INTERNAL_RESOURCE_ERROR_MESSAGE,
  });
  expect(refused).not.toHaveProperty("data");
  expect(reported).toHaveBeenCalledExactlyOnceWith("resource call failed", cause);
});
