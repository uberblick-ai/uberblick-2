/**
 * The sidebar's two anchored menus (#74): what they say, and what choosing
 * something in them actually changes.
 *
 * Both are driven from stubbed state — a doc count, an identity, a session
 * count — because that is what the components are: a rendering of state the
 * shell already holds. What is worth pinning here is everything a reader could
 * be lied to about.
 *
 * - The switcher renders *configuration*, not accounts: the workspace it is in
 *   with a count that follows the directory, the settings destination enabled,
 *   and machine-owned workspace creation present but disabled.
 * - Each end draws an identity tile (#482) carrying a first character, and the
 *   header's hover carries the whole segment the name truncates. Where the
 *   address names no workspace, neither the letter nor the count is invented.
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
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
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
  root: Root;
  render: (element: ReactElement) => void;
  unmount: () => void;
}

function mount(element: ReactElement): View {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    root,
    render: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** Both surfaces portal themselves to <body>, so they are read from there. */
function panel(selector: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)];
}

function click(element: Element | null | undefined): void {
  act(() => (element as HTMLElement | null | undefined)?.click());
}

beforeEach(() => {
  installStorage();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  document.documentElement.removeAttribute("data-theme");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the workspace switcher renders configuration", () => {
  /** Open from the keyboard: Radix opens on Enter, and jsdom has key events. */
  function open(view: View): void {
    act(() => {
      const trigger = view.host.querySelector<HTMLButtonElement>(".ub-workspace");
      trigger?.focus();
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  }

  function switcher(
    docs: number,
    current: Workspace | null = WORKSPACE,
    onOpenSettings: () => void = () => {},
    active = true,
  ): ReactElement {
    return (
      <WorkspaceSwitcher
        workspaces={[WORKSPACE]}
        current={current}
        names={new Map([[WORKSPACE.uuid, "Uberblick"]])}
        docs={docs}
        onSwitch={() => {}}
        onOpenSettings={onOpenSettings}
        active={active}
      />
    );
  }

  it("shows the workspace with a doc count that follows the directory", () => {
    const view = mount(switcher(2));
    const trigger = view.host.querySelector(".ub-workspace");
    expect(trigger?.textContent).toContain("Uberblick");
    expect(trigger?.textContent).toContain("2 docs");

    // The count is the directory's, live — a document created elsewhere moves it
    // without anybody reopening the menu.
    view.render(switcher(3));
    expect(view.host.querySelector(".ub-workspace")?.textContent).toContain("3 docs");
    // English, not a bare number: one document is "1 doc".
    view.render(switcher(1));
    expect(view.host.querySelector(".ub-workspace")?.textContent).toContain("1 doc");

    open(view);
    const current = panel("[data-slot=dropdown-menu-item][aria-current=true]")[0];
    expect(current?.textContent).toBe("Uberblick1 doc");
    view.unmount();
  });

  it("names the workspace with a tile, a hover title, and nothing invented when there is none", () => {
    // Bare and decorated routes have the same shared name and initial.
    const bare: Workspace = { uuid: WORKSPACE.uuid, segment: WORKSPACE.uuid };
    for (const workspace of [WORKSPACE, bare]) {
      const view = mount(switcher(2, workspace));
      const trigger = view.host.querySelector(".ub-workspace");
      expect(trigger?.querySelector(".ub-workspace-tile")?.textContent).toBe(
        "U",
      );
      // The name truncates, so its whole value is available on the title.
      expect(trigger?.querySelector(".ub-workspace-name")?.getAttribute("title")).toBe(
        "Uberblick",
      );
      view.unmount();
    }

    // No workspace, nothing invented: a letter and a count for a workspace that
    // is not there would both be made up.
    const none = mount(switcher(2, null));
    const trigger = none.host.querySelector(".ub-workspace");
    expect(trigger?.querySelector(".ub-workspace-tile")).toBe(null);
    expect(trigger?.querySelector(".ub-workspace-count")).toBe(null);
    expect(trigger?.querySelector(".ub-workspace-name")?.textContent).toBe("no workspace");
    expect(trigger?.querySelector(".ub-workspace-name")?.hasAttribute("title")).toBe(false);
    expect(trigger?.querySelector(".ub-workspace-caret")).not.toBe(null);
    open(none);
    const settings = panel("[data-slot=dropdown-menu-item]").find(
      (item) => item.textContent === "Workspace settings",
    );
    expect(settings?.hasAttribute("data-disabled")).toBe(true);
    none.unmount();
  });

  it("closes its portalled menu when the document pane becomes inactive", () => {
    const view = mount(switcher(0));
    open(view);
    expect(panel("[data-slot=dropdown-menu-content]")).toHaveLength(1);

    view.render(switcher(0, WORKSPACE, () => {}, false));
    expect(panel("[data-slot=dropdown-menu-content]")).toHaveLength(0);

    // Returning to the document pane must not revive the old open state.
    view.render(switcher(0));
    expect(panel("[data-slot=dropdown-menu-content]")).toHaveLength(0);
    view.unmount();
  });

  it("keeps machine-owned creation disabled and opens workspace settings", () => {
    const onOpenSettings = vi.fn();
    const view = mount(switcher(0, WORKSPACE, onOpenSettings));
    open(view);
    const disabled = panel("[data-slot=dropdown-menu-item][data-disabled]").map(
      (item) => item.textContent,
    );
    expect(disabled).toEqual(["New workspace"]);
    const settings = panel("[data-slot=dropdown-menu-item]").find(
      (item) => item.textContent === "Workspace settings",
    );
    expect(settings?.hasAttribute("data-disabled")).toBe(false);
    click(settings);
    expect(onOpenSettings).toHaveBeenCalledOnce();
    view.unmount();
  });
});

describe("the user menu is this client, as it publishes itself", () => {
  /** The card opens its panel on a click, like any popover trigger. */
  function open(view: View): void {
    click(view.host.querySelector(".ub-user-card"));
  }

  function menu(agentSessions = 0): ReactElement {
    return <UserMenu identity={IDENTITY} agentSessions={agentSessions} />;
  }

  function swatch(name: string): HTMLButtonElement | undefined {
    return panel(`.ub-swatch[aria-label="${name}"]`)[0] as HTMLButtonElement;
  }

  function chosenSwatch(): string | null {
    return panel('.ub-swatch[aria-pressed="true"]')[0]?.getAttribute("aria-label") ?? null;
  }

  function appearanceOption(label: string): HTMLButtonElement | undefined {
    return panel(".ub-appearance-option").find(
      (option) => option.textContent === label,
    ) as HTMLButtonElement | undefined;
  }

  /** The trigger's tile: the letter it draws, and the colour it is filled with. */
  function tile(view: View): HTMLElement | null {
    return view.host.querySelector<HTMLElement>(".ub-user-tile");
  }

  it("names the session and marks the colour it is currently published in", () => {
    const view = mount(menu());
    expect(view.host.querySelector(".ub-user-card")?.textContent).toContain(
      IDENTITY.name,
    );
    // Awareness names are two lowercase words, so the tile is the first of them
    // upper-cased (#482).
    expect(tile(view)?.textContent).toBe("U");
    open(view);
    expect(panel(".ub-user-heading")[0]?.textContent).toBe(IDENTITY.name);
    // The tab's dealt colour is the blue one, and nothing was chosen yet.
    expect(chosenSwatch()).toBe("blue");
    view.unmount();
  });

  it("stores a chosen presence colour, and starts from it after a reload", () => {
    const view = mount(menu());
    open(view);
    // The tile is filled with what this client publishes, so it moves with the
    // choice rather than with a reload.
    expect(tile(view)?.style.background).toBe("rgb(6, 117, 201)");
    click(swatch("green"));

    expect(getSetting("presenceColor")).toBe("#0c853d");
    expect(chosenSwatch()).toBe("green");
    expect(tile(view)?.style.background).toBe("rgb(12, 133, 61)");
    view.unmount();

    // The reload: a new tab, dealt a different colour, reading the same storage.
    const reloaded = mount(
      <UserMenu identity={{ name: "adjacent heron", color: "#cb26b4" }} agentSessions={0} />,
    );
    open(reloaded);
    expect(chosenSwatch()).toBe("green");
    expect(tile(reloaded)?.textContent).toBe("A");
    expect(tile(reloaded)?.style.background).toBe("rgb(12, 133, 61)");
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
    expect(panel(".ub-panel-fact dt").map((row) => row.textContent)).toEqual([
      "MCP connections",
    ]);
    expect(panel(".ub-panel-fact dd")[0]?.textContent).toBe("0");
    view.unmount();
  });

  it("reports the agent sessions it is given", () => {
    const view = mount(menu(2));
    open(view);
    const facts = panel(".ub-panel-fact");
    const connections = facts[facts.length - 1];
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
      view.host.querySelector(".ub-count")?.textContent ?? undefined;
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
