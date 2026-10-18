/** Public sign-in can claim a fresh deployed hub once, then issues device credentials or browser sessions. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CredentialRecord, CredentialRegistry } from "./credentials.js";
import { GithubDeviceFlow, type DeviceFlowCollection, type GithubSignInConfig } from "./github-device-flow.js";
import { type HubLogger, stderrLogger } from "./log.js";
import type { MembershipRegistry } from "./memberships.js";
import type { PrincipalRecord, PrincipalRegistry } from "./principals.js";
import type { HubClaimState } from "./hub-claim.js";
import type { HubDatabase } from "./persistence.js";
import { addWorkspaceNames, WorkspaceNameReader } from "./workspace-names.js";
import { sanitizeDeviceName } from "@uberblick/schema/device-name";
import { BrowserSessions, type BrowserSession } from "./browser-sessions.js";
import { requestClient } from "./client-address.js";

export type { GithubSignInConfig } from "./github-device-flow.js";
interface SignInResult {
  identity: PrincipalRecord;
  credential: { record: CredentialRecord; key: string; workspaceNames?: Record<string, string> };
  claimedWorkspaceId?: string;
}
export type SignInCollection = DeviceFlowCollection<SignInResult>;
interface BrowserSignInResult {
  session: BrowserSession & { token: string };
  claimedWorkspaceId?: string;
}
export type BrowserSignInCollection = DeviceFlowCollection<BrowserSignInResult>;

export class GithubSignIn extends GithubDeviceFlow<SignInResult | BrowserSignInResult, string> {
  private readonly browser: GithubDeviceFlow<SignInResult | BrowserSignInResult, string>;
  constructor(config: GithubSignInConfig, database: HubDatabase, principals: PrincipalRegistry,
    credentials: CredentialRegistry, memberships: MembershipRegistry, log: HubLogger = stderrLogger,
    claims?: HubClaimState, private readonly workspaceNames = new WorkspaceNameReader(database),
    private readonly sessions = new BrowserSessions(database, config.now)) {
    const complete = ({ accountId, username }: { accountId: string; username: string }, deviceName?: string, browserOrigin?: string) => {
      // Completion is synchronous and shares host setup's connection. Starting
      // or polling a flow reserves nothing; only this commit can win the claim.
      const db = database.connection;
      db.exec("BEGIN IMMEDIATE");
      try {
        const identity = principals.identify(accountId, username);
        const claimedWorkspaceId = claims?.claim(identity.id, memberships);
        if (browserOrigin !== undefined) {
          const session = sessions.issue(identity.id, identity.githubUsername, browserOrigin);
          db.exec("COMMIT");
          return { session, ...(claimedWorkspaceId === undefined ? {} : { claimedWorkspaceId }) };
        }
        const issued = credentials.issue({ principalId: identity.id, deviceId: crypto.randomUUID(),
          ...(deviceName === undefined ? {} : { deviceName }),
          workspaces: memberships.workspacesFor(identity.id) });
        const result = { identity,
          credential: { record: issued.record, key: Buffer.from(issued.keyBytes).toString("base64url") },
          ...(claimedWorkspaceId === undefined ? {} : { claimedWorkspaceId }) };
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
    super(config, complete, log);
    this.browser = new GithubDeviceFlow(config, complete, log);
  }

  override stop(): void {
    super.stop();
    this.browser.stop();
  }

  override async collect(requestId: string, secret: string): Promise<SignInCollection> {
    const result = await super.collect(requestId, secret);
    if (result.status !== "complete") return result;
    return "credential" in result ? addWorkspaceNames(result, this.workspaceNames, secret) : { status: "unknown-request" };
  }

  startBrowser(origin: string, client?: string) {
    return this.browser.start(undefined, origin, client);
  }

  async collectBrowser(requestId: string, secret: string, origin: string): Promise<BrowserSignInCollection> {
    const result = await this.browser.collect(requestId, secret, origin);
    if (result.status !== "complete") return result;
    return "session" in result ? result : { status: "unknown-request" };
  }

  cancelBrowser(requestId: string, secret: string, origin: string) {
    return this.browser.cancel(requestId, secret, origin);
  }

  browserSession(token: string, origin: string): BrowserSession | null {
    return this.sessions.get(token, origin);
  }

  signOutBrowser(token: string, origin: string): void {
    this.sessions.revoke(token, origin);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}

/** HTTP bodies carry secrets; URLs, logs and browser configuration never do. */
export async function handleGithubSignIn(
  signIn: GithubSignIn | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  behindReleaseProxy = false,
): Promise<boolean> {
  const path = request.url ?? "";
  if (!path.startsWith("/auth/")) return false;
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  };
  if (!["/auth/github/start", "/auth/github/collect", "/auth/github/cancel"].includes(path)) {
    reply(404, { status: "unknown-request" });
    return true;
  }
  if (signIn === undefined) {
    reply(503, { status: "not-configured" });
    return true;
  }
  if (request.method !== "POST" || request.headers.authorization !== undefined ||
      request.headers["content-type"]?.split(";")[0] !== "application/json") {
    reply(400, { status: "invalid-request" });
    return true;
  }
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > 4096) throw new Error();
      chunks.push(bytes);
    }
    const body = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (path === "/auth/github/start") {
      if (Object.keys(body).some((key) => key !== "deviceName")) throw new Error();
      const result = await signIn.start(sanitizeDeviceName(body.deviceName), undefined, requestClient(request, behindReleaseProxy));
      reply(result.status === "failed" ? 502 : result.status === "busy" ? 429 : 200, result);
    } else {
      if (Object.keys(body).length !== 2 || typeof body.requestId !== "string" ||
          typeof body.collectionSecret !== "string") throw new Error();
      const result = path.endsWith("/cancel")
        ? signIn.cancel(body.requestId, body.collectionSecret)
        : await signIn.collect(body.requestId, body.collectionSecret);
      reply(result.status === "unknown-request" ? 404 : 200, result);
    }
  } catch {
    reply(400, { status: "invalid-request" });
  }
  return true;
}
