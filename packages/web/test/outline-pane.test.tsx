/** The Contents menu must forget its open state when its last heading leaves. */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, initDoc, setBlockLevel } from "@uberblick/schema";
import type { RoomConnection } from "../src/collab/rooms.js";
import { OutlinePane } from "../src/ui/OutlinePane.js";

it("closes when the last eligible heading disappears and stays closed when it returns", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "outlined", title: "Outlined" });
  const heading = appendBlock(ydoc, { type: "heading", text: "Install", level: 2 });
  const connection = { ydoc } as RoomConnection;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<OutlinePane connection={connection} />));
    const trigger = host.querySelector<HTMLButtonElement>("button");
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("Install");

    await act(async () => setBlockLevel(ydoc, heading, 3));
    expect(host.querySelector("button")).toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();

    await act(async () => setBlockLevel(ydoc, heading, 2));
    expect(host.querySelector("button")?.textContent).toContain("Contents 1");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    ydoc.destroy();
  }
});
