/**
 * Sidebar menus open workspace and personal destinations. Preferences store
 * the browser's collaboration identity.
 *
 * Both are driven from stubbed state — workspace names, an identity, a session
 * count — because that is what the components are: a rendering of state the
 * shell already holds. What is worth pinning here is everything a reader could
 * be lied to about.
 *
 * - The switcher names the current workspace accessibly, marks the current
 *   menu row and shows no document count.
 * - The workspace marker is decorative. An address with no workspace keeps
 *   the neutral reading and no marker.
 * - A presence colour, once chosen, is what the client publishes — and is still
 *   what it publishes after a reload. Whether peers *see* it is a claim about
 *   awareness, and lives in `presence-color.test.ts`.
 * - "MCP connections" counts agent sessions and nothing else: not this tab, not
 *   another browser tab, and not a session that has gone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { act, render } from "./react-render.js";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type { ReactElement } from "react";
import { WorkspaceSwitcher } from "../src/ui/sidebar/WorkspaceSwitcher.js";
import { UserMenu } from "../src/ui/sidebar/UserMenu.js";
import { PreferencesSettings } from "../src/ui/settings/PreferencesSettings.js";
import { useAgentSessions, useSetting } from "../src/ui/hooks.js";
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
    workspaceLocation?: string | null,
    hubProblem = false,
  ): ReactElement {
    return (
      <WorkspaceSwitcher
        workspaces={[WORKSPACE]}
        current={current}
        names={new Map([[WORKSPACE.uuid, "Uberblick"]])}
        onSwitch={() => {}}
        active={active}
        onOpenChange={onOpenChange}
        workspaceLocation={workspaceLocation}
        hubProblem={hubProblem}
      />
    );
  }

  it("names the workspace accessibly without a document-count subtitle", () => {
    const view = mount(switcher());
    const trigger = within(view.host).getByRole("button", { name: "Uberblick" });
    expect(trigger?.textContent).toContain("Uberblick");
    // The native button gets its accessible name from the visible name. No
    // overriding label may replace that name with the generic "Workspace".
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
      expect(trigger.textContent?.trim()).toBe("Uberblick");
      // The name truncates, so its whole value is available on the title.
      expect(within(trigger).getByText("Uberblick").getAttribute("title")).toBe(
        "Uberblick",
      );
      view.unmount();
    }

    const none = mount(switcher(null, true, undefined, "wss://hub.example.test/ws", true));
    const trigger = within(none.host).getByRole("button", { name: "no workspace" });
    // The same marker selector was proved present for both routed spellings.
    expect(trigger.querySelector(".ub-workspace-marker")).toBe(null);
    expect(trigger.querySelector(".ub-workspace-location")).toBe(null);
    expect(trigger.querySelector(".ub-hub-problem")).toBeNull();
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

  it.each([
    ["wss://user:secret@hub.uberblick.ai/private/path?token=hidden#fragment", "hub.uberblick.ai"],
    ["ws://localhost:1234/ws", "localhost:1234"],
    ["local", "This device"],
    [null, null],
    ["not an address", null],
    ["javascript:secret", null],
  ])("names the workspace's location from %s without exposing address details", (address, location) => {
    const view = mount(switcher(WORKSPACE, true, undefined, address, true));
    const trigger = within(view.host).getByRole("button", {
      name: location === null ? "Uberblick" : `Uberblick ${location}`,
    });
    expect(trigger.hasAttribute("aria-label")).toBe(false);
    expect(trigger.hasAttribute("aria-labelledby")).toBe(false);
    expect(trigger.querySelector(".ub-workspace-location")?.textContent ?? null).toBe(location);
    expect(trigger.querySelector(".ub-hub-problem") !== null).toBe(location !== null && address !== "local");
    expect(trigger.textContent).not.toMatch(/secret|private|token|fragment/);
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Uberblick", current: true })).toBeTruthy();
    expect(screen.getByRole("menu").querySelector(".ub-workspace-location")).toBeNull();
    view.unmount();
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
});

describe("the account footer opens personal settings", () => {
  /** Radix opens its command menu from the keyboard. */
  function open(view: View): void {
    fireEvent.keyDown(within(view.host).getByRole("button", { name: /; preferences$/ }), { key: "Enter" });
  }

  it("opens Preferences and Devices from their menu items independently of account availability", () => {
    const preferences = vi.fn();
    const devices = vi.fn();
    const view = mount(<UserMenu account={{ state: "unavailable" }} onOpenPreferences={preferences} onOpenDevices={devices} />);
    open(view);
    fireEvent.click(screen.getByRole("menuitem", { name: "Preferences" }));
    expect(preferences).toHaveBeenCalledOnce();
    open(view);
    fireEvent.click(screen.getByRole("menuitem", { name: "Devices" }));
    expect(devices).toHaveBeenCalledOnce();
    view.unmount();
  });
});

describe("the Preferences page stores this client's choices", () => {
  function swatch(name: string): HTMLButtonElement {
    return within(screen.getByRole("group", { name: "Presence colour" })).getByRole("button", { name });
  }

  function chosenSwatch(): string | null {
    return within(screen.getByRole("group", { name: "Presence colour" })).getByRole("button", { pressed: true }).getAttribute("aria-label");
  }

  it("stores a chosen presence colour, and starts from it after a reload", () => {
    const view = mount(<PreferencesSettings identity={IDENTITY} />);
    click(swatch("green"));

    expect(getSetting("presenceColor")).toBe("#0c853d");
    expect(chosenSwatch()).toBe("green");
    expect(within(view.host).getByText(`How others see you while you edit: ${IDENTITY.name}`)).toBeTruthy();
    view.unmount();

    // The reload: a new tab, dealt a different colour, reading the same storage.
    const reloaded = mount(
      <PreferencesSettings identity={{ name: "adjacent heron", color: "#cb26b4" }} />,
    );
    expect(chosenSwatch()).toBe("green");
    expect((within(reloaded.host).getByRole("textbox", { name: "Presence name" }) as HTMLInputElement).value).toBe("adjacent heron");
    reloaded.unmount();
  });

  it("saves a name only on submission, keeps it after reload, and clears back to the default", () => {
    function Preferences(): ReactElement {
      const chosenName = useSetting("presenceName");
      return <PreferencesSettings identity={{ ...IDENTITY, name: chosenName ?? IDENTITY.name }} />;
    }
    const editName = (name: string): void => {
      fireEvent.change(screen.getByRole("textbox", { name: "Presence name" }), { target: { value: name } });
    };
    const view = mount(<Preferences />);
    editName("  Pat Editor  ");
    expect(getSetting("presenceName")).toBeNull();
    click(screen.getByRole("button", { name: "Save name" }));
    expect(getSetting("presenceName")).toBe("Pat Editor");
    expect((screen.getByRole("textbox", { name: "Presence name" }) as HTMLInputElement).value).toBe("Pat Editor");
    expect(chosenSwatch()).toBe("blue");
    view.unmount();

    const reloaded = mount(<Preferences />);
    expect((screen.getByRole("textbox", { name: "Presence name" }) as HTMLInputElement).value).toBe("Pat Editor");
    editName(" \t ");
    click(screen.getByRole("button", { name: "Save name" }));
    expect(getSetting("presenceName")).toBeNull();
    expect((screen.getByRole("textbox", { name: "Presence name" }) as HTMLInputElement).value).toBe(IDENTITY.name);
    reloaded.unmount();
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
    // ours — that makes it countable.
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
