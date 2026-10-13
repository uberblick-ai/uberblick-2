import { afterEach, describe, expect, it, vi } from "vitest";
import { FIGMA_PROVIDER } from "../src/providers/figma.js";
import { WEB_CONTENT_SECURITY_POLICY } from "../src/web-policy.js";

afterEach(() => {
  vi.doUnmock("../src/providers/figma.js");
  vi.resetModules();
});

describe("web Content-Security-Policy", () => {
  it("uses the exact policy and keeps accepted-link hosts out of the allowlist", () => {
    expect(WEB_CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self'; connect-src 'self' https://www.figma.com; " +
      "frame-src https://embed.figma.com https://www.figma.com; object-src 'none'; " +
      "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    expect(FIGMA_PROVIDER.hosts).toEqual(["www.figma.com", "figma.com"]);
    expect(WEB_CONTENT_SECURITY_POLICY.split(/[; ]+/)).not.toContain("https://figma.com");
  });

  it("takes frame and connect origins from the provider independently of link hosts", async () => {
    vi.doMock("../src/providers/figma.js", () => ({
      FIGMA_PROVIDER: {
        ...FIGMA_PROVIDER,
        hosts: [...FIGMA_PROVIDER.hosts, "links.example.test"],
        frameOrigins: [...FIGMA_PROVIDER.frameOrigins, "https://frames.example.test"],
        connectOrigins: [...FIGMA_PROVIDER.connectOrigins, "https://api.example.test"],
      },
    }));
    vi.resetModules();
    const { WEB_CONTENT_SECURITY_POLICY: policy } = await import("../src/web-policy.js");
    expect(policy).toContain("connect-src 'self' https://www.figma.com https://api.example.test;");
    expect(policy).toContain("frame-src https://embed.figma.com https://www.figma.com https://frames.example.test;");
    expect(policy).not.toContain("links.example.test");
  });
});
