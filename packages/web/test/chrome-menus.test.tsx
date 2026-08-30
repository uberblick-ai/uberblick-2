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
 *   with a count that follows the directory, and management items that are
 *   present and disabled rather than quietly absent.
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
import { AGENT_CLIENT, WEB_CLIENT } from "../src/collab/rooms.js";
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

  function switcher(docs: number): ReactElement {
    return (
      <WorkspaceSwitcher
        workspaces={[WORKSPACE]}
        current={WORKSPACE}
        docs={docs}
        onSwitch={() => {}}
      />
    );
  }

  it("shows the workspace with a doc count that follows the directory", () => {
    const view = mount(switcher(2));
    const trigger = view.host.querySelector(".ub-workspace");
    expect(trigger?.textContent).toContain(WORKSPACE.segment);
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
    expect(current?.textContent).toBe(`${WORKSPACE.segment}1 doc`);
    view.unmount();
  });

  it("renders workspace management disabled rather than hiding it", () => {
    // A disabled item says "this exists and is not yours to do from here", which
    // is the truth; an absent one says the idea does not exist.
    const view = mount(switcher(0));
    open(view);
    const disabled = panel("[data-slot=dropdown-menu-item][data-disabled]").map(
      (item) => item.textContent,
    );
    expect(disabled).toEqual(["New workspace", "Workspace settings"]);
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

  it("names the session and marks the colour it is currently published in", () => {
    const view = mount(menu());
    expect(view.host.querySelector(".ub-user-card")?.textContent).toContain(
      IDENTITY.name,
    );
    open(view);
    expect(panel(".ub-user-heading")[0]?.textContent).toBe(IDENTITY.name);
    // The tab's dealt colour is the blue one, and nothing was chosen yet.
    expect(chosenSwatch()).toBe("blue");
    view.unmount();
  });

  it("stores a chosen presence colour, and starts from it after a reload", () => {
    const view = mount(menu());
    open(view);
    click(swatch("green"));

    expect(getSetting("presenceColor")).toBe("#0c853d");
    expect(chosenSwatch()).toBe("green");
    view.unmount();

    // The reload: a new tab, dealt a different colour, reading the same storage.
    const reloaded = mount(
      <UserMenu identity={{ name: "adjacent heron", color: "#cb26b4" }} agentSessions={0} />,
    );
    open(reloaded);
    expect(chosenSwatch()).toBe("green");
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

  it("omits the cache row where the browser will not estimate one", async () => {
    vi.stubGlobal("navigator", { storage: undefined });
    const view = mount(menu());
    open(view);
    expect(panel(".ub-panel-fact dt").map((row) => row.textContent)).toEqual([
      "MCP connections",
    ]);
    view.unmount();

    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ usage: 2_500_000, quota: 1e9 }) },
    });
    const estimating = mount(menu());
    open(estimating);
    // The estimate is a promise; the row appears when it answers.
    await act(async () => {});
    expect(panel(".ub-panel-fact dt").map((row) => row.textContent)).toEqual([
      "Local cache",
      "MCP connections",
    ]);
    expect(panel(".ub-panel-fact dd")[0]?.textContent).toBe("2.5 MB");
    estimating.unmount();
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
