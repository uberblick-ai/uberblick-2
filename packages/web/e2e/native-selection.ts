import { expect } from "@playwright/test";
import type { Locator } from "@playwright/test";
import type { Editor } from "@tiptap/core";

/** Focus reconciliation can overwrite a native range before the editor imports it. */
export async function setNativeSelection(target: Locator, select: () => Promise<void>): Promise<void> {
  await expect.poll(async () => {
    await select();
    return selectionAgrees(target);
  }).toBe(true);
}

/** Wait for selectionchange and compare document positions, not equivalent DOM boundaries. */
async function selectionAgrees(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const root = element.closest(".ProseMirror") as (HTMLElement & { editor: Editor }) | null;
    if (root === null) throw new Error("e2e: selection has no editor");
    const view = root.editor.view;
    const native = document.getSelection();
    if (native?.anchorNode === null || native?.focusNode === null || native === null) return false;
    if (!root.contains(native.anchorNode) || !root.contains(native.focusNode)) return false;
    const anchor = view.posAtDOM(native.anchorNode, native.anchorOffset);
    const head = view.posAtDOM(native.focusNode, native.focusOffset);
    return new Promise<boolean>((resolve) => requestAnimationFrame(() => {
      const current = document.getSelection();
      resolve(current !== null && current.anchorNode !== null && current.focusNode !== null &&
        root.contains(current.anchorNode) && root.contains(current.focusNode) &&
        view.posAtDOM(current.anchorNode, current.anchorOffset) === anchor &&
        view.posAtDOM(current.focusNode, current.focusOffset) === head &&
        view.state.selection.anchor === anchor && view.state.selection.head === head);
    }));
  });
}
