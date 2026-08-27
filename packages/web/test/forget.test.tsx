/**
 * Forgetting one workspace on this device (#198).
 *
 * The contract this file defends is a *data-loss* contract, so it is written
 * from the reader's side of the screen rather than from the module's:
 *
 * - nothing is deleted by a click — the word has to be typed, and dismissing
 *   the confirmation deletes nothing;
 * - the confirmation states the cost before it can be accepted, and where the
 *   browser cannot tell whether edits are un-synced it says "unknown", never
 *   "none" (the two are different claims, and only one of them is safe);
 * - a forget is scoped by the *canonical* room grammar and by the workspace
 *   owning a directory database: another workspace's rooms, an unrelated
 *   database on the same origin, and a name that merely splits like a room name
 *   are all untouched;
 * - the workspace on screen has no forget control at all;
 * - a forget leaves no trace, so the workspace is cached again the moment it is
 *   opened again — the deletion clears a cache, it does not brand a workspace.
 *
 * `indexedDB` is a stand-in, because what is under test is which names this
 * code chooses to delete. `settings.test.tsx` covers the dialog's own chrome
 * (focus trap, Escape) and the Connections section; nothing here repeats it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { SettingsDialog } from "../src/ui/SettingsDialog.js";
import type { Workspace } from "../src/ui/route.js";

/** What `openRoomBacklog` answers — a room is only readable while it is open. */
const backlog = vi.hoisted(() => ({ value: new Map<string, number>() }));

vi.mock("../src/collab/rooms.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/collab/rooms.js")>()),
  openRoomBacklog: () => backlog.value,
}));

const OPEN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";
/** A uuid nothing in this browser ever opened — no `_directory`, so not ours. */
const LOOKALIKE = "44444444-4444-4444-8444-444444444444";

/**
 * The fixture: three workspaces' rooms, plus the three name collisions that
 * separate a room name from a room — a foreign database whose name splits like
 * one but whose document segment is a word, a whole group with no directory
 * database, and a plain database belonging to somebody else's app.
 */
const SEEDED = [
  `${OPEN}/_directory`,
  `${OPEN}/_sidebar`,
  `${OPEN}/aaaaaaaa-0000-4000-8000-000000000001`,
  `${OTHER}/_directory`,
  `${OTHER}/_feedback`,
  `${OTHER}/bbbbbbbb-0000-4000-8000-000000000001`,
  `${OTHER}/bbbbbbbb-0000-4000-8000-000000000002`,
  // Inside a real workspace's group, and still not a room: `parseRoom` splits
  // it happily, and only the canonical grammar refuses it.
  `${OTHER}/not-a-uuid`,
  `${THIRD}/_directory`,
  // A group with no directory database: never a workspace this browser opened,
  // so it is neither listed nor forgettable.
  `${LOOKALIKE}/anything`,
  `${LOOKALIKE}/cccccccc-0000-4000-8000-000000000001`,
  "some-other-app",
];

/** OTHER's room databases — exactly what forgetting OTHER should remove. */
const OTHER_ROOMS = SEEDED.filter(
  (name) => name.startsWith(`${OTHER}/`) && name !== `${OTHER}/not-a-uuid`,
);

/** The databases this origin holds, as the stubbed `indexedDB` sees them. */
let stored: Set<string>;

/** Which of OTHER's rooms are still there. Empty is a completed forget. */
function survivingRooms(): string[] {
  return OTHER_ROOMS.filter((name) => stored.has(name));
}

function installIndexedDB(names: readonly string[]): void {
  stored = new Set(names);
  vi.stubGlobal("indexedDB", {
    databases: async () => [...stored].map((name) => ({ name, version: 1 })),
    deleteDatabase(name: string) {
      const request: Record<string, (() => void) | null> = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      queueMicrotask(() => {
        stored.delete(name);
        request.onsuccess?.();
      });
      return request;
    },
  });
}

/**
 * A fresh in-memory Storage — the settings store reads through to it, and
 * Node's own experimental global is unusable here (see `settings.test.tsx`).
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
  unmount: () => void;
}

/** Open the dialog with `workspace` as the one on screen, and let it read. */
async function openSettings(workspace: Workspace | null): Promise<View> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  await act(async () => {
    root.render(<SettingsDialog workspace={workspace} onClose={() => {}} />);
  });
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function workspaceOf(uuid: string): Workspace {
  return { uuid, segment: uuid };
}

/** The card for one workspace, found by the uuid it names. */
function card(host: HTMLElement, workspaceId: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>(".ub-forget")].find(
    (entry) => entry.querySelector(".ub-forget-name")?.textContent === workspaceId,
  );
  expect(found).toBeDefined();
  return found!;
}

function button(root: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
      entry.textContent?.trim().startsWith(label),
    ) ?? null
  );
}

/** Type into the confirmation field the way a keystroke does. */
function typeInto(input: HTMLInputElement, value: string): void {
  const native = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  native?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Open the confirmation for one workspace and return its field and buttons. */
async function confirmFor(
  view: View,
  workspaceId: string,
): Promise<{ input: HTMLInputElement; submit: HTMLButtonElement }> {
  await act(async () => {
    button(card(view.host, workspaceId), "Forget on this device")?.click();
  });
  const entry = card(view.host, workspaceId);
  const input = entry.querySelector<HTMLInputElement>(".ub-setting-input");
  const submit = button(entry, "Forget this workspace");
  expect(input).not.toBeNull();
  expect(submit).not.toBeNull();
  return { input: input!, submit: submit! };
}

beforeEach(() => {
  backlog.value = new Map();
  installStorage();
  installIndexedDB(SEEDED);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("forgetting a workspace on this device", () => {
  it("names the workspace and deletes nothing until the word is typed", async () => {
    const view = await openSettings(workspaceOf(OPEN));
    const entry = card(view.host, OTHER);
    // What it would remove, named before anything is pressed — documents, not
    // the directory and sidebar caches that travel with them.
    expect(entry.textContent).toContain("2 documents");

    const { input, submit } = await confirmFor(view, OTHER);
    // The gate: no single-click path exists, and a near miss is not the word.
    expect(submit.disabled).toBe(true);
    await act(async () => submit.click());
    expect(stored.size).toBe(SEEDED.length);

    await act(async () => typeInto(input, "forge"));
    expect(button(card(view.host, OTHER), "Forget this workspace")?.disabled).toBe(
      true,
    );
    expect(stored.size).toBe(SEEDED.length);

    await act(async () => typeInto(input, "forget"));
    const armed = button(card(view.host, OTHER), "Forget this workspace");
    expect(armed?.disabled).toBe(false);
    await act(async () => armed?.click());
    expect(survivingRooms()).toEqual([]);
    view.unmount();
  });

  it("deletes only that workspace's rooms, and nothing else on the origin", async () => {
    const view = await openSettings(workspaceOf(OPEN));
    const { input } = await confirmFor(view, OTHER);
    await act(async () => typeInto(input, "forget"));
    await act(async () => {
      button(card(view.host, OTHER), "Forget this workspace")?.click();
    });

    expect([...stored].sort()).toEqual(
      [
        `${OPEN}/_directory`,
        `${OPEN}/_sidebar`,
        `${OPEN}/aaaaaaaa-0000-4000-8000-000000000001`,
        // A name that splits like one of this workspace's rooms and is not one.
        `${OTHER}/not-a-uuid`,
        `${THIRD}/_directory`,
        `${LOOKALIKE}/anything`,
        `${LOOKALIKE}/cccccccc-0000-4000-8000-000000000001`,
        "some-other-app",
      ].sort(),
    );
    view.unmount();
  });

  it("a group with no directory database is neither listed nor forgettable", async () => {
    const view = await openSettings(workspaceOf(OPEN));
    expect(
      [...view.host.querySelectorAll(".ub-forget-name")].map(
        (name) => name.textContent,
      ),
    ).toEqual([OPEN, OTHER, THIRD]);
    view.unmount();
  });

  it("dismissing the confirmation deletes nothing", async () => {
    const view = await openSettings(workspaceOf(OPEN));
    const { input } = await confirmFor(view, OTHER);
    await act(async () => typeInto(input, "forget"));
    await act(async () => {
      button(card(view.host, OTHER), "Cancel")?.click();
    });

    expect(stored.size).toBe(SEEDED.length);
    // And the field is gone, so the typed word cannot be reused by a later click.
    expect(card(view.host, OTHER).querySelector(".ub-setting-input")).toBeNull();
    view.unmount();
  });

  it("the workspace on screen has no forget control", async () => {
    const view = await openSettings(workspaceOf(OPEN));
    const entry = card(view.host, OPEN);
    expect(button(entry, "Forget on this device")).toBeNull();
    expect(entry.textContent).toContain("Open now");
    // The others still have one — the refusal is about this workspace, not a
    // switch that turns the whole section off.
    expect(button(card(view.host, OTHER), "Forget on this device")).not.toBeNull();
    view.unmount();
  });
});

describe("the cost the confirmation states", () => {
  it("says unknown, never none, when it cannot tell whether edits are un-synced", async () => {
    // Nothing open: a cached room carries no readable backlog, and nothing
    // persists an acknowledged watermark, so this browser genuinely cannot say.
    const view = await openSettings(workspaceOf(OPEN));
    await confirmFor(view, OTHER);
    const cost = card(view.host, OTHER).querySelector(".ub-forget-cost")?.textContent;
    expect(cost).toContain("unknown");
    expect(cost).not.toMatch(/\bnone\b/i);
    expect(cost).toContain("nothing recovers them");
    view.unmount();
  });

  it("reports the documents whose updates the hub has not acknowledged", async () => {
    backlog.value = new Map([
      [`${OTHER}/_directory`, 0],
      [`${OTHER}/bbbbbbbb-0000-4000-8000-000000000001`, 2],
      [`${OTHER}/bbbbbbbb-0000-4000-8000-000000000002`, 0],
    ]);
    const view = await openSettings(workspaceOf(OPEN));
    const { input } = await confirmFor(view, OTHER);
    const cost = card(view.host, OTHER).querySelector(".ub-forget-cost")?.textContent;
    expect(cost).toContain("1 of them holds updates the hub has not acknowledged");
    expect(cost).toContain("nothing recovers them");

    // Stated before it can be accepted — and accepting still deletes, because
    // forgetting a workspace with un-synced edits is allowed by decision.
    await act(async () => typeInto(input, "forget"));
    await act(async () => {
      button(card(view.host, OTHER), "Forget this workspace")?.click();
    });
    expect(survivingRooms()).toEqual([]);
    view.unmount();
  });
});

describe("after a forget", () => {
  it("records nothing, so the workspace is cached again when it is opened again", async () => {
    const view = await openSettings(workspaceOf(OPEN));
    const { input } = await confirmFor(view, OTHER);
    await act(async () => typeInto(input, "forget"));
    await act(async () => {
      button(card(view.host, OTHER), "Forget this workspace")?.click();
    });
    expect(
      [...view.host.querySelectorAll(".ub-forget-name")].map(
        (name) => name.textContent,
      ),
    ).toEqual([OPEN, THIRD]);
    view.unmount();

    // Reopening the workspace is an ordinary first visit: the room's replica is
    // created from scratch and hydrates from the hub. Nothing anywhere remembers
    // that it was forgotten, so the workspace simply reappears.
    stored.add(`${OTHER}/_directory`);
    const reopened = await openSettings(workspaceOf(OPEN));
    expect(card(reopened.host, OTHER).textContent).toContain("no documents");
    expect(button(card(reopened.host, OTHER), "Forget on this device")).not.toBeNull();
    reopened.unmount();
  });
});
