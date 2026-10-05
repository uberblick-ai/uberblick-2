/** Transport bounds remain shared by promotion and member management. */
import { afterEach, expect, it, vi } from "vitest";
import { ManagementResponseError, manageRequest } from "../src/access-management.js";
import { WORKSPACE, cleanUp, fixture, serve } from "./auth-fixtures.js";

afterEach(cleanUp);
const action = { operation: "list-members", workspaceId: WORKSPACE } as const;

it("refuses oversized or malformed management replies", async () => {
  const remote = await serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok", padding: "x".repeat(200) }));
  });
  await expect(manageRequest(remote.origin, action, fixture(), { maxResponseBytes: 128 }))
    .rejects.toBeInstanceOf(ManagementResponseError);
  const malformed = await serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("[]");
  });
  await expect(manageRequest(malformed.origin, action, fixture()))
    .rejects.toBeInstanceOf(ManagementResponseError);
});

it("aborts a held body as well as the initial request", async () => {
  const abort = new AbortController();
  const remote = await serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"status":');
  });
  const fetchResponse = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    const response = await fetchResponse(input, options);
    // Headers have completed, but the server leaves the JSON body unfinished.
    abort.abort();
    return response;
  });
  try {
    await expect(manageRequest(remote.origin, action, fixture(), { signal: abort.signal })).rejects.toThrow();
  } finally { spy.mockRestore(); }
});

it("never forwards a management proof to a redirect target", async () => {
  let redirected = false;
  const target = await serve((_request, response) => {
    redirected = true;
    response.end('{}');
  });
  const remote = await serve((_request, response) => {
    response.writeHead(307, { Location: `${target.origin}/auth/manage` });
    response.end();
  });
  await expect(manageRequest(remote.origin, action, fixture())).rejects.toThrow();
  expect(redirected).toBe(false);
});
