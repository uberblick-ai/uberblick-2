import { expect, it } from "vitest";
import { BROWSER_SESSION_LIFETIME_MS, BrowserSessions } from "../src/browser-sessions.js";
import { HubDatabase } from "../src/persistence.js";
import { PrincipalRegistry } from "../src/principals.js";

it("returns the principal internally without disclosing it in session issuance", () => {
  const database = new HubDatabase(":memory:", error => { throw error; });
  database.open();
  try {
    let now = 1000;
    const principal = new PrincipalRegistry(database).identify("1234", "browser-person");
    const sessions = new BrowserSessions(database, () => now);
    const origin = "https://hub.example";
    const issued = sessions.issue(principal.id, principal.githubUsername, origin);
    expect(issued).toEqual({ token: expect.any(String), username: "browser-person", expiresAt: now + BROWSER_SESSION_LIFETIME_MS });
    expect(sessions.get(issued.token, origin)).toEqual({ principalId: principal.id,
      username: "browser-person", expiresAt: issued.expiresAt });
    expect(sessions.get(issued.token, "https://other.example")).toBeNull();
    now = issued.expiresAt;
    expect(sessions.get(issued.token, origin)).toBeNull();
  } finally {
    database.close();
  }
});
