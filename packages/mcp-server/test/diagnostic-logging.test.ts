import { afterEach, expect, it, vi } from "vitest";
import { log, withLoggingDisabled } from "../src/log.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("writes every diagnostic level to stderr by default", () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

  log.debug("default debug");
  log.info("default info");
  log.warn("default warning");
  log.error("default error");

  expect(stderr.mock.calls).toEqual([
    [expect.stringContaining(" DEBUG uberblick/mcp-server default debug")],
    [expect.stringContaining(" INFO uberblick/mcp-server default info")],
    [expect.stringContaining(" WARN uberblick/mcp-server default warning")],
    [expect.stringContaining(" ERROR uberblick/mcp-server default error")],
  ]);
});

it("mutes an embedded async lifecycle while other callers keep logging", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const quiet = withLoggingDisabled(async () => {
    log.debug("muted debug");
    log.info("muted info");
    await pending;
    log.warn("muted warning");
    log.error("muted error");
    return "completed";
  });

  log.info("concurrent caller");
  release();
  expect(await quiet).toBe("completed");
  log.info("later caller");

  expect(stderr.mock.calls).toEqual([
    [expect.stringContaining(" INFO uberblick/mcp-server concurrent caller")],
    [expect.stringContaining(" INFO uberblick/mcp-server later caller")],
  ]);
});

it("restores logging after a quiet callback fails", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(withLoggingDisabled(async () => {
    await Promise.resolve();
    log.error("muted failure");
    throw new Error("callback failed");
  })).rejects.toThrow("callback failed");
  log.error("next command");

  expect(stderr).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining(" ERROR uberblick/mcp-server next command"),
  );
});
