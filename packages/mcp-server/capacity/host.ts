import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "./fixture.js";
import { writeHubLogin } from "../src/auth-store.js";
import { createMcpHost } from "../src/http-host.js";

async function main(): Promise<void> {
  const [directory, hubUrl, runtimeCap, rawPort = "0"] = process.argv.slice(2);
  if (directory === undefined || hubUrl === undefined) throw new Error("Usage: host.ts DIRECTORY HUB_URL [RUNTIME_CAP] [PORT]");
  const port = Number(rawPort);
  const cap = runtimeCap === undefined ? undefined : Number(runtimeCap);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (cap !== undefined && (!Number.isInteger(cap) || cap < 1))) {
    throw new Error("Invalid host port or runtime cap");
  }
  const fixture = JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8")) as Fixture;
  process.env.XDG_CONFIG_HOME = join(directory, "config");
  process.env.XDG_DATA_HOME = join(directory, "data");
  const first = fixture.grants[0];
  if (first === undefined) throw new Error("Fixture has no grant");
  await writeHubLogin(new URL(hubUrl.replace(/^ws/, "http")).origin, first.login);
  const byToken = new Map(fixture.grants.map(item => [item.token, item]));
  const byGrant = new Map(fixture.grants.map(item => [item.grant.grantId, item]));
  const host = createMcpHost({
    issuer: undefined, allowedOrigins: [], hubUrl, databaseDirectory: join(directory, "mirrors"),
    ...(cap === undefined ? {} : { limits: { maxRuntimes: cap } }),
  }, {
    // known limit: fixture admission omits OAuth introspection and hosted grant-key issuance; revisit when measuring production admission costs.
    async checkToken(token) {
      const item = byToken.get(token);
      return item === undefined ? { status: "negative" } : { status: "positive", ...item.grant };
    },
    async credentialsForGrant(grant) {
      const item = byGrant.get(grant.grantId);
      if (item === undefined) throw new Error("Unrecognized fixture grant");
      const result = { status: "ready" as const, origin: new URL(hubUrl.replace(/^ws/, "http")).origin, login: item.login };
      return { agentName: "Capacity measurement", credentialProvider: { read: () => result, ensure: async () => result } };
    },
  });
  let closing: Promise<void> | undefined;
  const stop = (code: number): void => {
    if (closing !== undefined) return;
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    closing = host.close().then(() => process.exit(code), () => process.exit(1));
  };
  process.on("SIGTERM", () => stop(0));
  process.on("SIGINT", () => stop(0));
  const deadline = setTimeout(() => stop(1), 30 * 60_000);
  deadline.unref();
  await host.ready;
  host.server.listen(port, "127.0.0.1");
  await once(host.server, "listening");
  const address = host.server.address();
  if (address === null || typeof address === "string") throw new Error("No capacity host TCP listener");
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
}

main().catch(() => {
  process.stderr.write("Capacity host startup failed\n");
  process.exit(1);
});
