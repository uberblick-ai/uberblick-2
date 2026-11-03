import { parseWorkspaceId } from "@uberblick/schema";
import { parseHubPublicUrl, protectedResourceMetadataUrl, workspaceResourceUrl } from "@uberblick/schema/oauth";
import { authenticationOrigin, hubTransportProblem } from "./remote-url.js";

/** Public metadata confirms hosted access without reading or sending a login. */
export async function discoverHostedMcp(
  hubUrl: string,
  workspaceId: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    if (hubTransportProblem(hubUrl, env) !== null) return null;
    const uuid = parseWorkspaceId(workspaceId).uuid;
    const response = await fetch(protectedResourceMetadataUrl(authenticationOrigin(hubUrl), uuid), {
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(Math.floor(timeoutMs)),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const metadata: unknown = await response.json();
    if (typeof metadata !== "object" || metadata === null || !("resource" in metadata) ||
      typeof metadata.resource !== "string") return null;
    const suffix = `/mcp/${uuid}`;
    if (!metadata.resource.endsWith(suffix)) return null;
    const issuer = parseHubPublicUrl(metadata.resource.slice(0, -suffix.length));
    if (issuer === undefined) return null;
    const resource = workspaceResourceUrl(issuer, uuid);
    return metadata.resource === resource ? resource : null;
  } catch {
    return null;
  }
}
