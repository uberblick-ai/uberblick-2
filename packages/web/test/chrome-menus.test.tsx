/**
 * The sidebar's two anchored menus (#74): what they say, and what choosing
 * something in them actually changes.
 *
 * Both are driven from stubbed state — workspace names, an identity, a session
 * count — because that is what the components are: a rendering of state the
 * shell already holds. What is worth pinning here is everything a reader could
 * be lied to about.
 *
 * - The switcher names the current workspace accessibly, marks the current
 *   menu row and offers no workspace creation item. Settings
 *   remain outside its menu, and neither surface shows a document count.
 * - The workspace marker is decorative. An address with no workspace keeps
 *   the neutral reading and no marker. The footer shows the served hub's
 *   account independently of the tab's generated presence identity.
 * - A presence colour, once chosen, is what the client publishes — and is still
 *   what it publishes after a reload. Whether peers *see* it is a claim about
 *   awareness, and lives in `presence-color.test.ts`.
 * - An appearance choice reaches the document (`data-theme`) and survives a
 *   reload. What that attribute does to the pixels is CSS, and is proved in a
 *   browser (`e2e/chrome.spec.ts`).
 * - "MCP connections" counts agent sessions and nothing else: not this tab, not
 *   another browser tab, and not a session that has gone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { act, render } from "./react-render.js";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type { ReactElement } from "react";
import { WorkspaceSwitcher } from "../src/ui/WorkspaceSwitcher.js";
import { UserMenu } from "../src/ui/UserMenu.js";
import type { AccountIdentity } from "../src/shell/account.js";
import { useAgentSessions } from "../src/ui/hooks.js";
import { applyStoredAppearance } from "../src/ui/theme.js";
import { getSetting } from "../src/settings.js";
import { AGENT_CLIENT, WEB_CLIENT } from "../src/collab/identity.js";
import type { RoomConnection } from "../src/collab/rooms.js";
import type { Workspace } from "../src/ui/route.js";

const WORKSPACE: Workspace = {
  uuid: "6f4c8a51-2b7d-4e39-9a06-c81d3f572be4",
  segment: "uberblick-6f4c8a51-2b7d-4e39-9a06-c81d3f572be4",
};

/** This tab, before anybody picks anything: a name and the colour it was dealt. */
const IDENTITY = { name: "unhurried otter", color: "#0675c9" };

/** jsdom has neither, and Radix's floating surfaces use both. */
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * A fresh in-memory Storage. Node's own experimental `localStorage` global
 * shadows jsdom's here and is unusable without `--localstorage-file`.
 */
function installStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
}

interface View {
  host: HTMLElement;
  render: (element: ReactElement) => void;
  unmount: () => void;
}

function mount(element: ReactElement): View {
  const view = render(element);
  return {
    host: view.container,
    render: view.rerender,
    unmount: view.unmount,
  };
}

function click(element: Element | null | undefined): void {
  act(() => (element as HTMLElement | null | undefined)?.click());
}

beforeEach(() => {
  installStorage();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the workspace switcher renders configuration", () => {
  /** Open from the keyboard: Radix opens on Enter, and jsdom has key events. */
  function open(view: View): void {
    act(() => {
      const trigger = within(view.host).getByRole("button", { name: /^(Uberblick|no workspace)$/ });
      trigger?.focus();
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  }

  function switcher(
    current: Workspace | null = WORKSPACE,
    active = true,
    onOpenChange?: (open: boolean) => void,
  ): ReactElement {
    return (
      <WorkspaceSwitcher
        workspaces={[WORKSPACE]}
        current={current}
        names={new Map([[WORKSPACE.uuid, "Uberblick"]])}
        onSwitch={() => {}}
        active={active}
        onOpenChange={onOpenChange}
      />
    );
  }

  it("names the workspace accessibly without a document-count subtitle", () => {
    const view = mount(switcher());
    const trigger = within(view.host).getByRole("button", { name: "Uberblick" });
    expect(trigger?.textContent).toContain("Uberblick");
    // The native button gets its accessible name from the visible name. No
    // overriding label may replace that name with the old generic "Workspace".
    expect(trigger?.tagName).toBe("BUTTON");
    expect(trigger?.hasAttribute("aria-label")).toBe(false);
    expect(trigger?.hasAttribute("aria-labelledby")).toBe(false);
    expect(within(trigger).queryByText(/\d+ docs?/)).toBeNull();
    expect(trigger?.textContent).not.toMatch(/\d+ docs?/);

    open(view);
    const menu = screen.getByRole("menu");
    const current = within(menu).getByRole("menuitem", { name: "Uberblick", current: true });
    expect(within(current).getByText("Uberblick").textContent).toBe("Uberblick");
    // The check is intentionally decorative, so it has no accessible handle.
    expect(current?.querySelector(".ub-workspace-current")?.textContent).toBe("✓");
    expect(current?.querySelector(".ub-workspace-current")?.getAttribute("aria-hidden"))
      .toBe("true");
    expect(menu.textContent).not.toMatch(/\d+ docs?/);
    view.unmount();
  });

  it("uses a decorative marker for bare and decorated routes, and none without a workspace", () => {
    // Bare and decorated routes have the same shared name.
    const bare: Workspace = { uuid: WORKSPACE.uuid, segment: WORKSPACE.uuid };
    for (const workspace of [WORKSPACE, bare]) {
      const view = mount(switcher(workspace));
      const trigger = within(view.host).getByRole("button", { name: "Uberblick" });
      // Marker and caret are the two intentionally hidden decorations.
      const marker = trigger?.querySelector(".ub-workspace-marker");
      expect(marker?.getAttribute("aria-hidden")).toBe("true");
      expect(marker?.textContent).toBe("");
      expect(trigger.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
      expect(trigger.textContent).toBe("Uberblick▾");
      // The name truncates, so its whole value is available on the title.
      expect(within(trigger).getByText("Uberblick").getAttribute("title")).toBe(
        "Uberblick",
      );
      view.unmount();
    }

    const none = mount(switcher(null));
    const trigger = within(none.host).getByRole("button", { name: "no workspace" });
    // The same marker selector was proved present for both routed spellings.
    expect(trigger.querySelector(".ub-workspace-marker")).toBe(null);
    expect(within(trigger).queryByText(/\d+ docs?/)).toBe(null);
    expect(within(trigger).getByText("no workspace").textContent).toBe("no workspace");
    expect(within(trigger).getByText("no workspace").hasAttribute("title")).toBe(false);
    expect(trigger?.querySelector(".ub-workspace-caret")).not.toBe(null);
    expect(trigger?.querySelector(".ub-workspace-caret")?.getAttribute("aria-hidden"))
      .toBe("true");
    open(none);
    expect(within(screen.getByRole("menu")).queryAllByRole("menuitem", { current: true, hidden: true })).toHaveLength(0);
    none.unmount();
  });

  it("closes its portalled menu when the document pane becomes inactive", () => {
    const onOpenChange = vi.fn();
    const view = mount(switcher(WORKSPACE, true, onOpenChange));
    open(view);
    // These assertions prove unmounting, including any inaccessible remnants.
    expect(screen.getAllByRole("menu", { hidden: true })).toHaveLength(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    view.render(switcher(WORKSPACE, false, onOpenChange));
    expect(screen.queryAllByRole("menu", { hidden: true })).toHaveLength(0);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    // Returning to the document pane must not revive the old open state.
    view.render(switcher(WORKSPACE, true, onOpenChange));
    expect(screen.queryAllByRole("menu", { hidden: true })).toHaveLength(0);
    view.unmount();
  });

  it("offers only workspaces, with no creation placeholder or settings action", () => {
    const view = mount(switcher());
    open(view);
    const menu = within(screen.getByRole("menu"));
    const disabled = menu.getAllByRole("menuitem", { hidden: true }).filter((item) => item.getAttribute("aria-disabled") === "true").map((item) => item.textContent);
    expect(disabled).toEqual([]);
    expect(menu.queryAllByRole("separator", { hidden: true })).toHaveLength(0);
    expect(menu.getAllByRole("menuitem", { hidden: true }).map((item) => item.textContent))
      .toEqual(["Uberblick✓"]);
    const settings = menu.queryByText("Workspace settings");
    expect(settings).toBeNull();
    view.unmount();
  });
});

describe("the account footer keeps this client's presence preferences separate", () => {
  /** The standard identity button opens its preferences panel. */
  function open(view: View): void {
    click(within(view.host).getByRole("button", { name: /; preferences$/ }));
  }

  function menu(agentSessions = 0, account: AccountIdentity = { state: "signed-in", handle: "hub-person" }): ReactElement {
    return <UserMenu identity={IDENTITY} account={account} agentSessions={agentSessions} />;
  }

  function swatch(name: string): HTMLButtonElement {
    return within(screen.getByRole("group", { name: "Presence colour" })).getByRole("button", { name });
  }

  function chosenSwatch(): string | null {
    return within(screen.getByRole("group", { name: "Presence colour" })).getByRole("button", { pressed: true }).getAttribute("aria-label");
  }

  function appearanceOption(label: string): HTMLButtonElement {
    return within(screen.getByRole("group", { name: "Appearance" })).getByRole("button", { name: label });
  }

  it("shows the account in the standard button and keeps Account settings inert", () => {
    const view = mount(menu());
    const trigger = within(view.host).getByRole("button", { name: "@hub-person; preferences" });
    expect(trigger?.textContent).toContain("@hub-person");
    expect(trigger?.textContent).not.toContain(IDENTITY.name);
    expect(trigger?.getAttribute("data-sidebar")).toBe("menu-button");
    expect(trigger?.closest('[data-slot="sidebar-menu-item"]')?.parentElement?.getAttribute("data-slot"))
      .toBe("sidebar-menu");
    const placeholder = within(view.host).getByText("Account settings");
    expect(placeholder?.textContent).toBe("Account settings");
    expect(placeholder?.closest("button, a, [role=button], [role=link]")).toBeNull();
    expect(placeholder?.hasAttribute("tabindex")).toBe(false);
    click(placeholder);
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(0);
    open(view);
    expect(within(screen.getByRole("dialog")).getByText(`Presence name: ${IDENTITY.name}`).textContent).toBe(`Presence name: ${IDENTITY.name}`);
    // The tab's dealt colour is the blue one, and nothing was chosen yet.
    expect(chosenSwatch()).toBe("blue");
    view.unmount();
  });

  it.each([
    [{ state: "signed-out" }, "Not signed in"],
    [{ state: "unavailable" }, "Account unavailable"],
  ] as const)("shows the unverified account state without a presence name", (account, label) => {
    const view = mount(menu(0, account));
    expect(within(view.host).getByRole("button", { name: `${label}; preferences` }).textContent).toContain(label);
    expect(view.host.textContent).not.toContain(IDENTITY.name);
    view.unmount();
  });

  it("retires the portalled panel when the sidebar becomes inactive", () => {
    const view = mount(menu());
    open(view);
    // A retired panel must unmount rather than remain hidden in the portal.
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
    view.render(<UserMenu identity={IDENTITY} agentSessions={0} active={false} />);
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(0);
    view.render(menu());
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(0);
    view.unmount();
  });

  it("stores a chosen presence colour, and starts from it after a reload", () => {
    const view = mount(menu());
    open(view);
    click(swatch("green"));

    expect(getSetting("presenceColor")).toBe("#0c853d");
    expect(chosenSwatch()).toBe("green");
    expect(within(view.host).getByRole("button", { name: "@hub-person; preferences" }).textContent).toContain("@hub-person");
    view.unmount();

    // The reload: a new tab, dealt a different colour, reading the same storage.
    const reloaded = mount(
      <UserMenu identity={{ name: "adjacent heron", color: "#cb26b4" }} agentSessions={0} />,
    );
    open(reloaded);
    expect(chosenSwatch()).toBe("green");
    expect(within(screen.getByRole("dialog")).getByText("Presence name: adjacent heron").textContent).toBe("Presence name: adjacent heron");
    reloaded.unmount();
  });

  it("flips the token set, and remembers which one", () => {
    const view = mount(menu());
    open(view);
    expect(appearanceOption("System")?.getAttribute("aria-pressed")).toBe("true");

    click(appearanceOption("Dark"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(getSetting("appearance")).toBe("dark");
    expect(appearanceOption("Dark")?.getAttribute("aria-pressed")).toBe("true");

    // Back to the system's answer: the attribute is removed rather than set to a
    // guess, so the media query decides again.
    click(appearanceOption("System"));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);

    click(appearanceOption("Light"));
    view.unmount();

    // The reload path is main.tsx's, before React renders anything.
    document.documentElement.removeAttribute("data-theme");
    applyStoredAppearance();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("shows no browser-storage fact even where an estimate is available", async () => {
    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ usage: 2_500_000, quota: 1e9 }) },
    });
    const view = mount(menu());
    open(view);
    await act(async () => {});
    const panel = within(screen.getByRole("dialog"));
    expect(panel.getAllByRole("term", { hidden: true }).map((row) => row.textContent)).toEqual([
      "MCP connections",
    ]);
    expect(panel.getAllByRole("definition", { hidden: true })[0]?.textContent).toBe("0");
    view.unmount();
  });

  it("reports the agent sessions it is given", () => {
    const view = mount(menu(2));
    open(view);
    // Definition-list rows have no role of their own; begin at the visible term.
    const terms = within(screen.getByRole("dialog")).getAllByRole("term", { hidden: true });
    const connections = terms[terms.length - 1]?.parentElement;
    expect(connections?.textContent).toBe("MCP connections2");
    view.unmount();
  });
});

describe("an agent session is one that says it is an agent", () => {
  /** A room, as far as the count is concerned: an awareness map and nothing else. */
  function room(): { connection: RoomConnection; awareness: Awareness } {
    const awareness = new Awareness(new Y.Doc());
    return {
      connection: { provider: { awareness } } as unknown as RoomConnection,
      awareness,
    };
  }

  /** Another session in the room, published the way a real one publishes. */
  function join(
    awareness: Awareness,
    state: Record<string, unknown>,
  ): { leave: () => void } {
    const peer = new Awareness(new Y.Doc());
    peer.setLocalState(state);
    act(() =>
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), "test"),
    );
    return {
      leave: () =>
        act(() => removeAwarenessStates(awareness, [peer.clientID], "test")),
    };
  }

  function Count({ connection }: { connection: RoomConnection }): ReactElement {
    return <span className="ub-count">{useAgentSessions(connection)}</span>;
  }

  it("counts an MCP session while it is connected, and not once it is gone", () => {
    const { connection, awareness } = room();
    awareness.setLocalStateField("user", IDENTITY);
    awareness.setLocalStateField("client", WEB_CLIENT);
    const view = mount(<Count connection={connection} />);
    const counted = (): string | undefined =>
      view.host.textContent ?? undefined;
    expect(counted()).toBe("0");

    // An MCP replica publishes a user and the agent marker beside it
    // (mcp-server's `presenceState`), and it is the marker — not the absence of
    // ours — that makes it countable (#494).
    const agent = join(awareness, {
      user: { name: "claude", color: "#7b5ec7" },
      client: AGENT_CLIENT,
    });
    expect(counted()).toBe("1");

    // Another browser tab says what it is, so it is not one.
    const tab = join(awareness, {
      user: { name: "loitering marmot", color: "#e30c4e" },
      client: WEB_CLIENT,
    });
    expect(counted()).toBe("1");

    // Neither is the MCP server's connectivity probe, which publishes no user
    // at all so that it stays invisible — marker or no marker.
    join(awareness, {});
    join(awareness, { client: AGENT_CLIENT });
    expect(counted()).toBe("1");

    // The conjunction's other half, and the reason it is one: a session that
    // claims nothing is a person until it says otherwise. Under the absence
    // test this read as an agent, which is how a browser tab on an older bundle
    // came to be counted as an MCP connection.
    const silent = join(awareness, {
      user: { name: "unbothered ibex", color: "#0c853d" },
    });
    expect(counted()).toBe("1");

    agent.leave();
    expect(counted()).toBe("0");
    silent.leave();
    tab.leave();
    view.unmount();
  });
});
