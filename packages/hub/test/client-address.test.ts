import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { requestClient } from "../src/client-address.js";

function request(address: string | undefined, headers: IncomingHttpHeaders = {}): IncomingMessage {
  return { socket: { remoteAddress: address }, headers } as unknown as IncomingMessage;
}

describe("sign-in client addresses", () => {
  it.each(["127.0.0.1", "10.0.0.2", "198.51.100.4"])("uses the TCP peer %s without the release proxy setting", address => {
    expect(requestClient(request(address, {
      "x-forwarded-for": "203.0.113.5",
      "x-uberblick-peer-address": "203.0.113.6",
    }))).toBe(address);
  });

  it("uses only the release proxy's final forwarded hop and ignores the internal peer header", () => {
    expect(requestClient(request("10.0.0.2", {
      "x-forwarded-for": "203.0.113.5, 198.51.100.4",
      "x-uberblick-peer-address": "203.0.113.6",
    }), true)).toBe("198.51.100.4");
  });

  it.each(["198.51.100.4, invalid", "198.51.100.4, ", "1.2.3", ["198.51.100.4"]])("falls back to the socket for an invalid final forwarded hop %j", forwarded => {
    expect(requestClient(request("10.0.0.2", { "x-forwarded-for": forwarded }), true)).toBe("10.0.0.2");
  });

  it.each(["::ffff:192.0.2.1", "::FFFF:c000:0201", "0:0:0:0:0:ffff:c000:201"])("groups mapped IPv4 address %s with IPv4", address => {
    expect(requestClient(request(address))).toBe("192.0.2.1");
    expect(requestClient(request("10.0.0.2", { "x-forwarded-for": address }), true)).toBe("192.0.2.1");
  });

  it.each(["2001:db8:12:34::1", "2001:0DB8:0012:0034:ffff:ffff:ffff:ffff", "2001:db8:12:34:0:0:192.0.2.1"])("groups IPv6 address %s by /64", address => {
    expect(requestClient(request(address))).toBe("2001:db8:12:34::/64");
  });

  it("expands IPv6 compression before selecting the prefix", () => {
    expect(requestClient(request("2001::1:2:3:4:5:6"))).toBe("2001:0:1:2::/64");
    expect(requestClient(request("2001:db8:12:35::1"))).toBe("2001:db8:12:35::/64");
    expect(requestClient(request("fe80::1%en0"))).toBe("fe80:0:0:0::/64");
    expect(requestClient(request("::192.0.2.1"))).toBe("0:0:0:0::/64");
  });

  it("shares the unknown bucket when the socket supplies no address", () => {
    expect(requestClient(request(undefined, { "x-uberblick-peer-address": "203.0.113.6" }))).toBe("unknown");
  });
});
