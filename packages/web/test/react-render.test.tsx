import { useEffect } from "react";
import { createPortal } from "react-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlock, initDoc } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { mountEditor } from "./helpers.js";
import { render } from "./react-render.js";
import { onTestCleanup } from "./test-cleanup.js";

describe.each(["passing", "failing"] as const)("cleanup after a %s test", (outcome) => {
  let editor: Editor;
  let unmounts = 0;
  let scopeReleases = 0;

  function Tree() {
    useEffect(() => () => { unmounts += 1; }, []);
    return <>{createPortal(<p>Portalled content</p>, document.body)}<p>Mounted content</p></>;
  }

  const mountTest = outcome === "failing" ? it.fails : it;
  mountTest("mounts roots, portals, an editor frame and an open dialog", () => {
    // A same-test unmount/remount remains safe when the hook later cleans all roots.
    render(<p>Before reload</p>).unmount();
    render(<Tree />);

    const ydoc = new Y.Doc();
    initDoc(ydoc, { uuid: "cleanup-fixture", title: "Cleanup" });
    appendBlock(ydoc, { type: "paragraph", text: "Editor content" });
    const mounted = mountEditor(ydoc);
    editor = mounted.editor;
    onTestCleanup(() => ydoc.destroy());

    const frame = document.createElement("div");
    onTestCleanup(() => frame.remove());
    document.body.appendChild(frame);
    frame.appendChild(mounted.element);
    const container = document.createElement("div");
    frame.appendChild(container);
    render(<Tree />, { container });

    expect(document.body.textContent).toContain("Editor content");
    expect(document.body.querySelectorAll("p")).toHaveLength(5);
    render(
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Content onCloseAutoFocus={(event) => {
            event.preventDefault();
            scopeReleases += 1;
          }}>
            <Dialog.Title>Open teardown dialog</Dialog.Title>
            <Dialog.Description>Remains open until shared cleanup.</Dialog.Description>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>,
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(scopeReleases).toBe(0);
    if (outcome === "failing") expect.fail("An assertion aborts the test before teardown");
  });

  it("completes DOM, editor and deferred dialog teardown before the next test", () => {
    expect(document.body.childElementCount).toBe(0);
    expect(editor.isDestroyed).toBe(true);
    expect(unmounts).toBe(2);
    // Radix's deferred unmount callback must finish in the shared hook itself.
    expect(scopeReleases).toBe(1);
  });
});
