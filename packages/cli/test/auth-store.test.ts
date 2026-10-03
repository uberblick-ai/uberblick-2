import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  type StoredHubLogin,
  isHubLogin,
  preflightHubLoginStore,
  readHubLogins,
  removeHubLogin,
  writeHubLogin,
} from "../src/auth-store.js";
import { credentialsPath, resolveConfig, userConfigPath } from "../src/config.js";
import * as safeWrite from "../src/safe-write.js";
import { SECRET_ON_FILE, removeTempDirs, sandbox } from "./helpers.js";

afterAll(removeTempDirs);
afterEach(() => vi.restoreAllMocks());

const HUB = "https://hub.example.test";
const OTHER_HUB = "http://localhost:1234";
const WORKSPACE = "aaaaaaaa-1111-4111-8111-111111111111";

function login(): StoredHubLogin {
  return {
    identity: {
      id: "bbbbbbbb-2222-4222-8222-222222222222",
      githubAccountId: "42",
      githubUsername: "managed_user",
    },
    credential: {
      record: {
        id: "cccccccc-3333-4333-8333-333333333333",
        principalId: "bbbbbbbb-2222-4222-8222-222222222222",
        deviceId: "dddddddd-4444-4444-8444-444444444444",
        workspaces: [WORKSPACE],
        issuedAt: 1_790_000_000_000,
        revokedAt: null,
      },
      key: Buffer.alloc(32, 17).toString("base64url"),
    },
  };
}

describe("hub login store", () => {
  it("preflights an absent store without creating a credential or signing secret", () => {
    const box = sandbox();
    const path = credentialsPath(box.env);
    expect(readHubLogins(box.env).state).toBe("missing");
    expect(preflightHubLoginStore(box.env)).toBe(path);
    expect(readdirSync(dirname(path))).toEqual([]);
    expect(readHubLogins(box.env).state).toBe("missing");
  });

  it("stores at mode 0600 while keeping the binding, signing secret and unknown fields", () => {
    const box = sandbox({
      userConfig: { hubUrl: "wss://hub.example.test/ws", workspace: WORKSPACE },
      credentials: { signingSecret: SECRET_ON_FILE, future: { opaque: true } },
    });
    const binding = readFileSync(userConfigPath(box.env), "utf8");
    const path = credentialsPath(box.env);
    const before = readFileSync(path, "utf8");
    preflightHubLoginStore(box.env);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(writeHubLogin(HUB, login(), box.env)).toBe(false);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored).toEqual({
      signingSecret: SECRET_ON_FILE,
      future: { opaque: true },
      hubLogins: { [HUB]: login() },
    });
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(userConfigPath(box.env), "utf8")).toBe(binding);
    expect(readHubLogins(box.env)).toEqual({
      path, state: "usable", logins: { [HUB]: login() }, unreadableHubs: [],
    });
    // Issuance and storage do not opt existing commands into credential use.
    expect(JSON.stringify(resolveConfig({ env: box.env }))).not.toContain(login().credential.key);
  });

  it("replaces and removes only the selected login, keeping malformed and future entries", () => {
    const other = login();
    other.identity.githubUsername = "other-user";
    const unreadable = { credential: { key: "broken" } };
    const box = sandbox({ credentials: {
      signingSecret: SECRET_ON_FILE,
      hubLogins: {
        [HUB]: login(), [OTHER_HUB]: other,
        "https://broken.example.test": unreadable, future: { version: 2 },
      },
    } });
    const next = login();
    next.credential.record.deviceId = "eeeeeeee-5555-4555-8555-555555555555";
    expect(writeHubLogin(HUB, next, box.env)).toBe(true);
    expect(readHubLogins(box.env).logins).toEqual({ [HUB]: next, [OTHER_HUB]: other });
    expect(readHubLogins(box.env).unreadableHubs).toEqual(["https://broken.example.test"]);
    expect(removeHubLogin(HUB, box.env)).toBe(true);
    expect(removeHubLogin(HUB, box.env)).toBe(false);
    expect(JSON.parse(readFileSync(credentialsPath(box.env), "utf8"))).toEqual({
      signingSecret: SECRET_ON_FILE,
      hubLogins: { [OTHER_HUB]: other, "https://broken.example.test": unreadable, future: { version: 2 } },
    });
  });

  it("stores only the public identity, credential record and key from collection", () => {
    const box = sandbox();
    const value = login();
    const extra = {
      ...value,
      collectionSecret: "private-collection-secret",
      identity: { ...value.identity, githubToken: "private-github-token" },
      credential: {
        ...value.credential,
        githubToken: "private-github-token",
        record: { ...value.credential.record, collectionSecret: "private-collection-secret" },
      },
    };
    expect(isHubLogin(extra)).toBe(true);
    writeHubLogin(HUB, extra, box.env);
    expect(JSON.parse(readFileSync(credentialsPath(box.env), "utf8"))).toEqual({ hubLogins: { [HUB]: value } });
  });

  it.each([0o644, 0o640, 0o606])("refuses mode %o for reads and mutations without repairing it", (mode) => {
    const box = sandbox({ credentials: { signingSecret: SECRET_ON_FILE, hubLogins: { [HUB]: login() } }, credentialsMode: mode });
    const path = credentialsPath(box.env);
    const before = readFileSync(path, "utf8");
    const state = readHubLogins(box.env);
    expect(state.state).toBe("refused");
    expect(state.logins).toEqual({});
    expect(state.diagnostic).toContain(`chmod 600 ${path}`);
    expect(JSON.stringify(state)).not.toContain(login().credential.key);
    for (const mutate of [
      () => preflightHubLoginStore(box.env),
      () => writeHubLogin(HUB, login(), box.env),
      () => removeHubLogin(HUB, box.env),
    ]) expect(mutate).toThrow(`chmod 600 ${path}`);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(lstatSync(path).mode & 0o777).toBe(mode);
  });

  it.each([
    { raw: { credentials: "secret-that-must-not-leak" } },
    { credentials: [] },
    { credentials: { hubLogins: [] } },
    { credentials: { hubLogins: null } },
  ])("refuses unreadable stores without revealing or overwriting their contents", (files) => {
    const box = sandbox(files);
    const path = credentialsPath(box.env);
    const before = readFileSync(path, "utf8");
    const result = readHubLogins(box.env);
    expect(result.state).toBe("unreadable");
    expect(result.logins).toEqual({});
    expect(JSON.stringify(result)).not.toContain("secret-that-must-not-leak");
    expect(() => preflightHubLoginStore(box.env)).toThrow(/credential store/);
    expect(() => writeHubLogin(HUB, login(), box.env)).toThrow(/credential store/);
    expect(() => removeHubLogin(HUB, box.env)).toThrow(/credential store/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses symlinks and directories without touching their targets", () => {
    const box = sandbox();
    const path = credentialsPath(box.env);
    const target = join(box.cwd, "owner-file.json");
    writeFileSync(target, JSON.stringify({ hubLogins: { [HUB]: login() } }), { mode: 0o600 });
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
    expect(readHubLogins(box.env).state).toBe("refused");
    expect(() => preflightHubLoginStore(box.env)).toThrow(/regular file you own/);
    expect(() => writeHubLogin(HUB, login(), box.env)).toThrow(/regular file you own/);
    expect(() => removeHubLogin(HUB, box.env)).toThrow(/regular file you own/);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(JSON.stringify({ hubLogins: { [HUB]: login() } }));

    const directoryBox = sandbox();
    mkdirSync(credentialsPath(directoryBox.env), { recursive: true });
    expect(readHubLogins(directoryBox.env).state).toBe("refused");
    expect(() => preflightHubLoginStore(directoryBox.env)).toThrow(/regular file you own/);
  });

  it("fails preflight on a non-writable directory before changing stored bytes", () => {
    const box = sandbox({ credentials: { signingSecret: SECRET_ON_FILE, hubLogins: { [HUB]: login() } } });
    const path = credentialsPath(box.env);
    const before = readFileSync(path, "utf8");
    chmodSync(dirname(path), 0o500);
    try {
      expect(() => preflightHubLoginStore(box.env)).toThrow(/directory is writable/);
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readdirSync(dirname(path))).toEqual(["credentials.json"]);
    } finally {
      chmodSync(dirname(path), 0o700);
    }
  });

  it("keeps the earlier login when publication fails and does not leak the new key", () => {
    const box = sandbox({ credentials: { signingSecret: SECRET_ON_FILE, hubLogins: { [HUB]: login() } } });
    const path = credentialsPath(box.env);
    const before = readFileSync(path, "utf8");
    const next = login();
    next.credential.key = Buffer.alloc(32, 23).toString("base64url");
    vi.spyOn(safeWrite, "publishOwnerOnly").mockImplementation(() => { throw new Error(next.credential.key); });
    expect(() => writeHubLogin(HUB, next, box.env)).toThrow(/could not write credential store/);
    try { writeHubLogin(HUB, next, box.env); } catch (error) {
      expect(String(error)).not.toContain(next.credential.key);
      expect(String(error)).not.toContain(SECRET_ON_FILE);
    }
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("collected login validation", () => {
  it("accepts empty workspace limits and nullable integer timestamps", () => {
    const value = login();
    value.credential.record.workspaces = [];
    value.credential.record.revokedAt = value.credential.record.issuedAt + 1;
    expect(isHubLogin(value)).toBe(true);
  });

  it("rejects malformed identities, records and noncanonical keys", () => {
    for (const mutate of [
      (value: StoredHubLogin) => { value.identity.id = "bad"; },
      (value: StoredHubLogin) => { value.identity.githubAccountId = "042"; },
      (value: StoredHubLogin) => { value.identity.githubUsername = ""; },
      (value: StoredHubLogin) => { value.credential.record.id = "bad"; },
      (value: StoredHubLogin) => { value.credential.record.principalId = WORKSPACE; },
      (value: StoredHubLogin) => { value.credential.record.deviceId = "bad"; },
      (value: StoredHubLogin) => { value.credential.record.workspaces = [`decorated-${WORKSPACE}`]; },
      (value: StoredHubLogin) => { value.credential.record.issuedAt = Number.NaN; },
      (value: StoredHubLogin) => { value.credential.record.revokedAt = -1; },
      (value: StoredHubLogin) => { value.credential.key += "="; },
      (value: StoredHubLogin) => { value.credential.key = Buffer.alloc(31).toString("base64url"); },
    ]) {
      const value = login();
      mutate(value);
      expect(isHubLogin(value)).toBe(false);
    }
    expect(isHubLogin({ status: "complete" })).toBe(false);
  });
});
