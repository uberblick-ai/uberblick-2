import { request } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

const configuredHost = process.env.HUB_HOST?.trim() || "0.0.0.0";
// A hostname bind selects a container address; inspect local interfaces without DNS.
const hosts = configuredHost === "::" ? ["::1"]
  : configuredHost === "0.0.0.0" ? ["127.0.0.1"]
    : configuredHost === "localhost" ? ["127.0.0.1", "::1"]
      : isIP(configuredHost) !== 0 ? [configuredHost]
        : [...new Set(Object.values(networkInterfaces()).flatMap((addresses) => addresses ?? []).map((address) => address.address))];
const controller = new AbortController();
try {
  await Promise.any(hosts.map((host) => new Promise((resolve, reject) => {
    const probe = request({ host, port: process.env.PORT?.trim() || "1234", path: "/auth/claim-state", agent: false, signal: controller.signal });
    probe.once("response", (response) => {
      response.destroy();
      if (response.statusCode === 200) resolve();
      else reject(new Error(`Hub health check returned HTTP ${response.statusCode}`));
    });
    probe.once("error", reject);
    probe.setTimeout(4_000, () => probe.destroy(new Error("Hub health check timed out")));
    probe.end();
  })));
} catch {
  process.exitCode = 1;
} finally {
  controller.abort();
}
