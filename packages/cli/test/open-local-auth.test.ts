/** The embedded hub retains local admission and the no-sign-in HTTP contract. */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { pointAt } from "./helpers.js";
import { cleanUp, configured, freePort, hubAnswers, open } from "./open-fixtures.js";

afterEach(cleanUp);

it.each(["Iv23liLW6D5SqP77El3z", "invalid-client-id"])(
  "keeps ub open's local hub free of sign-in with HUB_GITHUB_CLIENT_ID=%s",
  async clientId => {
    const { box, env } = configured();
    const hubPort = await freePort();
    const hubUrl = `ws://127.0.0.1:${hubPort}`;
    pointAt(box, hubUrl);
    const app = await open(box, ["--port", String(await freePort())], {
      ...env, HUB_GITHUB_CLIENT_ID: clientId,
    });
    try {
      expect(app.stdout()).not.toContain("hub        ");
      expect(await hubAnswers(box, hubUrl)).toBe(true);
      const cases = [
        { path: "/auth/claim-state", method: "GET", code: 200, body: { unclaimed: false, canClaim: false } },
        { path: "/auth/claim-state", method: "POST", code: 405, body: { status: "invalid-request" } },
        ...["/auth/credential/renew", "/auth/manage", "/auth/github/start", "/auth/github/collect", "/auth/github/cancel"]
          .flatMap(path => ["GET", "POST"].map(method => ({ path, method, code: 503, body: { status: "not-configured" } }))),
        { path: "/auth/unknown", method: "POST", code: 404, body: { status: "unknown-request" } },
        { path: "/auth/github/start?extra=1", method: "POST", code: 404, body: { status: "unknown-request" } },
      ];
      for (const { path, method, code, body } of cases) {
        const response = await fetch(`http://127.0.0.1:${hubPort}${path}`, {
          method, signal: AbortSignal.timeout(5_000),
          headers: { authorization: "ignored-without-sign-in", "content-type": "text/plain" },
          ...(method === "POST" ? { body: "not JSON" } : {}),
        });
        expect(response.status, `${method} ${path}`).toBe(code);
        expect(response.headers.get("content-type")).toBe("application/json");
        expect(response.headers.get("cache-control")).toBe("no-store");
        if (code === 405) expect(response.headers.get("allow")).toBe("GET");
        expect(await response.json()).toEqual(body);
      }
      const database = new DatabaseSync(join(box.cwd, "started-hub.sqlite"), { readOnly: true });
      try {
        expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'hub_%'").all()).toEqual([]);
      } finally { database.close(); }
    } finally { expect((await app.interrupt()).status).toBe(0); }
  },
);
