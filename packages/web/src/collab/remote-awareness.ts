/** Shared decoding only; each awareness reader owns its inclusion rule. */

import type { Awareness } from "y-protocols/awareness";
import { AGENT_CLIENT, AWARENESS_FALLBACK_COLOR } from "./identity.js";
import type { AwarenessUser } from "./identity.js";

export interface RemoteAwareness extends AwarenessUser {
  clientId: number;
  hasUser: boolean;
  kind: "agent" | "human";
  session: string | null;
  anchor: unknown;
}

/** The local state is never a remote peer, whatever fields it publishes. */
export function parseRemoteAwareness(
  awareness: Awareness,
  clientId: number,
  state: unknown,
): RemoteAwareness | null {
  if (clientId === awareness.clientID) return null;
  const fields = state as {
    user?: Partial<AwarenessUser>;
    client?: unknown;
    session?: unknown;
    cursor?: { anchor?: unknown } | null;
  };
  return {
    clientId,
    hasUser: fields.user !== undefined,
    name: typeof fields.user?.name === "string"
      ? fields.user.name
      : `client ${clientId}`,
    color: typeof fields.user?.color === "string"
      ? fields.user.color
      : AWARENESS_FALLBACK_COLOR,
    kind: fields.client === AGENT_CLIENT ? "agent" : "human",
    session: typeof fields.session === "string" ? fields.session : null,
    anchor: fields.cursor?.anchor,
  };
}
