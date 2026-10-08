/** The Contents menu must forget its open state when its last heading leaves. */

import { act, renderSettled } from "./react-render.js";
import { screen, within } from "@testing-library/react";
import { onTestCleanup } from "./test-cleanup.js";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, initDoc, setBlockLevel } from "@uberblick/schema";
import type { RoomConnection } from "../src/collab/rooms.js";
import { OutlinePane } from "../src/ui/OutlinePane.js";

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
  expect(within(host).queryByRole("button", { name: "Contents 1" })).toBeNull();
  expect(screen.queryByRole("menu", { name: "Contents 1" })).toBeNull();

  await act(async () => setBlockLevel(ydoc, heading, 2));
  expect(within(host).queryByRole("button", { name: "Contents 1" })?.textContent).toContain("Contents 1");
  expect(screen.queryByRole("menu", { name: "Contents 1" })).toBeNull();
});
