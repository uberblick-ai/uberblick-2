import { isLoopbackHost } from "@uberblick/mcp-server/remote-url";
import { budget } from "./budget.js";

/**
 * Runtime configuration lets one prebuilt bundle target any hub.
 * The web client, Caddy and this server must agree on the path and shape.
 */
export const CONFIG_PATH = "/uberblick-config.json";

/**
 * Keep a stable origin for browser settings, distinct from Vite's defaults.
 * An occupied port is an error; never choose another automatically.
 */
export const DEFAULT_WEB_PORT = 13379;

export const WEB_HOST = "127.0.0.1";

export type PortHolder = "ub-open" | "foreign" | "unidentified";

/**
 * Classify only a complete answer within budget: our configuration is ub-open;
 * refusals, other documents and invalid JSON are foreign. An incomplete or
 * expired response is unidentified, even if a healthy ub open answered late.
 * Never advise stopping a holder that the probe could not identify.
 */
export async function whoHoldsPort(port: number): Promise<PortHolder> {
  let body: string;
  let ok: boolean;
  try {
    const response = await fetch(`http://${WEB_HOST}:${port}${CONFIG_PATH}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(budget(1_000)),
    });
    // Read the body before classifying status; headers alone identify nobody.
    body = await response.text();
    ok = response.ok;
  } catch {
    return "unidentified";
  }
  if (!ok) return "foreign";
  try {
    const parsed: unknown = JSON.parse(body);
    const hubUrl = (parsed as { hubUrl?: unknown } | null)?.hubUrl;
    return typeof hubUrl === "string" ? "ub-open" : "foreign";
  } catch {
    return "foreign";
  }
}

export function portTakenMessage(port: number, holder: PortHolder): string {
  if (holder === "ub-open") {
    return (
      `error: port ${port} is already serving Uberblick, from another ub open\n` +
      `  → ub open --port ${port < 65535 ? port + 1 : DEFAULT_WEB_PORT}\n`
    );
  }
  if (holder === "foreign") {
    return (
      `error: port ${port} is in use by another process\n` +
      "  → stop it, or run ub open --port <free-port>\n"
    );
  }
  // An unidentified holder gets advice safe for either kind of process.
  return (
    `error: port ${port} is in use, and its holder did not answer in time to say what it is\n` +
    "  → ub open --port <free-port>\n"
  );
}

/**
 * A started hub must answer exactly what the bundle dials: plain ws on
 * loopback with an explicit nonzero port. No TLS, default-port guess or
 * ephemeral-port substitution is available here.
 */
export function whyNotStartable(hubUrl: string, parsed: URL): string | null {
  const preamble = `nothing answers ${hubUrl}, and no hub can be started for it: `;
  if (parsed.protocol !== "ws:") {
    return (
      `${preamble}a hub started here speaks plain ws:// on loopback, so it would ` +
      `never answer ${parsed.protocol}// — start one yourself, or configure a ` +
      "ws:// endpoint"
    );
  }
  if (parsed.port === "" || Number(parsed.port) === 0) {
    return (
      `${preamble}it names no port to bind, and a hub started here binds exactly ` +
      "the port the web app dials rather than guessing one"
    );
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!isLoopbackHost(host)) {
    return (
      `${preamble}\`ub open\` binds loopback only, and ${host} is not a loopback ` +
      "address. This command starts only loopback hubs; reaching a hub from " +
      "another machine is the remote deployment's job (" +
      "REMOTE.md)"
    );
  }
  return null;
}
