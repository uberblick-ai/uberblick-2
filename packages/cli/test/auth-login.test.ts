import { describe, expect, it } from "vitest";
import { shouldOpenLoginBrowser, shouldPrintClaimCommand } from "../src/auth.js";

const WORKSPACE = "ac77a342-650e-4897-9134-0d8f69a2902e";
const OTHER_WORKSPACE = "88f23f5d-a689-4f0d-8f52-45b020e536fb";

describe("login browser gate", () => {
  it.each([
    [true, {}, true],
    [false, {}, false],
    [undefined, {}, false],
    [true, { SSH_CONNECTION: "remote connection" }, false],
    [true, { SSH_CLIENT: "remote client" }, false],
    [true, { SSH_TTY: "/dev/pts/1" }, false],
    [true, { SSH_TTY: "" }, false],
  ] as const)("opens for stdout terminal=%s and environment=%j: %s", (tty, env, opens) => {
    expect(shouldOpenLoginBrowser(tty, env)).toBe(opens);
  });
});

describe("login claim-command decision", () => {
  it.each([
    [undefined, false, undefined, false],
    [undefined, false, WORKSPACE, false],
    [undefined, false, OTHER_WORKSPACE, false],
    [undefined, true, undefined, false],
    [undefined, true, WORKSPACE, false],
    [undefined, true, OTHER_WORKSPACE, false],
    [WORKSPACE, false, undefined, true],
    [WORKSPACE, false, WORKSPACE, true],
    [WORKSPACE, false, OTHER_WORKSPACE, true],
    [WORKSPACE, true, undefined, true],
    [WORKSPACE, true, WORKSPACE, false],
    [WORKSPACE, true, OTHER_WORKSPACE, true],
  ] as const)("prints for claimed=%s, bound=%s, workspace=%s: %s", (claimed, bound, workspace, prints) => {
    expect(shouldPrintClaimCommand(claimed, { bound, workspace })).toBe(prints);
  });
});
