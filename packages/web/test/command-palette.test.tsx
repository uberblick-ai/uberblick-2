import { fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { CommandPalette } from "../src/ui/CommandPalette.js";
import { act, renderSettled } from "./react-render.js";

const ONE = "00000000-0000-4000-8000-000000000001";
const TWO = "00000000-0000-4000-8000-000000000002";
const entries = [{ uuid: ONE, title: "One", tags: [] }, { uuid: TWO, title: "Two", tags: [] }];

function palette(props: Partial<ComponentProps<typeof CommandPalette>> = {}) {
  return <CommandPalette entries={entries} searchClient={{ search: async () => [] }} writable
    onSelect={() => {}} onCreate={() => {}} {...props} />;
}

async function shortcut(options: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true, ...options });
  await act(async () => document.dispatchEvent(event));
  return event;
}

function searchbox(): HTMLInputElement {
  return within(document.body).getByRole("combobox", { name: "Search documents and decisions" });
}

async function query(text: string): Promise<void> {
  await act(async () => fireEvent.change(searchbox(), { target: { value: text } }));
}

function optionNames(): (string | null)[] {
  return within(document.body).getAllByRole("option").map((option) => option.textContent);
}

afterEach(() => vi.restoreAllMocks());

it("offers only creation until a nonblank query is entered, and clears results on reopening", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  const search = vi.fn(async () => [ONE]);
  await renderSettled(palette({ searchClient: { search } }));
  await shortcut();
  expect(search).not.toHaveBeenCalled();
  expect(optionNames()).toEqual(["Create document"]);
  await query("   ");
  expect(search).not.toHaveBeenCalled();
  expect(optionNames()).toEqual(["Create document"]);
  await query("one");
  expect(optionNames()).toEqual(["OneDocument", "Create document"]);

  await act(async () => fireEvent.keyDown(searchbox(), { key: "Escape" }));
  await shortcut();
  expect(searchbox().value).toBe("");
  expect(optionNames()).toEqual(["Create document"]);
  expect(search).toHaveBeenCalledTimes(1);
});

it.each([null, { search: async () => { throw new Error("index unavailable"); } }])(
  "distinguishes unavailable search from a successful query with no matches",
  async (searchClient) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
    const { rerender } = await renderSettled(palette({ searchClient }));
    await shortcut();
    await query("missing");
    expect(within(document.body).getByRole("status").textContent).toBe("Search is unavailable.");
    expect(document.body.textContent).not.toContain("No documents or decisions match");
    expect(optionNames()).toEqual(["Create document"]);

    await act(async () => rerender(palette({ searchClient: { search: async () => [] } })));
    expect(within(document.body).getByRole("status").textContent).toBe("No documents or decisions match “missing”.");
    expect(document.body.textContent).not.toContain("Search is unavailable");
  },
);

it("rejects stale successes and failures after query or workspace client changes", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  const pending = new Map<string, { resolve: (hits: string[]) => void; reject: (error: Error) => void; signal: AbortSignal }>();
  const client = { search: (text: string, signal: AbortSignal) => new Promise<string[]>((resolve, reject) => {
    pending.set(text, { resolve, reject, signal });
  }) };
  const { rerender } = await renderSettled(palette({ searchClient: client }));
  await shortcut();
  await query("old");
  await query("current");
  expect(pending.get("old")?.signal.aborted).toBe(true);
  await act(async () => pending.get("current")?.resolve([TWO]));
  await act(async () => pending.get("old")?.resolve([ONE]));
  expect(optionNames()).toEqual(["TwoDocument", "Create document"]);

  await query("failed old workspace");
  const nextClient = { search: vi.fn((_text: string, signal: AbortSignal) => new Promise<string[]>((resolve, reject) => {
    pending.set("new workspace", { resolve, reject, signal });
  })) };
  await act(async () => rerender(palette({ searchClient: nextClient })));
  expect(pending.get("failed old workspace")?.signal.aborted).toBe(true);
  expect(optionNames()).toEqual(["Create document"]);
  expect(within(document.body).getByRole("status").textContent).toBe("Searching…");
  await act(async () => pending.get("failed old workspace")?.reject(new Error("old workspace unavailable")));
  expect(within(document.body).getByRole("status").textContent).toBe("Searching…");
  await act(async () => pending.get("new workspace")?.resolve([ONE]));
  expect(optionNames()).toEqual(["OneDocument", "Create document"]);
});

it("keeps Enter from creating while search is pending or creation is disabled", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  const onCreate = vi.fn();
  const onSelect = vi.fn();
  let resolve: ((hits: string[]) => void) | undefined;
  const searchClient = { search: () => new Promise<string[]>((answer) => { resolve = answer; }) };
  const { rerender } = await renderSettled(palette({ writable: false, onCreate, onSelect, searchClient }));
  await shortcut();
  const create = within(document.body).getByRole<HTMLButtonElement>("option", { name: "Create document" });
  expect(create.disabled).toBe(true);
  await act(async () => fireEvent.keyDown(searchbox(), { key: "Enter" }));
  expect(onCreate).not.toHaveBeenCalled();

  await act(async () => rerender(palette({ writable: true, onCreate, onSelect, searchClient })));
  await query("one");
  await act(async () => fireEvent.keyDown(searchbox(), { key: "Enter" }));
  expect(onCreate).not.toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();
  await act(async () => resolve?.([ONE]));
  await act(async () => fireEvent.keyDown(searchbox(), { key: "Enter", isComposing: true }));
  expect(onSelect).not.toHaveBeenCalled();
  await act(async () => fireEvent.keyDown(searchbox(), { key: "Enter" }));
  expect(onSelect).toHaveBeenCalledWith(ONE);
  expect(onCreate).not.toHaveBeenCalled();
});

it.each(["MacIntel", "iPad", "Win32", "Linux"])(
  "uses the platform modifier and ignores composition, repeat and extra modifiers on %s",
  async (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    await renderSettled(palette());
    const apple = platform === "MacIntel" || platform === "iPad";
    const primary = { ctrlKey: !apple, metaKey: apple };
    for (const extra of [
      { ctrlKey: apple, metaKey: !apple }, { shiftKey: true }, { altKey: true },
      { ctrlKey: true, metaKey: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true },
    ]) {
      await shortcut({ ...primary, ...extra });
      expect(within(document.body).queryByRole("dialog")).toBeNull();
    }
    expect((await shortcut(primary)).defaultPrevented).toBe(true);
    expect(within(document.body).getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  },
);
