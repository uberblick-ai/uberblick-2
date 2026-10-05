import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubAccountLookup } from "../src/github-account-lookup.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("public GitHub lookup lifecycle", () => {
  it.each(["timeout", "stop"] as const)("aborts a stalled body on %s after receiving successful headers", async reason => {
    const timeout = new AbortController();
    const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"id":5678,"login":"new-account",');
      // Deliberately leave the successful body incomplete until aborted.
    });
    await new Promise<void>(resolve => { upstream.listen(0, "127.0.0.1", resolve); });
    const address = upstream.address();
    if (address === null || typeof address === "string") throw new Error("no upstream port");
    let received: () => void = () => {};
    const headers = new Promise<void>(resolve => { received = resolve; });
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://api.github.com/user/5678");
      const response = await fetch(`http://127.0.0.1:${address.port}`, init);
      received();
      return response;
    });
    const lookup = new GithubAccountLookup(transport);
    let pending: Promise<unknown> | undefined;
    try {
      pending = lookup.lookup({ githubAccountId: "5678" });
      await headers;
      expect(deadline).toHaveBeenCalledWith(10_000);
      if (reason === "timeout") timeout.abort(new DOMException("provider-private", "TimeoutError"));
      else lookup.stop();
      expect(await pending).toEqual({ status: "lookup-unavailable" });
      lookup.stop();
      expect(await lookup.lookup({ githubAccountId: "5678" })).toEqual({ status: "lookup-unavailable" });
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      lookup.stop();
      await pending;
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        upstream.close(error => { if (error) reject(error); else resolve(); });
      });
    }
  });
});
