/**
 * Client configuration, injected by Vite `define` (see vite.config.ts).
 *
 * Rule from CLAUDE.md: no hardcoded hub addresses anywhere except the in-code
 * fallback default. There are exactly two, both fallbacks: the one vite.config.ts
 * substitutes when HUB_URL is unset in the build environment, and
 * FALLBACK_HUB_URL below, which applies when this module is loaded outside a
 * Vite build (tests) and nothing was injected. Under a normal dev server this
 * module only reads the injected value.
 *
 * ============================ LOUD WARNING ============================
 * HUB_AUTH_TOKEN is compiled into the bundle. That is PRIVATE-SPIKE-ONLY — a
 * browser bundle is public, so this is not a secret once served. REMOTE.md
 * limits the remote deployment to a private Tailscale network. The hosted
 * design mints a per-OAuth-session token server-side and the signing secret
 * never reaches the client.
 * =====================================================================
 */

import { DEFAULT_WORKSPACE } from "@uberblick/schema";

// Injected as string literals at build time. Declared, never imported.
declare const __HUB_URL__: string;
declare const __HUB_AUTH_TOKEN__: string;

/** Fallback used only when this module is loaded outside a Vite build (tests). */
const FALLBACK_HUB_URL = "ws://localhost:1234";

function injected(value: string | undefined, fallback: string): string {
  return value === undefined || value === "" ? fallback : value;
}

export const HUB_URL: string = injected(
  typeof __HUB_URL__ === "string" ? __HUB_URL__ : undefined,
  FALLBACK_HUB_URL,
);

/**
 * The hub's dev signing secret. Empty when `fnox exec` could not decrypt it
 * (`--if-missing warn`), which is a legitimate state: contributors without the
 * age key still get a running dev server, they just cannot authenticate.
 */
export const HUB_AUTH_TOKEN: string = injected(
  typeof __HUB_AUTH_TOKEN__ === "string" ? __HUB_AUTH_TOKEN__ : undefined,
  "",
);

/** The single workspace the spike runs in. Tenancy already lives in room keys. */
export const WORKSPACE: string = DEFAULT_WORKSPACE;
