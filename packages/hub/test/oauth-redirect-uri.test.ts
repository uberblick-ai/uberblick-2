import { describe, expect, it } from "vitest";
import { oauthRedirectUriAllowed } from "../src/oauth-redirect-uri.js";

describe("OAuth redirect URI matching", () => {
  it("matches HTTPS and localhost only by their original strings", () => {
    const https = "https://client.example:443/callback?query=%2F";
    const localhost = "http://localhost:1234/callback";
    expect(oauthRedirectUriAllowed(https, [https])).toBe(true);
    expect(oauthRedirectUriAllowed("https://client.example/callback?query=%2F", [https])).toBe(false);
    expect(oauthRedirectUriAllowed("https://CLIENT.example:443/callback?query=%2F", [https])).toBe(false);
    expect(oauthRedirectUriAllowed("https://client.example:443/callback?query=%2f", [https])).toBe(false);
    expect(oauthRedirectUriAllowed(localhost, [localhost])).toBe(true);
    expect(oauthRedirectUriAllowed("http://LOCALHOST/callback", ["http://LOCALHOST/callback"])).toBe(true);
    expect(oauthRedirectUriAllowed("http://LOCALHOST/callback", ["http://localhost/callback"])).toBe(false);
    expect(oauthRedirectUriAllowed("http://localhost:5678/callback", [localhost])).toBe(false);
    expect(oauthRedirectUriAllowed("http://localhost/callback", [localhost])).toBe(false);
    expect(oauthRedirectUriAllowed("http://localhost:80/callback", ["http://localhost/callback"])).toBe(false);
  });

  it.each(["127.0.0.1", "[::1]"])("allows any optional port only for literal %s", host => {
    const callback = `http://${host}/callback?query=%2F`;
    expect(oauthRedirectUriAllowed(`http://${host}:54321/callback?query=%2F`, [callback])).toBe(true);
    expect(oauthRedirectUriAllowed(callback, [`http://${host}:1234/callback?query=%2F`])).toBe(true);
    expect(oauthRedirectUriAllowed(`http://${host}:54321/callback?query=%2F`, [`http://${host}:1234/callback?query=%2F`])).toBe(true);
    expect(oauthRedirectUriAllowed(`http://${host}:54321/other?query=%2F`, [callback])).toBe(false);
    expect(oauthRedirectUriAllowed(`http://${host}:54321/callback?query=%2f`, [callback])).toBe(false);
    expect(oauthRedirectUriAllowed(`http://${host}:54321/a/../callback?query=%2F`, [callback])).toBe(false);
    expect(oauthRedirectUriAllowed(`HTTP://${host}:54321/callback?query=%2F`, [callback])).toBe(false);
  });

  it.each([
    "http://localhost.example.com/callback", "http://127.0.0.1.example.com/callback",
    "http://127.0.0.2/callback", "http://127.1/callback", "http://0x7f000001/callback",
    "http://2130706433/callback", "http://[0:0:0:0:0:0:0:1]/callback", "http://localhost./callback",
    "http://[::ffff:127.0.0.1]/callback", "http://private.example/callback", "http://192.168.1.1/callback",
    "custom-app:/callback", "javascript:alert(1)", "/callback", "https:///callback",
    "https://client.example/callback#fragment", "https://client.example/callback#",
    "https://user:password@client.example/callback", "https://@client.example/callback",
    "http://user@127.0.0.1/callback", "http://127.0.0.1:/callback", "http://127.0.0.1:65536/callback",
    "http://127.0.0.1\\evil.example/callback", " https://client.example/callback", "https://client.example/call\nback",
  ])("refuses unsupported or ambiguous callback %s even when registered", uri => {
    expect(oauthRedirectUriAllowed(uri, [uri])).toBe(false);
  });

  it("does not normalize an unsupported registered URI into an accepted callback", () => {
    expect(oauthRedirectUriAllowed("http://127.0.0.1:1234/callback", ["http://127.1/callback"])).toBe(false);
    expect(oauthRedirectUriAllowed("http://[::1]:1234/callback", ["http://[0:0:0:0:0:0:0:1]/callback"])).toBe(false);
    expect(oauthRedirectUriAllowed("http://127.0.0.1:1234/callback", ["http://127.0.0.1/a/../callback"])).toBe(false);
    expect(oauthRedirectUriAllowed("https://client.example/callback", ["https://client.example/a/../callback"])).toBe(false);
    expect(oauthRedirectUriAllowed("http://127.0.0.1:1234/callback", ["http://127.0.0.1:/callback"])).toBe(false);
    expect(oauthRedirectUriAllowed("https://client.example/callback", [])).toBe(false);
    expect(oauthRedirectUriAllowed("https://client.example/callback", ["https://other.example/callback", "https://client.example/callback"])).toBe(true);
  });
});
