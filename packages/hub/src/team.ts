/** Team capabilities are wired only by the standalone hub entry points. */
import { CredentialRegistry } from "./credentials.js";
import { CredentialAdmission } from "./credential-admission.js";
import { handleCredentialRenewal } from "./credential-renewal.js";
import { WorkspaceNameReader } from "./workspace-names.js";
import { WorkspacePromotions } from "./workspace-promotion.js";
import { handleAccessManagement } from "./access-management.js";
import { startAdminSetup } from "./admin-setup.js";
import { createOperatorControls } from "./operator-control.js";
import { GithubSignIn, handleGithubSignIn } from "./github-sign-in.js";
import { handleBrowserSignIn } from "./browser-sign-in.js";
import { GithubAccountLookup } from "./github-account-lookup.js";
import { HubClaimState, handleHubClaimState } from "./hub-claim.js";
import { HubAdminRegistry } from "./hub-admins.js";
import { MembershipRegistry } from "./memberships.js";
import { PrincipalRegistry } from "./principals.js";
import { isEphemeralDatabase } from "./persistence.js";
import { createHub, type Hub, type HubExtensionContext, type HubExtension } from "./server.js";
import { validateGithubClientId, type TeamHubConfig } from "./team-config.js";
import { resolveUpdateAuthor } from "./update-attribution.js";
import { handleAuthorizationServerMetadata } from "./oauth-discovery.js";
import { handleOAuthAuthorization, type OAuthClientLookup } from "./oauth-authorization.js";
import { OAuthAuthorizations } from "./oauth-authorizations.js";
import { handleOAuthToken } from "./oauth-token.js";
import { OAuthMetadataClients } from "./oauth-client-metadata.js";
import { AgentGrantRegistry } from "./agent-grants.js";
import { startMcpChannel } from "./mcp-channel.js";

export interface TeamHub extends Hub {
  /** Hub-internal authorities; never exposed through a public route. */
  readonly credentials?: CredentialRegistry;
  readonly memberships?: MembershipRegistry;
  readonly principals?: PrincipalRegistry;
  readonly hubAdmins?: HubAdminRegistry;
}

export interface TeamHubOptions {
  operatorSetup?: boolean;
  initializeDefaultWorkspace?: boolean;
  hubVersion?: string;
  /** Test seam that can only make loopback admission stricter. */
  deviceCredentials?: true;
  oauthClients?: OAuthClientLookup;
}

function createTeamExtension(
  config: TeamHubConfig, options: TeamHubOptions,
  context: HubExtensionContext,
): HubExtension & Pick<TeamHub, "credentials" | "memberships" | "principals" | "hubAdmins"> {
  const { database, server, deviceCredentials, protocolVersion, log } = context;
  let signIn: GithubSignIn | undefined;
  let accounts: GithubAccountLookup | undefined;
  let credentials: CredentialRegistry | undefined;
  let principals: PrincipalRegistry | undefined;
  let memberships: MembershipRegistry | undefined;
  let claims: HubClaimState | undefined;
  let admission: CredentialAdmission | undefined;
  let promotions: WorkspacePromotions | undefined;
  let hubAdmins: HubAdminRegistry | undefined;
  let authorizations: OAuthAuthorizations | undefined;
  const metadataClients = new OAuthMetadataClients();
  const oauthClients = options.oauthClients ?? metadataClients.lookup;
  const workspaceNames = new WorkspaceNameReader(database, room => server().hocuspocus.documents.get(room));
  const hasLiveDocuments = (workspaceId: string) =>
    [...server().hocuspocus.documents.keys()].some(name => name.startsWith(`${workspaceId}/`));

  if (options.initializeDefaultWorkspace) claims = new HubClaimState(database);
  if (config.github !== undefined || options.operatorSetup) {
    principals = new PrincipalRegistry(database, config.github?.now);
    memberships = new MembershipRegistry(database);
    hubAdmins = new HubAdminRegistry(database, workspaceNames);
    if (config.github !== undefined) {
      credentials = new CredentialRegistry(database, hubAdmins, log, undefined, workspaceNames);
      promotions = new WorkspacePromotions(database, memberships, hasLiveDocuments, hubAdmins);
      signIn = new GithubSignIn(config.github, database, principals, credentials, memberships, log, claims, workspaceNames);
      accounts = new GithubAccountLookup(config.github.fetch, config.github.now);
      if (config.publicUrl !== undefined) authorizations = new OAuthAuthorizations(database, memberships, workspaceNames, credentials, config.github.now);
    }
  }
  if (deviceCredentials && credentials !== undefined && memberships !== undefined) {
    admission = new CredentialAdmission(credentials, memberships, { protocolVersion, log }, hubAdmins);
  }

  let adminSetup: Awaited<ReturnType<typeof startAdminSetup>> | undefined;
  let mcpChannel: Awaited<ReturnType<typeof startMcpChannel>> | undefined;
  return {
    ...(credentials === undefined ? {} : { credentials }),
    ...(memberships === undefined ? {} : { memberships }),
    ...(principals === undefined ? {} : { principals }),
    ...(hubAdmins === undefined ? {} : { hubAdmins }),
    extensions: admission === undefined ? [] : [admission],
    admissionConfigured: admission !== undefined,
    signInConfigured: signIn !== undefined,
    assertCurrent(connection, room) { admission?.assertCurrent(connection, room); },
    resolveAuthor(credentialContext, origin) {
      return credentials === undefined ? null : resolveUpdateAuthor(credentialContext, credentials, origin);
    },
    revisionUsername(principalId) { return principals?.get(principalId)?.githubUsername ?? null; },
    async handleRequest(request, response) {
      if (handleAuthorizationServerMetadata(config.publicUrl, signIn !== undefined, request, response)) return true;
      if (await handleOAuthAuthorization(config.publicUrl, signIn, authorizations, hubAdmins,
        oauthClients, request, response)) return true;
      if (await handleOAuthToken(config.publicUrl, signIn !== undefined, authorizations, request, response)) return true;
      if (handleHubClaimState(claims, signIn !== undefined, request, response)) return true;
      if (await handleCredentialRenewal(credentials, memberships, protocolVersion, log, request, response, workspaceNames)) return true;
      if (await handleAccessManagement(credentials, memberships, principals, protocolVersion, log, request, response, promotions, accounts, hubAdmins, options.hubVersion)) return true;
      if (await handleBrowserSignIn(signIn, request, response, config.behindReleaseProxy)) return true;
      return handleGithubSignIn(signIn, request, response, config.behindReleaseProxy);
    },
    async start() {
      if (config.mcpSocketPath !== undefined && (authorizations === undefined || credentials === undefined || hubAdmins === undefined)) {
        throw new Error("HUB_MCP_SOCKET requires GitHub sign-in and HUB_PUBLIC_URL");
      }
      if (options.operatorSetup) {
        if (principals === undefined || memberships === undefined || hubAdmins === undefined || isEphemeralDatabase(config.databasePath ?? "")) {
          throw new Error("hub setup: durable hub database required");
        }
        adminSetup = await startAdminSetup({ database, principals, memberships, claims,
          github: config.github, log, hasLiveDocuments,
          operator: createOperatorControls(context, config, claims, principals, hubAdmins) });
      }
      if (config.mcpSocketPath !== undefined && authorizations !== undefined && credentials !== undefined && hubAdmins !== undefined) {
        mcpChannel = await startMcpChannel({ path: config.mcpSocketPath, authorizations, credentials, admins: hubAdmins,
          grants: new AgentGrantRegistry(database) });
      }
    },
    async stop() {
      // Fence asynchronous identity reads before the core tears down storage.
      signIn?.stop();
      accounts?.stop();
      authorizations?.stop();
      metadataClients.stop();
      await mcpChannel?.stop();
      await adminSetup?.stop();
    },
  };
}

/** Same core lifecycle, with the registries and handlers of a team hub. */
export async function createTeamHub(config: TeamHubConfig, options: TeamHubOptions = {}): Promise<TeamHub> {
  if (config.github !== undefined) validateGithubClientId(config.github.clientId);
  let team: ReturnType<typeof createTeamExtension> | undefined;
  const hub = await createHub(config, {
    ...(options.hubVersion === undefined ? {} : { hubVersion: options.hubVersion }),
    ...(options.deviceCredentials === undefined ? {} : { deviceCredentials: options.deviceCredentials }),
    extension(context) {
      team = createTeamExtension(config, options, context);
      return team;
    },
  });
  return {
    ...hub,
    ...(team?.credentials === undefined ? {} : { credentials: team.credentials }),
    ...(team?.memberships === undefined ? {} : { memberships: team.memberships }),
    ...(team?.principals === undefined ? {} : { principals: team.principals }),
    ...(team?.hubAdmins === undefined ? {} : { hubAdmins: team.hubAdmins }),
  };
}
