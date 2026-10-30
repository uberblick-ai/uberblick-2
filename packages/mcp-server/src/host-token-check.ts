/** A fresh hub answer for one presented access token; never a credential. */
export interface McpHostGrant {
  grantId: string;
  principal: string;
  workspace: string;
  scope: string;
  /** Unix epoch milliseconds, as returned by the hub's access-token store. */
  expiresAt: number;
}

export type McpHostTokenResult =
  | ({ status: "positive" } & McpHostGrant)
  | { status: "negative" }
  | { status: "unavailable" };

export type McpHostTokenCheck = (token: string) => Promise<McpHostTokenResult>;

/** Fail closed until the hub introspection channel is installed. */
export const unavailableTokenCheck: McpHostTokenCheck = async () => ({ status: "unavailable" });
