import { describe, expect, it } from "vitest";
import { parseHubPublicUrl, protectedResourceMetadataUrl, workspaceResourceUrl } from "../src/oauth.js";

const WORKSPACE = "722007fa-8921-45ee-a580-e20311030fef";

describe("HUB_PUBLIC_URL", () => {
  it("allows an unset value", () => {
    expect(parseHubPublicUrl(undefined)).toBeUndefined();
  });

  it.each([
    ["https://hub.example.com", "https://hub.example.com"],
    ["https://hub.example.com/", "https://hub.example.com"],
    ["HTTPS://HUB.EXAMPLE.COM:443/", "https://hub.example.com"],
    ["https://hub.example.com:8443/", "https://hub.example.com:8443"],
    ["http://localhost:8080/", "http://localhost:8080"],
    ["http://127.0.0.1", "http://127.0.0.1"],
    ["http://127.9.8.7:1234/", "http://127.9.8.7:1234"],
    ["http://[::1]:8080/", "http://[::1]:8080"],
  ])("canonicalizes %s to one issuer", (raw, issuer) => {
    expect(parseHubPublicUrl(raw)).toBe(issuer);
    expect(workspaceResourceUrl(issuer, WORKSPACE)).toBe(`${issuer}/mcp/${WORKSPACE}`);
    expect(protectedResourceMetadataUrl(issuer, WORKSPACE))
      .toBe(`${issuer}/.well-known/oauth-protected-resource/mcp/${WORKSPACE}`);
  });

  it.each([
    "", "not-a-url", "http://hub.example.com", "http://0.0.0.0", "http://[::]",
    "http://localhost.example.com", "ftp://hub.example.com", "wss://hub.example.com",
    "https://hub.example.com/path", "https://hub.example.com//", "https://hub.example.com/.",
    "https://hub.example.com/path/..", "https://hub.example.com/%2e",
    "https://hub.example.com?x=1", "https://hub.example.com?", "https://hub.example.com/?",
    "https://hub.example.com#fragment", "https://hub.example.com#",
    "https://user:password@hub.example.com", "https://@hub.example.com",
    "https://hub.example.com:invalid", "https://hub.example.com:65536",
    "https://hub.example.com\\", " https://hub.example.com", "https://hub.example.com ",
    "https://hub.exam\tple.com", "https://hub.example.com\n", "https://hub.example.com\u0000",
  ])("refuses forbidden origin components without echoing %j", raw => {
    expect(() => parseHubPublicUrl(raw)).toThrow(/^HUB_PUBLIC_URL must be/);
    try { parseHubPublicUrl(raw); }
    catch (error) {
      if (raw.length > 0) expect((error as Error).message).not.toContain(raw);
    }
  });
});

it.each([`team-${WORKSPACE}`, WORKSPACE.toUpperCase(), `${WORKSPACE}\n`, "bad-id"])(
  "cannot build a second resource spelling from %j", id => {
    expect(() => workspaceResourceUrl("https://hub.example.com", id)).toThrow(/canonical/);
    expect(() => protectedResourceMetadataUrl("https://hub.example.com", id)).toThrow(/canonical/);
  },
);
