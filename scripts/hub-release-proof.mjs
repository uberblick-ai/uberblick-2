#!/usr/bin/env node
/** Local acceptance proof, after two credential-free release dry runs.
 * The host directories come only from Docker images. Every write targets a
 * disposable Compose project; the production uberblick-remote stack is unused.
 * The default loopback route exercises HTTP and the WebSocket proxy without
 * Tailscale. Named HTTPS configuration and its volume continuity are checked
 * without attempting certificate issuance. Certificates and GitHub approval
 * remain attended checks.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertHubDatabaseUpgrade, seedReleaseCredential, snapshotHubDatabase } from "./lib/hub-release-database.mjs";

const WORKSPACE = "00000000-0000-4000-8000-000000001172";
const PRINCIPAL = "00000000-0000-4000-8000-000000001173";
const SETUP = "00000000-0000-4000-8000-000000001174";
const PRIVATE_TABLES = ["hub_principals", "hub_credentials", "hub_memberships", "hub_claim_state"];
// Y.encodeStateAsUpdate(doc), with clientID 1172 and a Y.Text named
// release-proof containing "Synthetic hub release continuity". No host Yjs or
// checkout dependency is needed to seed this valid v1 document snapshot.
const UPDATE = "AQGUCQAEAQ1yZWxlYXNlLXByb29mIFN5bnRoZXRpYyBodWIgcmVsZWFzZSBjb250aW51aXR5AA==";
let activeChild;
let interrupted;

async function unusedLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error === undefined ? resolve(port) : reject(error));
    });
  });
}

function stopChild(signal) {
  if (activeChild?.pid === undefined) return;
  try { process.kill(-activeChild.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function command(program, args, options = {}) {
  if (interrupted && !options.cleanup) throw new Error(interrupted);
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd, env: options.env, detached: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer;
    child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
    child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
    if (options.input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild("SIGTERM");
      killTimer = setTimeout(() => stopChild("SIGKILL"), 2000);
    }, options.timeout ?? 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      activeChild = undefined;
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      activeChild = undefined;
      if (timedOut || (code !== 0 && !options.allowFailure)) {
        reject(new Error(`${program} ${args.join(" ")} failed (${timedOut ? "deadline" : signal ?? code}):\n${stdout}${stderr}`));
      } else resolve({ code, signal, stdout, stderr });
    });
  });
}

function request(port, path, websocket = false, host = `localhost:${port}`, method = "GET", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port, path, method,
      headers: { Host: host, ...headers, ...(method === "POST" ? { "Content-Type": "application/json" } : {}), ...(websocket ? {
        Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "c3ludGhldGljLXByb29mIQ==",
      } : {}) },
    });
    req.setTimeout(5000, () => req.destroy(new Error("HTTP request timed out")));
    req.once("error", reject);
    req.once("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode, headers: response.headers, rawHeaders: response.rawHeaders, body: "" });
    });
    req.once("response", (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk) => { body += chunk; });
      response.once("end", () => resolve({ status: response.statusCode, headers: response.headers, rawHeaders: response.rawHeaders, body }));
      response.once("error", reject);
    });
    req.end(method === "POST" ? "{}" : undefined);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const versions = args.slice(0, 2);
  const expectedSha = args[2] ?? process.env.HUB_RELEASE_PROOF_SHA;
  assert((args.length === 2 || args.length === 3) && versions.every((v) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) &&
    versions[0] !== versions[1] && (expectedSha === undefined || /^[0-9a-f]{40}$/.test(expectedSha)),
  "usage: node scripts/hub-release-proof.mjs <older-version> <newer-version> [expected-source-sha]");
  const run = (process.env.UB_AGENTS_RUN ?? "local").toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  const project = `hub-proof-${run}-${randomUUID().slice(0, 8)}`;
  const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(), `${project}-`));
  const loopbackPort = await unusedLoopbackPort();
  const localSettings = `LOOPBACK_PORT=${loopbackPort}\nWEB_WORKSPACES=${WORKSPACE}\n`;
  const environment = { ...process.env, COMPOSE_PROJECT_NAME: project };
  for (const key of ["HUB_URL", "WORKSPACE_ID", "WORKSPACES", "HUB_AUTH_TOKEN", "HUB_GITHUB_CLIENT_ID",
    "WEB_HUB_URL", "WEB_WORKSPACES", "WEB_HOST", "HTTPS_BIND_IP", "LOOPBACK_PORT", "TAILSCALE_HOST", "TAILSCALE_IP",
    "HUB_PUBLIC_URL", "MCP_ALLOWED_ORIGINS", "COMPOSE_FILE", "COMPOSE_PROFILES", "DOCKER_DEFAULT_PLATFORM"]) delete environment[key];
  let deployment;
  let candidateDeployment = false;
  let cleanupDeployment;
  let cleaningUp = false;
  let namedRoute = false;
  const extractionContainers = new Set();
  const imageProtocols = new Map();
  const releaseServices = new Map();
  const nativeArchitecture = (await command("docker", ["version", "--format", "{{.Server.Arch}}"])).stdout.trim();
  assert.ok(["amd64", "arm64"].includes(nativeArchitecture), `unsupported Docker daemon architecture: ${nativeArchitecture}`);
  const cancel = (signal) => { if (!cleaningUp) { interrupted = signal; stopChild("SIGTERM"); } };
  const onInterrupt = () => cancel("SIGINT");
  const onTerminate = () => cancel("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const deadline = setTimeout(() => { interrupted = "proof exceeded eight-minute deadline"; stopChild("SIGTERM"); }, 8 * 60_000);
  const compose = (args, options = {}) => command("docker", ["compose", "--project-name", project,
    "--file", "docker-compose.yml", ...(namedRoute ? ["--file", "remote.https.yml"] : []), ...args], {
    cwd: deployment, env: environment, ...options,
  });
  const operator = (name, args, options = {}) => command("sh", [join("bin", name), ...args], {
    cwd: deployment, env: environment, ...options,
  });
  const offline = (source) => compose(["run", "--rm", "--no-deps", "-T", "--entrypoint", "node", "hub", "-e", source]);
  const live = (source) => compose(["exec", "-T", "hub", "node", "-e", source]);
  const snapshotSource = `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/hub.sqlite", {readOnly:true});
const result = (${snapshotHubDatabase.toString()})(db, ${JSON.stringify(PRIVATE_TABLES)});
db.close(); console.log(JSON.stringify(result));`;
  const snapshot = async () => {
    const result = JSON.parse((await live(snapshotSource)).stdout);
    assert.equal(result.credentialKeyColumn, imageProtocols.get(deployment) >= 6 ? "public_key" : "signing_key",
      "the database uses the credential schema required by the release protocol");
    return result;
  };
  const caddyStateCommand = "find /data -type f \\( -name '*.crt' -o -name '*.key' \\) -exec sha256sum {} \\; | sort; cat /data/release-proof /config/release-proof";
  const certificateState = async (running = true) => (await compose(running
    ? ["exec", "-T", "caddy", "sh", "-c", caddyStateCommand]
    : ["run", "--rm", "--no-deps", "-T", "--entrypoint", "sh", "caddy", "-c", caddyStateCommand])).stdout;
  async function extract(version, index) {
    const hub = `ghcr.io/uberblick-ai/hub:${version}`;
    const directory = join(scratch, `${project}-release-${index}`);
    mkdirSync(directory);
    const inspection = JSON.parse((await command("docker", ["image", "inspect", hub])).stdout)[0];
    assert.equal(inspection.Os, "linux");
    assert.ok(["amd64", "arm64"].includes(inspection.Architecture));
    if (index === 1 || nativeArchitecture === "amd64") assert.equal(inspection.Architecture, nativeArchitecture,
      "the candidate must run on the Docker host's native platform");
    const platform = `linux/${inspection.Architecture}`;
    if (inspection.Architecture !== nativeArchitecture) console.log(`Older hub ${version} uses ${platform}; the upgrade target must run natively on linux/${nativeArchitecture}.`);
    const name = `${project}-extract-${index}`;
    extractionContainers.add(name);
    await command("docker", ["create", "--platform", platform, "--name", name, "--entrypoint", "/bin/true", hub]);
    await command("docker", ["cp", `${name}:/release/.`, directory]);
    await command("docker", ["rm", name]);
    extractionContainers.delete(name);
    assert.deepEqual(readdirSync(directory).sort(), ["REMOTE.md", "RELEASING.md", "bin", "docker-compose.yml",
      "release.json", "remote-settings.sh", "remote.env.example", "remote.https.yml", "remote.tailscale.yml"].sort());
    const operatorCommand = JSON.parse((await command("docker", ["run", "--rm", "--platform", platform, "--entrypoint", "node", hub, "-e",
      'console.log(require("node:fs").existsSync("/usr/local/bin/ub-hub"))'])).stdout);
    assert.ok(operatorCommand, `hub ${version} ships no ub-hub; the proof needs two releases that do`);
    if (index === 1) assert.deepEqual(readdirSync(join(directory, "bin")), ["remote-compose.sh"]);
    const metadata = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
    imageProtocols.set(directory, metadata.syncProtocolVersion);
    assert.equal(metadata.version, version);
    if (expectedSha !== undefined && index === 1) assert.equal(metadata.sourceCommit, expectedSha);
    assert.equal(metadata.images.hub, hub);
    assert.equal(metadata.images.web, `ghcr.io/uberblick-ai/hub-web:${version}`);
    for (const image of Object.values(metadata.images)) {
      const imageInspection = JSON.parse((await command("docker", ["image", "inspect", image])).stdout)[0];
      assert.equal(imageInspection.Os, "linux");
      assert.equal(imageInspection.Architecture, inspection.Architecture, "both release images use the selected platform");
      const labels = imageInspection.Config.Labels;
      assert.equal(labels["org.opencontainers.image.version"], version);
      assert.equal(labels["org.opencontainers.image.revision"], metadata.sourceCommit);
      assert.equal(labels["io.uberblick.sync-protocol-version"], String(metadata.syncProtocolVersion));
    }
    writeFileSync(join(directory, ".env"), localSettings, { mode: 0o600 });
    const model = JSON.parse((await command("docker", ["compose", "--file", "docker-compose.yml", "config", "--format", "json"],
      { cwd: directory, env: environment })).stdout);
    releaseServices.set(directory, Object.keys(model.services).sort());
    if (index === 1) assert.deepEqual(releaseServices.get(directory), ["caddy", "hub", "mcp"]);
    candidateDeployment = index === 1;
    console.log(`Extracted hub ${version} from ${metadata.sourceCommit}, sync protocol ${metadata.syncProtocolVersion}.`);
    return directory;
  }
  async function serving() {
    let lastError;
    const until = Date.now() + 60_000;
    while (Date.now() < until && !interrupted) {
      try {
        const port = Number((await compose(["port", "caddy", "80"])).stdout.trim().split(":").at(-1));
        assert.equal(port, loopbackPort);
        const home = await request(port, "/");
        assert.equal(home.status, 200);
        assert.match(home.headers["content-type"], /text\/html/);
        if (candidateDeployment) {
          const fragment = (await compose(["exec", "-T", "caddy", "cat", "/etc/caddy/uberblick-csp.caddy"])).stdout;
          const policy = fragment.match(/^header Content-Security-Policy ("[^\n]+")\n$/);
          assert.ok(policy, "the web image imports one generated enforcing policy");
          const expectedPolicy = JSON.parse(policy[1]);
          for (const page of [home, await request(port, `/${WORKSPACE}/${SETUP}`)]) {
            assert.equal(page.status, 200);
            assert.match(page.headers["content-type"], /text\/html/);
            assert.equal(page.headers["content-security-policy"], expectedPolicy);
            assert.equal(page.rawHeaders.filter((name, index) =>
              index % 2 === 0 && name.toLowerCase() === "content-security-policy").length, 1);
            assert.equal(page.headers["content-security-policy-report-only"], undefined);
          }
        }
        const config = await request(port, "/uberblick-config.json");
        assert.equal(config.status, 200);
        assert.equal(config.headers["cache-control"], "no-store");
        assert.deepEqual(JSON.parse(config.body), { hubUrl: `ws://localhost:${loopbackPort}/ws`, workspaces: WORKSPACE });
        assert.equal((await request(port, "/ws", true)).status, 101);
        return;
      } catch (error) { lastError = error; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`stack did not serve loopback HTTP/config/WebSocket: ${interrupted ?? lastError}`);
  }
  async function health(expected, timeout = 60_000, services = releaseServices.get(deployment)) {
    const ids = [];
    for (const service of services) ids.push((await compose(["ps", "--quiet", service])).stdout.trim());
    const until = Date.now() + timeout;
    let states;
    while (Date.now() < until && !interrupted) {
      states = JSON.parse((await command("docker", ["inspect", ...ids])).stdout);
      if (states.every((state) => state.State.Health?.Status === expected)) {
        const output = (await compose(["ps", "--format", "json", ...services])).stdout.trim();
        const rows = output.startsWith("[") ? JSON.parse(output) : output.split("\n").map((line) => JSON.parse(line));
        assert.equal(rows.length, services.length);
        assert.ok(rows.every((service) => service.Health === expected), output);
        return ids;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Docker health did not become ${expected}: ${JSON.stringify(states?.map((state) => state.State.Health))}`);
  }
  async function hostedRoutes(issuer) {
    const authorizationPath = "/.well-known/oauth-authorization-server";
    const resourcePath = `/.well-known/oauth-protected-resource/mcp/${WORKSPACE}`;
    const expectedMetadata = [];
    for (const host of [`localhost:${loopbackPort}`, `127.0.0.1:${loopbackPort}`]) {
      const authorization = await request(loopbackPort, authorizationPath, false, host);
      const resource = await request(loopbackPort, resourcePath, false, host);
      assert.equal(authorization.status, issuer === undefined ? 404 : 200);
      assert.equal(resource.status, issuer === undefined ? 404 : 200);
      const unauthenticated = await request(loopbackPort, `/mcp/${WORKSPACE}`, false, host);
      assert.equal(unauthenticated.status, 401, "the MCP route reaches the host, rather than the app fallback");
      const token = await request(loopbackPort, "/oauth/token", false, host);
      assert.equal(token.status, issuer === undefined ? 404 : 405, "the OAuth route reaches the hub");
      if (issuer === undefined) {
        assert.equal(authorization.body, "");
        assert.equal(resource.body, "");
        assert.equal(unauthenticated.headers["www-authenticate"], undefined);
      } else {
        const authorizationMetadata = JSON.parse(authorization.body);
        const resourceMetadata = JSON.parse(resource.body);
        assert.equal(authorizationMetadata.issuer, issuer);
        assert.deepEqual(resourceMetadata.authorization_servers, [issuer]);
        assert.equal(resourceMetadata.resource, `${issuer}/mcp/${WORKSPACE}`);
        for (const name of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
          assert.equal(new URL(authorizationMetadata[name]).origin, issuer);
        }
        expectedMetadata.push([authorizationMetadata, resourceMetadata]);
        assert.equal(unauthenticated.headers["www-authenticate"],
          `Bearer resource_metadata="${issuer}${resourcePath}", scope="docs:read docs:write"`);
      }
    }
    if (issuer !== undefined) assert.deepEqual(expectedMetadata[0], expectedMetadata[1], "request Host cannot change metadata URLs");
  }
  async function mcpStorage(writeMarker = false) {
    for (const service of ["hub", "mcp"]) {
      const id = (await compose(["ps", "--quiet", service])).stdout.trim();
      assert.equal((await command("docker", ["inspect", "--format", "{{.Config.User}}", id])).stdout.trim(), "node");
      await compose(["exec", "-T", service, "node", "-e", `const assert = require("node:assert/strict");
const fs = require("node:fs"); const path = require("node:path").dirname(process.env.HUB_MCP_SOCKET);
const directory = fs.lstatSync(path); assert.ok(directory.isDirectory());
assert.equal(directory.uid, process.getuid()); assert.equal(directory.mode & 0o777, 0o700);
assert.ok(fs.lstatSync(process.env.HUB_MCP_SOCKET).isSocket());`]);
    }
    await compose(["exec", "-T", "mcp", "node", "-e", `const assert = require("node:assert/strict");
const fs = require("node:fs"); const path = require("node:path");
assert.equal(fs.statSync(process.env.MCP_DATA_DIR).uid, process.getuid());
const marker = path.join(process.env.MCP_DATA_DIR, "release-proof");
${writeMarker ? 'fs.writeFileSync(marker, "synthetic MCP storage continuity\\n");' : ''}
assert.equal(fs.readFileSync(marker, "utf8"), "synthetic MCP storage continuity\\n");`]);
  }
  try {
    deployment = await extract(versions[0], 0);
    cleanupDeployment = deployment;
    const boundaryEnvironment = { ...environment };
    delete boundaryEnvironment.COMPOSE_PROJECT_NAME;
    const rendered = JSON.parse((await command("docker", ["compose", "--file", "docker-compose.yml", "config", "--format", "json"],
      { cwd: deployment, env: boundaryEnvironment })).stdout);
    assert.equal(rendered.name, "uberblick-remote");
    for (const name of ["hub-data", "caddy-data", "caddy-config"]) {
      assert.equal(rendered.volumes[name].name, `uberblick-remote_${name}`);
    }
    const olderHasMcp = releaseServices.get(deployment).includes("mcp");
    assert.deepEqual(Object.keys(rendered.services).sort(), olderHasMcp ? ["caddy", "hub", "mcp"] : ["caddy", "hub"]);
    if (olderHasMcp) {
      assert.equal(rendered.services.mcp.image, rendered.services.hub.image);
      assert.equal(rendered.services.mcp.ports, undefined);
      assert.equal(rendered.services.mcp.build, undefined);
    }
    assert.equal(rendered.services.hub.ports, undefined);
    assert.equal(rendered.services.hub.build, undefined);
    assert.equal(rendered.services.caddy.build, undefined);
    assert.deepEqual(rendered.services.caddy.ports.map(({ host_ip, target, published }) => ({ host_ip, target, published })),
      [{ host_ip: "127.0.0.1", target: 80, published: String(loopbackPort) }]);
    assert.equal(rendered.services.caddy.volumes.some(({ type }) => type === "bind"), false);
    console.log("Extracted host files; stack publishes only loopback HTTP with no Tailscale mount, hub port or host builds.");
    for (const [key, value] of Object.entries({ WEB_HOST: 'bad"host', LOOPBACK_PORT: '80"',
      TAILSCALE_HOST: 'bad"host', WEB_HUB_URL: 'wss://bad"host/ws',
      WEB_WORKSPACES: 'bad"workspace' })) {
      const refused = await compose(["run", "--rm", "--no-deps", "-T", "-e", `${key}=${value}`, "caddy", "version"], { allowFailure: true });
      assert.notEqual(refused.code, 0);
      assert.match(refused.stdout + refused.stderr, new RegExp(key));
    }
    console.log("Plain Compose container entrypoints refuse unsafe configuration inputs by name.");
    await compose(["up", "--detach", "--no-build", "--pull", "never"]);
    await serving();
    if (olderHasMcp) {
      await health("healthy");
      await hostedRoutes(undefined);
      await mcpStorage(true);
    }
    const fresh = await snapshot();
    assert.equal(fresh.hub_claim_state.length, 1);
    assert.equal(fresh.hub_claim_state[0].unclaimed, 1);
    const freshPort = Number((await compose(["port", "caddy", "80"])).stdout.trim().split(":").at(-1));
    for (const host of [`localhost:${freshPort}`, `127.0.0.1:${freshPort}`]) {
      assert.deepEqual(JSON.parse((await request(freshPort, "/auth/claim-state", false, host)).body), { unclaimed: true, canClaim: true });
      const config = await request(freshPort, "/uberblick-config.json", false, host);
      assert.equal(config.status, 200);
      assert.deepEqual(JSON.parse(config.body), { hubUrl: `ws://localhost:${freshPort}/ws`, workspaces: WORKSPACE });
      assert.equal((await request(freshPort, "/ws", true, host)).status, 101);
    }
    for (const path of ["/", "/auth/claim-state", "/auth/github/start", "/uberblick-config.json", "/ws"]) {
      const rebound = await request(freshPort, path, path === "/ws", `rebind.example:${freshPort}`,
        path === "/auth/github/start" ? "POST" : "GET");
      assert.notEqual(rebound.status, 101);
      // Caddy's unmatched host returns an empty response, never a site route.
      assert.equal(rebound.body, "", `non-loopback Host reached ${path}`);
    }
    console.log("Loopback Host names reach config, claiming and WebSockets; a rebound Host reaches none of the site routes.");
    await compose(["stop", "hub"]);
    await offline(`const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/hub.sqlite"); db.exec("BEGIN IMMEDIATE");
const initial = db.prepare("SELECT default_workspace_id FROM hub_claim_state WHERE id = 1").get();
db.prepare("UPDATE documents SET name = ? WHERE name = ?")
  .run("${WORKSPACE}/_settings", initial.default_workspace_id + "/_settings");
db.prepare("UPDATE hub_claim_state SET default_workspace_id = ?, unclaimed = 0 WHERE id = 1").run("${WORKSPACE}");
db.prepare("INSERT INTO documents(name,data) VALUES (?,?)").run("${WORKSPACE}/${SETUP}", Buffer.from("${UPDATE}", "base64"));
db.prepare("INSERT INTO hub_principals (id,github_account_id,github_username) VALUES (?,?,?)").run("${PRINCIPAL}", "11720001", "release-proof");
db.prepare("INSERT INTO hub_memberships (workspace_id, principal_id, role) VALUES (?,?,?)").run("${WORKSPACE}", "${PRINCIPAL}", "admin");
(${seedReleaseCredential.toString()})(db, "${PRINCIPAL}", "${WORKSPACE}");
if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'hub_admin_setup_grants'").get() !== undefined) {
  db.prepare("INSERT INTO hub_admin_setup_grants VALUES (?,?,?,?,?,?)")
    .run("${SETUP}", "${WORKSPACE}", "${PRINCIPAL}", "11720001", "release-proof", 1);
}
db.exec("COMMIT"); db.close();`);
    await compose(["start", "hub"]);
    await serving();
    const original = await snapshot();
    assert.equal(original.documents.length, 2);
    for (const table of PRIVATE_TABLES) assert.equal(original[table].length, 1);
    assert.deepEqual(original.hub_claim_state, [{ id: 1, default_workspace_id: WORKSPACE, unclaimed: 0 }]);
    assert.deepEqual(JSON.parse((await request(freshPort, "/auth/claim-state")).body), { unclaimed: false, canClaim: false });
    const olderBackupPath = (await compose(["exec", "-T", "hub", "ub-hub", "backup"])).stdout.match(/\/data\/[^\s]+\.sqlite/)?.[0];
    assert.ok(olderBackupPath, "online backup reports its private volume path");
    await compose(["cp", `hub:${olderBackupPath}`, "backup.sqlite"]);
    assert.deepEqual(await snapshot(), original);
    console.log("The older release's online backup reached the host while its hub kept serving.");
    await compose(["exec", "-T", "caddy", "sh", "-c", "mkdir -p /data/release-proof-certificates; printf 'synthetic certificate state\\n' > /data/release-proof-certificates/retained.crt; printf 'synthetic key state\\n' > /data/release-proof-certificates/retained.key; printf 'synthetic certificate-volume marker\\n' > /data/release-proof; printf 'synthetic config-volume marker\\n' > /config/release-proof"]);
    const certificates = await certificateState();
    assert.match(certificates, /release-proof-certificates\/retained\.crt/);
    const before = (await compose(["ps", "--quiet", "hub"])).stdout.trim();
    const olderBackup = readFileSync(join(deployment, "backup.sqlite"));
    deployment = await extract(versions[1], 1);
    cleanupDeployment = deployment;
    const candidateModel = JSON.parse((await compose(["config", "--format", "json"])).stdout);
    for (const service of ["hub", "mcp", "caddy"]) assert.equal(candidateModel.services[service].platform, undefined,
      "candidate Compose files leave platform selection to Docker");
    const replacedAt = Date.now();
    await compose(["up", "--detach", "--no-build", "--pull", "never", "--force-recreate"]);
    await serving();
    const healthyIds = await health("healthy");
    await hostedRoutes(undefined);
    await mcpStorage(!olderHasMcp);
    assert.ok(Date.now() - replacedAt < 90_000, "inherited image health arrives inside the existing client's wait");
    try {
      for (const id of healthyIds) await command("docker", ["kill", "--signal", "STOP", id]);
      await health("unhealthy", 110_000);
    } finally {
      for (const id of healthyIds) await command("docker", ["kill", "--signal", "CONT", id], { cleanup: true, allowFailure: true });
    }
    await health("healthy");
    await serving();
    console.log("Image health probes and the MCP override detect suspended listeners and recover when listeners resume; fresh node-owned socket and MCP storage are usable.");
    assert.notEqual((await compose(["ps", "--quiet", "hub"])).stdout.trim(), before);
    let upgraded = await snapshot();
    assertHubDatabaseUpgrade(upgraded, original);
    assert.equal(await certificateState(), certificates);
    for (const [service, image] of [["hub", `ghcr.io/uberblick-ai/hub:${versions[1]}`], ["mcp", `ghcr.io/uberblick-ai/hub:${versions[1]}`], ["caddy", `ghcr.io/uberblick-ai/hub-web:${versions[1]}`]]) {
      const id = (await compose(["ps", "--quiet", service])).stdout.trim();
      assert.equal((await command("docker", ["inspect", "--format", "{{.Config.Image}}", id])).stdout.trim(), image);
    }
    const retiredReceipts = await live("const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('/data/hub.sqlite',{readOnly:true}); console.log(db.prepare(\"SELECT count(*) AS count FROM sqlite_schema WHERE name = 'hub_admin_setup_grants'\").get().count); db.close();");
    assert.equal(Number(retiredReceipts.stdout), 0, "upgrade drops retired setup receipts");
    console.log(`Recreated ${versions[0]} as ${versions[1]} from newly extracted files; documents, private history, claim and Caddy volumes survived; legacy HMAC credentials are revoked when crossing to public keys.`);

    const help = await compose(["exec", "-T", "hub", "ub-hub", "--help"]);
    for (const name of ["status", "doctor", "workspace-admin", "hub-admin", "backup", "restore"]) assert.match(help.stdout, new RegExp(name));
    const hubStatus = await compose(["exec", "-T", "hub", "ub-hub", "status"]);
    assert.ok(hubStatus.stdout.includes(versions[1]), hubStatus.stdout);
    assert.match(hubStatus.stdout, /\/data\/hub\.sqlite/);
    const backup = await compose(["exec", "-T", "hub", "ub-hub", "backup"]);
    const backupPath = backup.stdout.match(/\/data\/[^\s]+\.sqlite/)?.[0];
    assert.ok(backupPath, "online backup reports its private volume path");
    const mode = await live(`const fs = require("node:fs"); console.log(fs.statSync(${JSON.stringify(backupPath)}).mode & 0o777);`);
    assert.equal(Number(mode.stdout), 0o600);
    assert.deepEqual(await snapshot(), upgraded);
    const running = await compose(["run", "--rm", "--no-deps", "-T", "hub", "ub-hub", "restore", "-"],
      { input: olderBackup, allowFailure: true });
    assert.equal(running.code, 1);
    assert.match(running.stdout + running.stderr, /docker compose stop hub/);
    assert.deepEqual(await snapshot(), upgraded);
    await compose(["stop", "hub"]);
    await offline(`const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("/data/hub.sqlite");
db.exec("BEGIN IMMEDIATE"); for (const table of ["hub_credentials", "hub_memberships", "hub_principals", "documents"]) db.exec("DELETE FROM " + table);
db.exec("UPDATE hub_claim_state SET unclaimed = 1 WHERE id = 1");
db.exec("COMMIT"); db.close();`);
    const restore = await compose(["run", "--rm", "--no-deps", "-T", "hub", "ub-hub", "restore", "--yes", "-"], { input: olderBackup });
    assert.match(restore.stdout, /workspace member removal: "release-proof"/);
    await compose(["start", "hub"]);
    await serving();
    const restored = await snapshot();
    assertHubDatabaseUpgrade(restored, original);
    upgraded = restored;
    console.log("ub-hub is on PATH; online backup remains private and keeps serving; restore refuses a running hub, names the removals it undoes and brings the older release's backup back over a wiped database through standard input.");

    const mcpId = (await compose(["ps", "--quiet", "mcp"])).stdout.trim();
    await compose(["stop", "hub"]);
    await health("unhealthy", 110_000, ["mcp"]);
    await compose(["start", "hub"]);
    await health("healthy");
    assert.equal((await compose(["ps", "--quiet", "mcp"])).stdout.trim(), mcpId);
    await serving();
    console.log("Stopping only the hub makes MCP unhealthy; starting the hub restores MCP health without restarting its container.");

    const issuer = `http://localhost:${loopbackPort}`;
    const allowedOrigin = "https://agent.release-proof.example";
    const originRequest = () => request(loopbackPort, `/mcp/${WORKSPACE}`, false,
      `localhost:${loopbackPort}`, "GET", { Origin: allowedOrigin });
    assert.equal((await originRequest()).status, 403, "unset origins allow no browser Origin");
    writeFileSync(join(deployment, ".env"), `${localSettings}HUB_PUBLIC_URL=${issuer}\nMCP_ALLOWED_ORIGINS=${allowedOrigin}\n`, { mode: 0o600 });
    await compose(["up", "--detach", "--no-build", "--pull", "never", "--force-recreate", "hub", "mcp"]);
    await health("healthy");
    await serving();
    await hostedRoutes(issuer);
    assert.equal((await originRequest()).status, 401, "the configured Origin passes admission without granting access");
    for (const service of ["hub", "mcp"]) {
      const configured = await compose(["exec", "-T", service, "node", "-e", 'console.log(process.env.HUB_PUBLIC_URL)']);
      assert.equal(configured.stdout.trim(), issuer);
      const refused = await compose(["run", "--rm", "--no-deps", "-T", "-e", "HUB_PUBLIC_URL=invalid-origin", service], { allowFailure: true });
      assert.notEqual(refused.code, 0);
      assert.match(refused.stdout + refused.stderr, /HUB_PUBLIC_URL/);
    }
    writeFileSync(join(deployment, ".env"), `${localSettings}HUB_PUBLIC_URL=\n`, { mode: 0o600 });
    await compose(["up", "--detach", "--no-build", "--pull", "never", "--force-recreate", "hub", "mcp"]);
    await health("healthy");
    await serving();
    await hostedRoutes(undefined);
    await mcpStorage();
    console.log("Caddy reaches MCP and OAuth routes; absent/empty issuer disables both metadata documents, configured metadata uses only HUB_PUBLIC_URL across Host names, invalid values refuse startup, and origins require operator configuration.");

    await compose(["stop"]);
    writeFileSync(join(deployment, ".env"), `${localSettings}WEB_HOST=release-proof.example.com\n`, { mode: 0o600 });
    namedRoute = true;
    const named = JSON.parse((await operator("remote-compose.sh", ["config", "--format", "json"])).stdout);
    assert.equal(named.services.caddy.environment.WEB_HOST, "release-proof.example.com");
    assert.deepEqual(named.services.caddy.ports.map(({ target, published }) => ({ target, published })),
      [{ target: 443, published: "443" }]);
    assert.equal(named.services.caddy.volumes.some(({ type }) => type === "bind"), false);
    for (const name of ["hub-data", "mcp-data", "hub-mcp-socket", "caddy-data", "caddy-config"]) {
      assert.equal(named.volumes[name].name, `${project}_${name}`);
    }
    // Create the named route's real containers and inspect its shared volumes,
    // but leave Caddy stopped: this host has no public DNS/certificate authority.
    await compose(["create", "--no-build", "--pull", "never", "--force-recreate"]);
    await compose(["start", "hub"]);
    assert.deepEqual(await snapshot(), upgraded);
    assert.equal(await certificateState(false), certificates);
    await compose(["stop", "hub"]);
    writeFileSync(join(deployment, ".env"), localSettings, { mode: 0o600 });
    namedRoute = false;
    await compose(["up", "--detach", "--no-build", "--pull", "never", "--force-recreate"]);
    await serving();
    await health("healthy");
    await mcpStorage();
    assert.deepEqual(await snapshot(), upgraded);
    assert.equal(await certificateState(), certificates);
    console.log("Switching loopback to a named HTTPS configuration and back retained documents, private access, claim and synthetic certificate/configuration state.");
    console.log("Loopback HTTP, public config, claim-state proxy and /ws passed without Tailscale. Anonymous GHCR pulls, trusted certificate issuance and GitHub approval remain attended checks.");
  } finally {
    clearTimeout(deadline);
    cleaningUp = true;
    let cleaned = false;
    try {
      if (cleanupDeployment !== undefined) await compose(["down", "--volumes", "--remove-orphans"], { cleanup: true, cwd: cleanupDeployment });
      for (const name of extractionContainers) {
        const removed = await command("docker", ["rm", "--force", name], { cleanup: true, allowFailure: true });
        assert(removed.code === 0 || /No such container/i.test(removed.stderr), removed.stderr);
      }
      cleaned = true;
    } finally {
      if (cleaned) rmSync(scratch, { recursive: true, force: true });
      else console.error(`Cleanup failed; retain ${scratch} and remove only Compose project ${project}.`);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
  }
}

main().catch((error) => { console.error(`hub-release-proof: ${error.message}`); process.exitCode = 1; });
