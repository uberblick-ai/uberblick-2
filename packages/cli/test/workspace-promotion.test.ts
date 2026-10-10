import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHub, silentLogger, type Hub } from "@uberblick/hub";
import { writeHubLogin, removeHubLogin, type StoredHubLogin } from "@uberblick/hub/auth-store";
import { ensureDeviceLogin } from "@uberblick/hub/device-login";
import { compareCorpus, createMcpServer, inspectRemote, isIdentical, resolveMcpConfig, syncWorkspace } from "@uberblick/mcp-server";
import { getWorkspaceName, listDirectory, readSidebar, tombstoneDirectoryEntry } from "@uberblick/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UB_BIN, removeTempDirs, runUbAsync, sandbox, unboundSandbox, type Sandbox } from "./helpers.js";
import { readWorkspaceHub } from "../src/workspace-registry.js";

const hubs: Hub[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const hub of hubs.splice(0)) await hub.stop();
  removeTempDirs();
});
const selected = (box: Sandbox) => JSON.parse(readFileSync(join(box.cwd, ".uberblick.json"), "utf8")) as { workspaceId: string; hubUrl: string | null };
const bindingBytes = (box: Sandbox) => readFileSync(join(box.cwd, ".uberblick.json"), "utf8");
function offline(box: Sandbox) {
  return { ...resolveMcpConfig({ ...box.env, WORKSPACE_ID: selected(box).workspaceId }), authSecret: null };
}
async function localWorkspace(name = "Project notes") {
  const box = unboundSandbox();
  const result = await runUbAsync(["workspace", "create", name], box);
  expect(result.status, result.output).toBe(0);
  expect(readWorkspaceHub(selected(box).workspaceId, box.env)).toBeNull();
  return box;
}
async function hubFor(box: Sandbox, role: "admin" | "member" | null = "admin") {
  const hub = await createHub({ port: 0, address: "127.0.0.1", databasePath: join(sandbox().cwd, "hub.sqlite"),
    github: { clientId: "Iv1.0123456789abcdef", fetch: async () => { throw new Error("GitHub should not be called with a working login"); } },
    log: silentLogger, debounce: 10, maxDebounce: 20,
  }, { deviceCredentials: true, initializeDefaultWorkspace: true });
  hubs.push(hub);
  const identity = hub.principals!.identify("1201", "test-promoter");
  const administered = randomUUID();
  if (role !== null) hub.memberships!.grant({ workspaceId: administered, principalId: identity.id, role });
  const credential = hub.credentials!.issue({ principalId: identity.id, deviceId: randomUUID(), workspaces: role === null ? [] : [administered] });
  const login: StoredHubLogin = { identity, credential: { record: credential.record, key: Buffer.from(credential.keyBytes).toString("base64url") } };
  const endpoint = `ws://127.0.0.1:${hub.port}`;
  await writeHubLogin(`http://127.0.0.1:${hub.port}`, login, box.env);
  return { hub, endpoint, login, administered };
}

function accessRows(hub: Hub) {
  const db = new DatabaseSync(hub.databasePath, { readOnly: true });
  try {
    return { memberships: db.prepare("SELECT * FROM hub_memberships ORDER BY workspace_id, principal_id").all(),
      claims: db.prepare("SELECT * FROM hub_claim_state").all(),
      receipts: db.prepare("SELECT * FROM hub_workspace_promotions").all() };
  } finally { db.close(); }
}

describe("workspace creation and promotion", () => {
  it("shows accepted hub forms and complete promotion examples", async () => {
    const result = await runUbAsync(["workspace", "promote", "--help"], sandbox());
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain("bare host, an HTTP(S) URL or a WS(S) endpoint");
    expect(result.stdout).toContain("ub workspace promote https://hub.example.com");
    expect(result.stdout).toContain("ub workspace promote wss://hub.example.com/ws");
    expect(result.stdout).toContain("member or administrator of at least one workspace");
  });

  it("creates a new named workspace with starters without touching parent bindings, old data, credentials or MCP pins", async () => {
    const box = await localWorkspace("Original");
    const old = selected(box);
    const before = await syncWorkspace(offline(box));
    const config = createMcpServer(offline(box));
    try {
      expect(getWorkspaceName(config.replicas.settings().doc)).toBe("Original");
      expect(listDirectory(config.replicas.directory().doc)).toHaveLength(2);
      expect(readSidebar(config.replicas.sidebar().doc)).toHaveLength(1);
    } finally { await config.close(); }
    const { login } = await hubFor(box);
    const credentials = join(box.configHome, "uberblick", "credentials.json");
    const credentialsBefore = readFileSync(credentials);
    const parentBefore = bindingBytes(box);
    const child = join(box.cwd, "another-project");
    mkdirSync(child);
    const pins = JSON.stringify({ mcpServers: { uberblick: { env: { UB_WORKSPACE_ID: old.workspaceId, UB_HUB_URL: "local" } } } });
    writeFileSync(join(child, ".mcp.json"), pins);
    const childBox = { ...box, cwd: child };
    const result = await runUbAsync(["workspace", "create", " New project "], childBox,
      { UB_WORKSPACE_ID: old.workspaceId, UB_HUB_URL: "local" });
    expect(result.status, result.output).toBe(0);
    expect(result.stderr).toContain("environment binding still takes precedence");
    expect(result.stderr).not.toContain("MCP registrations");
    expect(result.stderr).not.toContain("ub mcp install");
    expect(selected(childBox).workspaceId).not.toBe(old.workspaceId);
    expect(selected(childBox).hubUrl).toBeNull();
    expect(bindingBytes(box)).toBe(parentBefore);
    expect(readFileSync(credentials)).toEqual(credentialsBefore);
    expect(readFileSync(join(child, ".mcp.json"), "utf8")).toBe(pins);
    const after = await syncWorkspace(offline(box));
    expect(isIdentical(compareCorpus(before.entries, after.entries))).toBe(true);
    expect(result.output).not.toContain(login.credential.key);
    const fresh = createMcpServer(offline(childBox));
    try {
      expect(getWorkspaceName(fresh.replicas.settings().doc)).toBe("New project");
      expect(listDirectory(fresh.replicas.directory().doc)).toHaveLength(2);
      expect(readSidebar(fresh.replicas.sidebar().doc)[0]?.name).toBe("Überblick");
    } finally { await fresh.close(); }
  });

  it("identifies a replaced binding and provides a working switch-back command", async () => {
    // A complete old binding can exist before this machine has its replica.
    const previous = { workspaceId: randomUUID(), hubUrl: "wss://old.example.test/ws" };
    const box = sandbox({ projectBinding: previous });
    expect(readWorkspaceHub(previous.workspaceId, box.env)).toBeUndefined();
    const result = await runUbAsync(["workspace", "create", "Second"], box);
    expect(result.status, result.output).toBe(0);
    expect(selected(box).workspaceId).not.toBe(previous.workspaceId);
    expect(readWorkspaceHub(previous.workspaceId, box.env)).toBe(previous.hubUrl);
    expect(readWorkspaceHub(selected(box).workspaceId, box.env)).toBeNull();
    expect(existsSync(join(box.dataHome, "uberblick", `${previous.workspaceId}.sqlite`))).toBe(false);
    expect(result.stdout).toContain(`Previous workspace ${previous.workspaceId} (${previous.hubUrl})`);
    expect(result.stdout).toContain(`Switch back: ub workspace use ${previous.workspaceId}\n`);
    const switched = await runUbAsync(["workspace", "use", previous.workspaceId], box);
    expect(switched.status, switched.output).toBe(0);
    expect(selected(box)).toEqual(previous);
  });

  it("keeps loopback promotion admission private and requires login after logout", async () => {
    const box = await localWorkspace();
    const { hub, endpoint } = await hubFor(box);
    const mcpEntry = JSON.stringify({ mcpServers: { uberblick: { env: { UB_WORKSPACE_ID: selected(box).workspaceId, UB_HUB_URL: "local" } } } });
    writeFileSync(join(box.cwd, ".mcp.json"), mcpEntry);
    const result = await runUbAsync(["workspace", "promote", endpoint], box);
    expect(result.status, result.output).toBe(0);
    expect(result.stderr).not.toContain("MCP registrations");
    expect(result.stderr).not.toContain("ub mcp install");
    expect(readFileSync(join(box.cwd, ".mcp.json"), "utf8")).toBe(mcpEntry);
    expect(Object.keys(selected(box)).sort()).toEqual(["hubUrl", "workspaceId"]);
    expect(readWorkspaceHub(selected(box).workspaceId, box.env)).toBe(endpoint);
    await removeHubLogin(`http://127.0.0.1:${hub.port}`, box.env);
    const status = await runUbAsync(["status", "--json"], box, { HUB_AUTH_TOKEN: "synthetic-local-secret" });
    expect(JSON.parse(status.stdout).hub.status).toBe("auth-failed");
    expect(JSON.parse(status.stdout).credentialPresent).toBe(false);
    expect(status.stdout).toContain("ub auth login");
  });

  it("does not select the hub when private admission persistence fails after upload", async () => {
    const box = await localWorkspace();
    const { hub, endpoint } = await hubFor(box);
    const before = bindingBytes(box);
    const result = await new Promise<{ status: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [UB_BIN, "workspace", "promote", endpoint], { cwd: box.cwd, env: box.env, timeout: 25_000 });
      let output = "";
      let injected = false;
      child.stdout.on("data", data => { output += String(data); });
      child.stderr.on("data", data => {
        output += String(data);
        if (!injected && output.includes("verifying")) {
          injected = true;
          mkdirSync(join(box.configHome, "uberblick", "config.json"));
        }
      });
      child.on("error", reject);
      child.on("close", status => resolve({ status, output }));
    });
    expect(result.status, result.output).toBe(1);
    expect(accessRows(hub).receipts).toHaveLength(1);
    expect(bindingBytes(box)).toBe(before);
    expect(result.output).toContain("Project binding unchanged");
    expect(readWorkspaceHub(selected(box).workspaceId, box.env)).toBeNull();
  });

  it("refuses a different environment binding before reserving or replacing the project selection", async () => {
    const box = await localWorkspace("Project A");
    const original = bindingBytes(box);
    const created = await runUbAsync(["workspace", "create", "Project B"], box);
    expect(created.status, created.output).toBe(0);
    const other = selected(box).workspaceId;
    writeFileSync(join(box.cwd, ".uberblick.json"), original);
    const { hub, endpoint } = await hubFor(box);
    const before = accessRows(hub);
    const child = join(box.cwd, "nested");
    mkdirSync(child);
    for (const cwd of [box.cwd, child]) {
      const result = await runUbAsync(["workspace", "promote", endpoint], { ...box, cwd },
        { UB_WORKSPACE_ID: other, UB_HUB_URL: "local" });
      expect(result.status, result.output).toBe(1);
      expect(result.stderr).toContain("environment selects a different binding");
      expect(bindingBytes(box)).toBe(original);
      expect(accessRows(hub)).toEqual(before);
    }
    expect(existsSync(join(child, ".uberblick.json"))).toBe(false);
  });

  it("rejects an invalid project file before creating an orphan replica", async () => {
    const box = sandbox();
    const original = JSON.stringify({ workspaceId: randomUUID(), hubUrl: "local" });
    writeFileSync(join(box.cwd, ".uberblick.json"), original);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runUbAsync(["workspace", "create", "Unused workspace"], box);
      expect(result.status, result.output).toBe(1);
      expect(bindingBytes(box)).toBe(original);
      expect(existsSync(join(box.dataHome, "uberblick"))).toBe(false);
    }
  });

  it.each(["admin", "member"] as const)("uploads the same history for a current %s and joins from a machine with no local workspace", async role => {
    const box = await localWorkspace();
    const local = createMcpServer(offline(box));
    try {
      const entry = listDirectory(local.replicas.directory().doc)[0]!;
      tombstoneDirectoryEntry(local.replicas.directory().doc, entry.uuid);
    } finally { await local.close(); }
    const expected = await syncWorkspace(offline(box));
    const { hub, endpoint, login, administered } = await hubFor(box, role);
    const before = accessRows(hub);
    // An earlier no-access check must not suppress renewal after the grant.
    expect((await ensureDeviceLogin(endpoint, selected(box).workspaceId, { env: box.env })).status).toBe("no-access");
    const result = await runUbAsync(["workspace", "promote", endpoint], box,
      { UB_WORKSPACE_ID: selected(box).workspaceId, UB_HUB_URL: "local" });
    expect(result.status, result.output).toBe(0);
    expect(result.stderr).toContain("environment binding still takes precedence");
    expect(result.stderr).not.toContain("ub mcp install");
    expect(result.stdout).toContain(`ub workspace use ${endpoint}/${selected(box).workspaceId}`);
    expect(result.output).not.toContain("waiting for approval…");
    expect(result.output).not.toContain(login.credential.key);
    expect(selected(box)).toEqual({ workspaceId: selected(box).workspaceId, hubUrl: endpoint });
    expect(readWorkspaceHub(selected(box).workspaceId, box.env)).toBe(endpoint);
    const privateConfig = JSON.parse(readFileSync(join(box.configHome, "uberblick", "config.json"), "utf8"));
    expect(privateConfig.hubAdmissions).toEqual({ [endpoint]: "device" });
    const remote = await inspectRemote(resolveMcpConfig({ ...box.env, WORKSPACE_ID: selected(box).workspaceId, HUB_URL: endpoint, HUB_ADMISSION: "device" }), { documents: true, workspace: true });
    expect(remote.missing).toEqual([]);
    expect(remote.entries.filter(entry => entry.deleted)).toHaveLength(1);
    expect(isIdentical(compareCorpus(expected.entries, remote.entries))).toBe(true);
    expect(isIdentical(compareCorpus(expected.workspace!, remote.workspace!))).toBe(true);
    const after = accessRows(hub);
    expect(after.claims).toEqual(before.claims);
    expect(after.memberships.filter(row => row.workspace_id === administered)).toEqual(before.memberships);
    expect(after.memberships.filter(row => row.workspace_id === selected(box).workspaceId)).toEqual([
      expect.objectContaining({ principal_id: login.identity.id, role: "admin" }),
    ]);
    const other = unboundSandbox();
    const freshCredential = hub.credentials!.issue({ principalId: login.identity.id, deviceId: randomUUID(), workspaces: [selected(box).workspaceId] });
    await writeHubLogin(`http://127.0.0.1:${hub.port}`, { identity: login.identity,
      credential: { record: freshCredential.record, key: Buffer.from(freshCredential.keyBytes).toString("base64url") } }, other.env);
    const joined = await runUbAsync(["workspace", "use", `${endpoint}/${selected(box).workspaceId}`], other);
    expect(joined.status, joined.output).toBe(0);
    expect(selected(other).workspaceId).toBe(selected(box).workspaceId);
    const hydrated = await syncWorkspace(offline(other));
    expect(isIdentical(compareCorpus(expected.entries, hydrated.entries))).toBe(true);
    expect(isIdentical(compareCorpus(expected.workspace!, hydrated.workspace!))).toBe(true);
  });

  it("refuses an account with no memberships without changing the hub or project binding", async () => {
    const box = await localWorkspace();
    const { hub, endpoint } = await hubFor(box, null);
    const before = accessRows(hub);
    const binding = bindingBytes(box);
    const result = await runUbAsync(["workspace", "promote", endpoint], box);
    expect(result.status, result.output).toBe(1);
    expect(result.stderr).toContain("currently belong to at least one workspace");
    expect(result.stderr).not.toContain("rerun this command");
    expect(accessRows(hub)).toEqual(before);
    expect(bindingBytes(box)).toBe(binding);
    expect(result.output).not.toContain("waiting for approval…");
  });

  it("refuses an existing destination and a workspace already bound to a hub", async () => {
    const box = await localWorkspace();
    const { hub, endpoint, login } = await hubFor(box);
    hub.memberships!.grant({ workspaceId: selected(box).workspaceId, principalId: login.identity.id, role: "admin" });
    const before = accessRows(hub);
    const binding = bindingBytes(box);
    const conflict = await runUbAsync(["workspace", "promote", endpoint], box);
    expect(conflict.status, conflict.output).toBe(1);
    expect(conflict.stderr).toContain("already holds this workspace UUID");
    expect(conflict.stderr).not.toContain("rerun this command");
    expect(accessRows(hub)).toEqual(before);
    expect(bindingBytes(box)).toBe(binding);
    writeFileSync(join(box.cwd, ".uberblick.json"), JSON.stringify({ ...selected(box), hubUrl: endpoint }));
    const bound = await runUbAsync(["workspace", "promote", endpoint], box);
    expect(bound.status).toBe(1);
    expect(bound.stderr).toContain("already has a hub");
    expect(bound.stderr).not.toContain("rerun this command");
    expect(accessRows(hub)).toEqual(before);
  });

  it("keeps a local binding after interruption at verification and resumes the same durable attempt", async () => {
    const box = await localWorkspace();
    const { hub, endpoint } = await hubFor(box);
    const binding = bindingBytes(box);
    const interrupted = await new Promise<{ status: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [UB_BIN, "workspace", "promote", endpoint], { cwd: box.cwd, env: box.env, timeout: 25_000 });
      let output = "";
      let sent = false;
      child.stdout.on("data", data => { output += String(data); });
      child.stderr.on("data", data => {
        output += String(data);
        if (!sent && output.includes("verifying")) { sent = true; child.kill("SIGINT"); }
      });
      child.on("error", reject);
      child.on("close", status => resolve({ status, output }));
    });
    expect(interrupted.status, interrupted.output).toBe(1);
    expect(interrupted.output).toContain("promotion interrupted");
    expect(bindingBytes(box)).toBe(binding);
    const before = accessRows(hub);
    expect(before.receipts).toHaveLength(1);
    const retried = await runUbAsync(["workspace", "promote", endpoint], box);
    expect(retried.status, retried.output).toBe(0);
    expect(accessRows(hub)).toEqual(before);
    expect(selected(box).hubUrl).toBe(endpoint);
  });

  it("validates names and URLs without side effects or echoing pasted credentials", async () => {
    const box = unboundSandbox();
    for (const name of ["", "bad\nname", "x".repeat(65)]) expect((await runUbAsync(["workspace", "create", name], box)).status).toBe(2);
    const result = await runUbAsync(["workspace", "promote", "https://user:private-paste@hub.test"], box);
    expect(result.status).toBe(2);
    expect(result.output).not.toContain("private-paste");
    expect(existsSync(join(box.cwd, ".uberblick.json"))).toBe(false);
    expect(readdirSync(box.cwd)).toEqual([]);
  });
});

it.each(["missing", "revoked"])("runs GitHub approval with a %s login without login next actions", async state => {
  const box = await localWorkspace();
  let approvals = 0;
  const github: typeof fetch = async input => {
    const url = String(input);
    if (url === "https://github.com/login/device/code") {
      approvals++;
      return Response.json({ device_code: "fixture-private-code", user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 });
    }
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "fixture-private-token", token_type: "bearer", scope: "" });
    if (url === "https://api.github.com/user") return Response.json({ id: 1234, login: "test-first-owner" });
    throw new Error("unexpected GitHub request");
  };
  const hub = await createHub({ port: 0, address: "127.0.0.1", databasePath: join(sandbox().cwd, "hub.sqlite"),
    github: { clientId: "Iv1.0123456789abcdef", fetch: github }, log: silentLogger,
  }, { deviceCredentials: true, initializeDefaultWorkspace: true });
  hubs.push(hub);
  const endpoint = `ws://127.0.0.1:${hub.port}`;
  const identity = hub.principals!.identify("1234", "test-first-owner");
  const issued = hub.credentials!.issue({ principalId: identity.id, deviceId: randomUUID(), workspaces: [] });
  if (state === "revoked") await writeHubLogin(`http://127.0.0.1:${hub.port}`, { identity,
    credential: { record: issued.record, key: Buffer.from(issued.keyBytes).toString("base64url") } }, box.env);
  hub.credentials!.revokeDevice(identity.id, issued.record.deviceId);
  const result = await runUbAsync(["workspace", "promote", endpoint], box);
  expect(result.status, result.output).toBe(0);
  expect(result.stdout).toContain("open       https://github.com/login/device\n");
  expect(result.stdout).toContain("claimed    default workspace (");
  expect(result.stdout).not.toContain("Use it here:");
  expect(result.stdout).not.toContain("Project binding unchanged");
  expect(result.stdout).toContain(`Use on another machine: ub workspace use ${endpoint}/${selected(box).workspaceId}\n`);
  expect(result.output).not.toContain("fixture-private");
  expect(approvals).toBe(1);
  const rows = accessRows(hub);
  expect(rows.claims[0]!.unclaimed).toBe(0);
  expect(rows.memberships).toHaveLength(2);
  expect(rows.memberships.every(row => row.role === "admin")).toBe(true);
  expect(rows.receipts).toHaveLength(1);
});

it("resumes a lost grant reply using another URL spelling of the same authentication origin", async () => {
  const box = await localWorkspace();
  const { hub, endpoint } = await hubFor(box);
  const before = bindingBytes(box);
  const handler = hub.hocuspocus.configuration.onRequest!;
  const extension = hub.hocuspocus.configuration.extensions.find(item => item.onRequest === handler)!;
  vi.spyOn(extension, "onRequest").mockImplementationOnce(async payload => {
    expect(payload.request.url).toBe("/auth/manage");
    vi.spyOn(payload.response, "end").mockImplementation(() => {
      payload.response.destroy();
      return payload.response;
    });
    return handler(payload);
  });
  const lost = await runUbAsync(["workspace", "promote", endpoint], box);
  expect(lost.status, lost.output).toBe(1);
  expect(lost.output).toContain("resume the same attempt");
  expect(bindingBytes(box)).toBe(before);
  const reserved = accessRows(hub);
  expect(reserved.receipts).toHaveLength(1);
  const retry = await runUbAsync(["workspace", "promote", endpoint.replace("ws:", "http:")], box);
  expect(retry.status, retry.output).toBe(0);
  expect(accessRows(hub)).toEqual(reserved);
});
