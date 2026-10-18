import { expect, it } from "vitest";
import { authenticationOrigin, assertHubTransport, hubTransportProblem, isLoopbackEndpoint, normalizeRemoteUrl } from "../src/remote-url.js";

it("uses endpoint host only and never treats wildcards as local", () => {
  expect(isLoopbackEndpoint("ws://127.4.3.2:1234/ws")).toBe(true);
  expect(isLoopbackEndpoint("ws://[::1]:1234/ws")).toBe(true);
  expect(isLoopbackEndpoint("wss://example.com/127.0.0.1")).toBe(false);
  expect(isLoopbackEndpoint("ws://0.0.0.0:1234")).toBe(false);
});

it.each(["ws://localhost:1234", "http://127.42.3.2:1234", "ws://[::1]:1234", "wss://hub.example/ws"])(
  "allows loopback cleartext and encrypted endpoints: %s", endpoint => {
    expect(hubTransportProblem(endpoint, {})).toBeNull();
  },
);

it.each(["0.0.0.0", "192.168.1.2", "candidate-hub", "hub.example.ts.net", "127.attacker.example", "[::]"])(
  "refuses non-loopback cleartext without rewriting it: %s", host => {
    const endpoint = `ws://${host}:1234/path`;
    expect(normalizeRemoteUrl(endpoint)).toBe(endpoint);
    expect(hubTransportProblem(endpoint, {})).toEqual({
      reason: expect.stringContaining("unencrypted"), fix: `use wss://${host}:1234/path`,
    });
    expect(hubTransportProblem(`http://${host}:1234/path`, {})?.fix).toBe(`use https://${host}:1234/path`);
  },
);

it("permits only exact host and effective port entries from the environment", () => {
  const env = { UB_INSECURE_HUBS: "candidate-hub:1234, other-hub:80" };
  expect(hubTransportProblem("ws://candidate-hub:1234/ws", env)).toBeNull();
  expect(hubTransportProblem("http://other-hub/path", env)).toBeNull();
  for (const endpoint of ["ws://candidate-hub:1235/ws", "ws://child.candidate-hub:1234/ws", "ws://third-hub/ws"]) {
    expect(hubTransportProblem(endpoint, env)).not.toBeNull();
  }
  for (const allow of ["*", "candidate-hub", "ws://candidate-hub:1234", "CANDIDATE-HUB:1234", "candidate-hub:01234"]) {
    expect(hubTransportProblem("ws://candidate-hub:1234/ws", { UB_INSECURE_HUBS: allow })).not.toBeNull();
  }
  expect(authenticationOrigin("ws://candidate-hub:1234")).not.toBe(authenticationOrigin("wss://candidate-hub:1234"));
});

it.each([
  ["ws://hub.example:80/ws\u001b[31m\u0007end", "use wss://hub.example:80/ws%1B[31m%07end"],
  ["http://hub.example:80/ws\nforged", "use https://hub.example:80/wsforged"],
  ["ws://hu\tb.example:443/ws", "use wss://hub.example/ws"],
])("serializes a safe secure-address fix: %j", (endpoint, fix) => {
  const problem = hubTransportProblem(endpoint, {});
  expect(problem?.fix).toBe(fix);
  expect(problem?.fix).not.toMatch(/[\u0000-\u001f\u007f]/);
});

it.each(["ws://private-secret@hub.example", "http://hub.example/?private-secret", "ws://hub.example/#private-secret", "ftp://private-secret"])(
  "validates before including a secure address in a refusal: %s", endpoint => {
    expect(() => assertHubTransport(endpoint, {})).toThrow();
    try { assertHubTransport(endpoint, {}); } catch (error) {
      expect(String(error)).not.toContain("private-secret");
    }
  },
);
