import { expect, it } from "vitest";
import { isLoopbackEndpoint } from "../src/remote-url.js";

it("uses endpoint host only and never treats wildcards as local", () => {
  expect(isLoopbackEndpoint("ws://127.4.3.2:1234/ws")).toBe(true);
  expect(isLoopbackEndpoint("ws://[::1]:1234/ws")).toBe(true);
  expect(isLoopbackEndpoint("wss://example.com/127.0.0.1")).toBe(false);
  expect(isLoopbackEndpoint("ws://0.0.0.0:1234")).toBe(false);
});
