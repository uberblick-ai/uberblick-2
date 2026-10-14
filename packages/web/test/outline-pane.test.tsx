/** The Contents menu must forget its open state when its last heading leaves. */

import { act, renderSettled } from "./react-render.js";
import { screen, within } from "@testing-library/react";
import { onTestCleanup } from "./test-cleanup.js";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, initDoc, setBlockLevel } from "@uberblick/schema";
import type { RoomConnection } from "../src/collab/rooms.js";
import { OutlinePane } from "../src/ui/document/OutlinePane.js";

it("closes when the last eligible heading disappears and stays closed when it returns", async () => {
  const ydoc = new Y.Doc();
  onTestCleanup(() => ydoc.destroy());
  initDoc(ydoc, { uuid: "outlined", title: "Outlined" });
  const heading = appendBlock(ydoc, { type: "heading", text: "Install", level: 2 });
  const connection = { ydoc } as RoomConnection;
  const { container: host } = await renderSettled(<OutlinePane connection={connection} />);
  const trigger = within(host).queryByRole("button", { name: "Contents 1" });
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(screen.queryByRole("menu", { name: "Contents 1" })?.textContent).toContain("Install");

  await act(async () => setBlockLevel(ydoc, heading, 3));
  // Nothing stays mounted, even with a changed name or hidden from view.
  expect(within(host).queryByRole("button", { hidden: true })).toBeNull();
  expect(screen.queryByRole("menu", { hidden: true })).toBeNull();

  await act(async () => setBlockLevel(ydoc, heading, 2));
  expect(within(host).queryByRole("button", { name: "Contents 1" })?.textContent).toContain("Contents 1");
  expect(screen.queryByRole("menu", { hidden: true })).toBeNull();
});

it("counts Decisions after headings and offers it alone on a page without headings", async () => {
  const ydoc = new Y.Doc();
  onTestCleanup(() => ydoc.destroy());
  initDoc(ydoc, { uuid: "outlined", title: "Outlined" });
  const connection = { ydoc } as RoomConnection;
  const view = await renderSettled(<OutlinePane connection={connection} decisionsId="decisions-outlined" />);
  const open = async (count: number): Promise<void> => {
    await act(async () => within(view.container).getByRole("button", { name: `Contents ${count}` })
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  };
  await open(1);
  expect(screen.getByRole("menuitem", { name: "Decisions" })).toBeDefined();
  await act(async () => appendBlock(ydoc, { type: "heading", text: "Overview", level: 1 }));
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Overview", "Decisions"]);
  expect(within(view.container).getByRole("button", { name: "Contents 2" })).toBeDefined();
});
