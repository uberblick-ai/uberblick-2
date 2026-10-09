// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { devConfigDocument } from "../dev-config-document.js";
import { resolveDevProjectConfig } from "../dev-project-config.js";

const WORKSPACE = "uberblick-6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const OVERRIDE = "uberblick-b2d9e4c7-5a13-4f80-8e6b-71c0a9d35f2e";
const SECRET = "dev-project-test-secret";
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary: string[] = [];
const originalEnv = { ...process.env };
let server: ViteDevServer | undefined;

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "web-project-config-"));
  temporary.push(cwd);
  const env = { XDG_CONFIG_HOME: join(cwd, "config"), XDG_DATA_HOME: join(cwd, "data"), XDG_STATE_HOME: join(cwd, "state") };
  const configDir = join(env.XDG_CONFIG_HOME, "uberblick");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(cwd, ".uberblick.json"), JSON.stringify({ workspaceId: WORKSPACE, hubUrl: null }));
  const credentials = join(configDir, "credentials.json");
  writeFileSync(credentials, JSON.stringify({ signingSecret: SECRET }), { mode: 0o600 });
  return { cwd, env, credentials, configDir };
}

afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("checkout web project configuration", () => {
  it("reads the nearest local binding and private signing secret without an exported token", () => {
    const { cwd, env } = fixture();
    const child = join(cwd, "nested");
    mkdirSync(child);
    expect(JSON.parse(devConfigDocument(env, child))).toEqual({
      hubUrl: "ws://localhost:1234", workspaces: [WORKSPACE], hubAuthToken: SECRET,
    });
  });

  it("uses the explicit binding pair and token ahead of project and machine files", () => {
    const { cwd, env } = fixture();
    const config = resolveDevProjectConfig({ cwd, env: {
      ...env, UB_WORKSPACE_ID: OVERRIDE, UB_HUB_URL: "ws://127.0.0.1:4321", HUB_AUTH_TOKEN: "explicit-test-secret",
    } });
    expect(config.workspaceId).toBe(OVERRIDE);
    expect(config.hubUrl).toBe("ws://127.0.0.1:4321");
    expect(config.hubAuthToken).toBe("explicit-test-secret");
  });

  it.each([
    { UB_HUB_URL: "local" },
    { UB_WORKSPACE_ID: OVERRIDE, UB_HUB_URL: "" },
    { WORKSPACE_ID: OVERRIDE },
    { HUB_URL: "ws://127.0.0.1:4321" },
  ])("refuses unsupported environment selection instead of adopting the project binding: %j", (selection) => {
    const { cwd, env } = fixture();
    expect(() => devConfigDocument({ ...env, ...selection }, cwd)).toThrow();
  });

  it("refuses an exposed credential file and suppresses signing secrets for device admission", () => {
    const { cwd, env, credentials, configDir } = fixture();
    chmodSync(credentials, 0o644);
    const exposed = resolveDevProjectConfig({ cwd, env });
    expect(exposed.hubAuthToken).toBe("");
    expect(exposed.warnings.join("\n")).toContain("secret may have leaked");
    expect(exposed.warnings.join("\n")).toContain(`delete ${credentials}`);
    expect(exposed.warnings.join("\n")).toContain("restart running agents");
    expect(exposed.warnings.join("\n")).not.toContain("chmod 600");
    expect(exposed.warnings.join("\n")).not.toContain(SECRET);
    chmodSync(credentials, 0o600);
    const endpoint = "ws://127.0.0.1:4321";
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ hubAdmissions: { [endpoint]: "device" } }));
    const device = JSON.parse(devConfigDocument({ ...env,
      UB_WORKSPACE_ID: WORKSPACE, UB_HUB_URL: endpoint, HUB_AUTH_TOKEN: "explicit-test-secret",
    }, cwd));
    expect(device.hubAuthToken).toBe("");
  });

  it("runs Vite with shared binding defines and serves the private machine credential at runtime", async () => {
    const { env } = fixture();
    for (const key of ["WORKSPACE_ID", "HUB_URL", "HUB_AUTH_TOKEN", "HUB_ADMISSION", "WORKSPACES", "UBERBLICK_RELEASE_WEB"]) delete process.env[key];
    Object.assign(process.env, env, { UB_WORKSPACE_ID: OVERRIDE, UB_HUB_URL: "local" });
    server = await createServer({ configFile: join(webRoot, "vite.config.ts"), root: webRoot,
      logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
    expect(server.config.define?.__WORKSPACE_ID__).toBe(JSON.stringify(OVERRIDE));
    expect(server.config.define?.__HUB_URL__).toBe(JSON.stringify("ws://localhost:1234"));
    expect(JSON.stringify(server.config.define)).not.toContain(SECRET);
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    expect(url).toBeDefined();
    const response = await fetch(new URL("uberblick-config.json", url));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ hubUrl: "ws://localhost:1234", workspaces: [OVERRIDE], hubAuthToken: SECRET });
  }, 30_000);
});
