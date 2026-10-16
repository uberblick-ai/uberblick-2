/** Outline navigation follows live entries and forgets its open state when empty. */

import { act, renderSettled } from "./react-render.js";
import { screen, waitFor, within } from "@testing-library/react";
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
  const trigger = within(host).queryByRole("button", { name: /^On this page/ });
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger?.click();
  });
  expect(screen.queryByRole("navigation", { name: "On this page" })?.textContent).toContain("Install");

  await act(async () => setBlockLevel(ydoc, heading, 3));
  // Nothing stays mounted, even with a changed name or hidden from view.
  expect(within(host).queryByRole("button", { hidden: true })).toBeNull();
  expect(screen.queryByRole("navigation", { hidden: true })).toBeNull();

  await act(async () => setBlockLevel(ydoc, heading, 2));
  expect(within(host).queryByRole("button", { name: /^On this page/ })?.textContent).toContain("On this page");
  expect(screen.queryByRole("navigation", { hidden: true })).toBeNull();
});

it("lists Decisions after headings and offers it alone on a page without headings", async () => {
  const ydoc = new Y.Doc();
  onTestCleanup(() => ydoc.destroy());
  initDoc(ydoc, { uuid: "outlined", title: "Outlined" });
  const connection = { ydoc } as RoomConnection;
  const view = await renderSettled(<OutlinePane connection={connection} decisionsId="decisions-outlined" />);
  await act(async () => within(view.container).getByRole("button", { name: /^On this page/ }).click());
  const navigation = screen.getByRole("navigation", { name: "On this page" });
  expect(within(navigation).getByRole("button", { name: "Decisions" })).toBeDefined();
  await act(async () => appendBlock(ydoc, { type: "heading", text: "Overview", level: 1 }));
  expect(within(navigation).getAllByRole("button").map((item) => item.textContent)).toEqual(["Overview", "Decisions"]);
  expect(within(view.container).getByRole("button", { name: /^On this page/ })).toBeDefined();
});

it("tracks the editor pane when it replaces a waiting pane without changing headings", async () => {
  const ydoc = new Y.Doc();
  onTestCleanup(() => ydoc.destroy());
  initDoc(ydoc, { uuid: "outlined", title: "Outlined" });
  const headingId = appendBlock(ydoc, { type: "heading", text: "Install", level: 2 });
  const shell = document.createElement("main");
  shell.className = "ub-app";
  const waiting = document.createElement("section");
  waiting.className = "ub-document-pane";
  const host = document.createElement("div");
  shell.append(waiting, host);
  document.body.append(shell);
  onTestCleanup(() => shell.remove());
  waiting.getBoundingClientRect = () => new DOMRect(0, 100, 600, 400);
  await renderSettled(<OutlinePane connection={{ ydoc } as RoomConnection} />, { container: host });
  const trigger = within(host).getByRole("button", { name: "On this page" });
  const row = host.querySelector<HTMLElement>(".ub-outline");
  expect(row?.style.getPropertyValue("--outline-title-offset")).toBe("0px");

  const pane = document.createElement("section");
  pane.className = "ub-document-pane";
  pane.getBoundingClientRect = () => new DOMRect(0, 100, 600, 400);
  Object.defineProperties(pane, { clientHeight: { value: 400 }, scrollHeight: { value: 1000 } });
  const title = document.createElement("div");
  title.dataset.outlineTitle = "";
  title.getBoundingClientRect = () => new DOMRect(0, 150 - pane.scrollTop, 600, 40);
  const heading = document.createElement("h2");
  heading.id = headingId;
  heading.textContent = "Install";
  heading.getBoundingClientRect = () => new DOMRect(0, 220 - pane.scrollTop, 600, 30);
  pane.append(title, heading);
  await act(async () => waiting.replaceWith(pane));
  await waitFor(() => expect(row?.style.getPropertyValue("--outline-title-offset")).toBe("50px"));
  expect(trigger.textContent).toBe("On this page");

  await act(async () => {
    pane.scrollTop = 200;
    pane.dispatchEvent(new Event("scroll"));
  });
  await waitFor(() => expect(trigger.textContent).toBe("On this pageInstall"));
  expect(row?.style.getPropertyValue("--outline-title-offset")).toBe("0px");
  await act(async () => {
    pane.scrollTop = 0;
    pane.dispatchEvent(new Event("scroll"));
  });
  await waitFor(() => expect(trigger.textContent).toBe("On this page"));
  expect(row?.style.getPropertyValue("--outline-title-offset")).toBe("50px");
});
