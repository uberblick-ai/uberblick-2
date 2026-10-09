import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { log } from "../src/log.js";
import { guardedResource, INTERNAL_RESOURCE_ERROR_MESSAGE } from "../src/resource-adapter.js";

afterEach(() => vi.restoreAllMocks());

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
