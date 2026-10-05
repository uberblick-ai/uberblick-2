import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserCommand, openBrowser } from "../src/browser.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const URL = "https://github.com/login/device";
const platform = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

afterEach(() => {
  if (platform !== undefined) Object.defineProperty(process, "platform", platform);
});

function opener() {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  const io = { out: vi.fn(), err: vi.fn() };
  return { child, io };
}

describe("shared browser opener", () => {
  it.each(["none", " none "])("BROWSER=%s suppresses opening", (browser) => {
    const { io } = opener();
    expect(browserCommand(URL, { BROWSER: browser })).toBeNull();
    openBrowser(URL, { BROWSER: browser }, io);
    expect(spawn).not.toHaveBeenCalled();
    expect(io.out).not.toHaveBeenCalled();
    expect(io.err).not.toHaveBeenCalled();
  });

  it("passes the URL as one argument to the trimmed BROWSER command", () => {
    expect(browserCommand(URL, { BROWSER: " /path with spaces/browser " })).toEqual({
      command: "/path with spaces/browser", args: [URL],
    });
  });

  it.each([
    ["darwin", "open", [URL]],
    ["win32", "cmd", ["/c", "start", "", URL]],
    ["linux", "xdg-open", [URL]],
  ] as const)("uses the existing %s default for unset or empty BROWSER", (name, command, args) => {
    Object.defineProperty(process, "platform", { value: name, configurable: true });
    for (const browser of [undefined, "", " \t "]) {
      expect(browserCommand(URL, { BROWSER: browser })).toEqual({ command, args });
    }
  });

  it("detaches, ignores stdio and returns without waiting for the child", () => {
    const { child, io } = opener();
    expect(openBrowser(URL, { BROWSER: "recorder" }, io)).toBeUndefined();
    expect(spawn).toHaveBeenCalledExactlyOnceWith("recorder", [URL], {
      stdio: "ignore", detached: true,
    });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.listenerCount("error")).toBe(1);
    expect(io.out).not.toHaveBeenCalled();
    expect(io.err).not.toHaveBeenCalled();
    // The child has not exited. Neither a nonzero exit nor a signal is awaited
    // or diagnosed: this preserves ub open's existing behavior.
    child.emit("exit", 7, null);
    child.emit("exit", null, "SIGTERM");
    expect(io.err).not.toHaveBeenCalled();
  });

  it("warns on stderr for an asynchronous opener error", () => {
    const { child, io } = opener();
    openBrowser(URL, { BROWSER: "missing-opener" }, io);
    child.emit("error", new Error("spawn missing-opener ENOENT"));
    expect(io.err).toHaveBeenCalledExactlyOnceWith(
      "ub: warning: could not open a browser (spawn missing-opener ENOENT)\n",
    );
    expect(io.out).not.toHaveBeenCalled();
  });

  it("preserves synchronous spawn errors for the caller to handle", () => {
    const { io } = opener();
    const failure = new Error("spawn failed synchronously");
    vi.mocked(spawn).mockImplementation(() => { throw failure; });
    expect(() => openBrowser(URL, { BROWSER: "recorder" }, io)).toThrow(failure);
    expect(io.out).not.toHaveBeenCalled();
    expect(io.err).not.toHaveBeenCalled();
  });
});
