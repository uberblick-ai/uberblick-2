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
import { isCredentialPublicKey } from "@uberblick/schema/token";
import { GITHUB_SIGN_IN_ROUTES, isJsonPost, readJsonRequest, replyJson } from "./http.js";

export type { GithubSignInConfig } from "./github-device-flow.js";
interface SignInResult {
  identity: PrincipalRecord & { name?: string };
  credential: { record: CredentialRecord; workspaceNames?: Record<string, string> };
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
    const complete = ({ accountId, username, name }: { accountId: string; username: string; name?: string }, deviceName?: string,
      context?: string, browser = false) => {
      // Completion is synchronous and shares host setup's connection. Starting
      // or polling a flow reserves nothing; only this commit can win the claim.
      const db = database.connection;
      db.exec("BEGIN IMMEDIATE");
      try {
        const identity = principals.identify(accountId, username);
        const claimedWorkspaceId = claims?.claim(identity.id, memberships);
        principals.recordSignIn(identity.id);
        if (browser) {
          if (context === undefined) throw new Error();
          const session = sessions.issue(identity.id, identity.githubUsername, context);
          db.exec("COMMIT");
          return { session, ...(claimedWorkspaceId === undefined ? {} : { claimedWorkspaceId }) };
        }
        const issued = credentials.issue({ principalId: identity.id, deviceId: crypto.randomUUID(),
          ...(deviceName === undefined ? {} : { deviceName }),
          publicKey: Buffer.from(context ?? "", "base64url"),
          workspaces: memberships.workspacesFor(identity.id) });
        const result = { identity: { ...identity, ...(name === undefined ? {} : { name }) },
          credential: { record: issued.record },
          ...(claimedWorkspaceId === undefined ? {} : { claimedWorkspaceId }) };
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
    super(config, complete, log);
    this.browser = new GithubDeviceFlow(config, (identity, deviceName, origin) => complete(identity, deviceName, origin, true), log);
  }

  override stop(): void {
    super.stop();
    this.browser.stop();
  }

  override async collect(requestId: string, secret: string, publicKey?: string): Promise<SignInCollection> {
    const result = await super.collect(requestId, secret, publicKey);
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

/** HTTP bodies carry secrets; URLs, logs and browser configuration never do. */
export async function handleGithubSignIn(
  signIn: GithubSignIn | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  behindReleaseProxy = false,
): Promise<boolean> {
  const path = request.url ?? "";
  if (!path.startsWith("/auth/")) return false;
  const reply = (status: number, body: unknown) => replyJson(response, status, body);
  if (!GITHUB_SIGN_IN_ROUTES.includes(path)) {
    reply(404, { status: "unknown-request" });
    return true;
  }
  if (signIn === undefined) {
    reply(503, { status: "not-configured" });
    return true;
  }
  if (!isJsonPost(request)) {
    reply(400, { status: "invalid-request" });
    return true;
  }
  try {
    const { body } = await readJsonRequest(request);
    if (path === "/auth/github/start") {
      if (Object.keys(body).some((key) => !["deviceName", "publicKey"].includes(key)) ||
        !isCredentialPublicKey(body.publicKey)) throw new Error();
      const result = await signIn.start(sanitizeDeviceName(body.deviceName), body.publicKey, requestClient(request, behindReleaseProxy));
      reply(result.status === "failed" ? 502 : result.status === "busy" ? 429 : 200, result);
    } else {
      if (Object.keys(body).length !== 3 || typeof body.requestId !== "string" ||
          typeof body.collectionSecret !== "string" || !isCredentialPublicKey(body.publicKey)) throw new Error();
      const result = path.endsWith("/cancel")
        ? signIn.cancel(body.requestId, body.collectionSecret, body.publicKey)
        : await signIn.collect(body.requestId, body.collectionSecret, body.publicKey);
      reply(result.status === "unknown-request" ? 404 : 200, result);
    }
  } catch {
    reply(400, { status: "invalid-request" });
  }
  return true;
}
