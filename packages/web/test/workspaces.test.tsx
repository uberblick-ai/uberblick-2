/**
 * Two workspaces on one hub, as the web client sees them (#151).
 *
 * The client is not multi-tenant and gains nothing here that resembles tenancy.
 * All that is added is a *menu*: the configured list (the served document's,
 * else the build's defines — see `hub-config.test.ts` for where it comes from)
 * names the workspaces this client offers, and picking one navigates. So there
 * are exactly two things worth
 * pinning, and they are the two an agent could break without a test failing
 * anywhere else:
 *
 * 1. **What the list means.** Which entries are workspaces, what a duplicate
 *    spelling of one workspace is, and that the workspace the address names is
 *    always on the menu even when the config forgot it. A list is a place a
 *    typo lives.
 * 2. **That switching is navigating, and nothing else.** No active-workspace
 *    state, no carried-over document — the control writes an address and the
 *    app re-reads it. That is what keeps a switch and a pasted link the same
 *    gesture, and what keeps two corpora from meeting.
 *
 * Deliberately not here: that the two corpora really are disjoint. That is a
 * claim about rooms and the hub, proved in `packages/mcp-server` against a real
 * hub, and in `e2e/deep-link.spec.ts` in a real browser.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { WorkspaceSwitcher } from "../src/ui/WorkspaceSwitcher.js";
import { parseRoute, useRoutePath, workspaceList } from "../src/ui/route.js";
import type { Workspace } from "../src/ui/route.js";

const UBERBLICK_UUID = "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4";
const ABLAUF_UUID = "b2d9e4c7-5a13-4f80-8e6b-71c0a9d35f2e";
const UBERBLICK = `uberblick-${UBERBLICK_UUID}`;
const ABLAUF = `ablauf-${ABLAUF_UUID}`;

/** What the client resolved: the served document's list, else the defines'. */
const CONFIGURED = [UBERBLICK, ABLAUF];

const uberblick: Workspace = { uuid: UBERBLICK_UUID, segment: UBERBLICK };
const ablauf: Workspace = { uuid: ABLAUF_UUID, segment: ABLAUF };

describe("the configured list is a menu, and the address is still the authority", () => {
  it("lists every configured workspace, in the order configured", () => {
    expect(workspaceList(CONFIGURED, uberblick)).toEqual([uberblick, ablauf]);
    // Whitespace around an entry is somebody formatting their config file.
    expect(workspaceList([` ${UBERBLICK} `, ` ${ABLAUF} `], null)).toEqual([
      uberblick,
      ablauf,
    ]);
  });

  it("has no menu when nothing was configured, and still knows where it is", () => {
    // The ordinary single-workspace build: the switcher renders the label it
    // always did rather than a control that can only pick where you are.
    expect(workspaceList([], uberblick)).toEqual([uberblick]);
    expect(workspaceList([], null)).toEqual([]);
  });

  it("drops an entry that is not a workspace id instead of offering it", () => {
    // A menu item that navigates to the invalid-link screen is worse than an
    // item that is not there: the reader would read it as a broken workspace.
    expect(workspaceList(["main", "", ABLAUF, "not-a-uuid"], null)).toEqual([ablauf]);
  });

  it("counts two spellings of one workspace once, keeping the address's own", () => {
    // The slug is display. Both entries name one corpus, and the control has to
    // show the spelling the reader is actually at — otherwise it reads as
    // sitting in a workspace they are not in.
    const bare: Workspace = { uuid: UBERBLICK_UUID, segment: UBERBLICK_UUID };
    expect(workspaceList([UBERBLICK, UBERBLICK_UUID], bare)).toEqual([bare]);
    expect(workspaceList([UBERBLICK, UBERBLICK_UUID], ablauf)).toEqual([
      uberblick,
      ablauf,
    ]);
  });

  it("adds the workspace the address names when the config omits it", () => {
    // Arriving by a link into an unlisted workspace is normal — a link carries
    // its workspace. Showing it is how the reader can tell where they are, and
    // the configured ones are then the way back.
    expect(workspaceList([UBERBLICK], ablauf)).toEqual([uberblick, ablauf]);
  });
});

/**
 * App's wiring for the switcher: the address bar in, a navigation out. The same
 * two calls App makes, so what this drives is the app's own path.
 */
function Probe({ configured }: { configured: readonly string[] }): ReactElement {
  const [path, navigate] = useRoutePath();
  const route = parseRoute(path, null);
  const current = route.kind === "no-workspace" ? null : route.workspace;
  return (
    <WorkspaceSwitcher
      workspaces={workspaceList(configured, current)}
      current={current}
      onSwitch={(segment) => navigate(`/${segment}`)}
    />
  );
}

function switcher(host: HTMLElement): HTMLSelectElement {
  return host.querySelector<HTMLSelectElement>(".ub-workspace") as HTMLSelectElement;
}

function options(host: HTMLElement): string[] {
  return [...host.querySelectorAll("option")].map((option) => option.value);
}

describe("switching workspace is navigating to it", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    window.history.replaceState(null, "", `/${UBERBLICK}`);
  });

  it("lists both workspaces and puts the chosen one in the address bar", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Probe configured={CONFIGURED} />));

    expect(options(host)).toEqual([UBERBLICK, ABLAUF]);
    expect(switcher(host).value).toBe(UBERBLICK);

    act(() => {
      switcher(host).value = ABLAUF;
      switcher(host).dispatchEvent(new Event("change", { bubbles: true }));
    });

    // The address moved, and it is the *list* of the other workspace — not the
    // open document under a new workspace, which would be a link to nowhere.
    expect(window.location.pathname).toBe(`/${ABLAUF}`);
    expect(parseRoute(window.location.pathname, null)).toEqual({
      kind: "list",
      workspace: ablauf,
    });
    expect(switcher(host).value).toBe(ABLAUF);

    act(() => root.unmount());
    host.remove();
  });

  it("keeps the workspace a deep link carries, listed or not", () => {
    // The link is the authority. A build configured for two workspaces must not
    // rewrite an address into one of them.
    const uuid = "3231bff4-2f1c-4a49-9f0a-6f8b2c1d7e55";
    window.history.replaceState(null, "", `/${ABLAUF}/${uuid}`);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Probe configured={[UBERBLICK]} />));

    expect(window.location.pathname).toBe(`/${ABLAUF}/${uuid}`);
    expect(parseRoute(window.location.pathname, null)).toEqual({
      kind: "doc",
      workspace: ablauf,
      uuid,
    });
    // Unconfigured, and still on the menu — with the configured one beside it.
    expect(options(host)).toEqual([UBERBLICK, ABLAUF]);
    expect(switcher(host).value).toBe(ABLAUF);

    act(() => root.unmount());
    host.remove();
  });

  it("shows a label rather than a control when there is nowhere else to go", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Probe configured={[]} />));

    expect(host.querySelector(".ub-workspace")).toBeNull();
    expect(host.textContent).toBe(`workspace ${UBERBLICK}`);

    act(() => root.unmount());
    host.remove();
  });
});
