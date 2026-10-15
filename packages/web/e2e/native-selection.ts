import { expect } from "@playwright/test";
import type { Locator } from "@playwright/test";
import type { Editor } from "@tiptap/core";

type SelectionTarget = { anchor: number; head: number };

/**
 * Focus reconciliation can overwrite a native range before the editor imports it.
 * A scripted range returns its positions; only real pointer input may return none.
 */
export async function setNativeSelection(target: Locator, select: () => Promise<void> | Promise<SelectionTarget>): Promise<void> {
  await expect.poll(async () => {
    const expected = await select();
    return selectionAgrees(target, typeof expected === "object" ? expected : undefined);
  }).toBe(true);
}

/** Wait for selectionchange and compare document positions, not equivalent DOM boundaries. */
async function selectionAgrees(target: Locator, expected: SelectionTarget | undefined): Promise<boolean> {
  return target.evaluate((element, expected) => {
    const root = element.closest(".ProseMirror") as (HTMLElement & { editor: Editor }) | null;
    if (root === null) throw new Error("e2e: selection has no editor");
    const view = root.editor.view;
    const native = document.getSelection();
    if (native?.anchorNode === null || native?.focusNode === null || native === null) return false;
    if (!root.contains(native.anchorNode) || !root.contains(native.focusNode)) return false;
    // A caller's requested positions cannot be replaced by a stale native
    // range that focus reconciliation restored before this evaluation.
    const anchor = expected?.anchor ?? view.posAtDOM(native.anchorNode, native.anchorOffset);
    const head = expected?.head ?? view.posAtDOM(native.focusNode, native.focusOffset);
    return new Promise<boolean>((resolve) => requestAnimationFrame(() => {
      const current = document.getSelection();
      resolve(current !== null && current.anchorNode !== null && current.focusNode !== null &&
        root.contains(current.anchorNode) && root.contains(current.focusNode) &&
        view.posAtDOM(current.anchorNode, current.anchorOffset) === anchor &&
        view.posAtDOM(current.focusNode, current.focusOffset) === head &&
        view.state.selection.anchor === anchor && view.state.selection.head === head);
    }));
  }, expected);
}
