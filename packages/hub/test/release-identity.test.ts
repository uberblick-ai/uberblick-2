import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { readReleaseIdentity } from "../src/release-identity.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it("reads the release identity shared by hub startup and operator status", () => {
  const identity = { version: "0.4.7", sourceCommit: "abc123", syncProtocolVersion: 1 };
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(identity));
  expect(readReleaseIdentity()).toEqual(identity);
  expect(readFileSync).toHaveBeenCalledWith("/release/release.json", "utf8");
});

it("leaves checkout startup without release identity", () => {
  vi.mocked(readFileSync).mockImplementation(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  expect(readReleaseIdentity()).toBeUndefined();
});

it("does not hide an unreadable or invalid installed release identity", () => {
  vi.mocked(readFileSync).mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
  expect(() => readReleaseIdentity()).toThrow("denied");
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: "0.4.7" }));
  expect(() => readReleaseIdentity()).toThrow("invalid image release identity");
});
