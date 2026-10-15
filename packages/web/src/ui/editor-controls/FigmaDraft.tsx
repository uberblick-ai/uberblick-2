import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { commitFigmaDraft, currentFigmaDraft, discardFigmaDraft } from "../../editor/figma-creation.js";
import type { FigmaDraft as Draft } from "../../editor/figma-creation.js";
import { FigmaFields } from "../../editor/figma-fields.js";

/** React fills the local widget; only a valid submitted link creates a node. */
export function FigmaDraft({ editor }: { editor: Editor }): ReactElement | null {
  const [draft, setDraft] = useState<Draft | null>(() => currentFigmaDraft(editor));
  useEffect(() => {
    const read = (): void => {
      if (!editor.isEditable) discardFigmaDraft(editor);
      setDraft(currentFigmaDraft(editor));
    };
    editor.on("transaction", read);
    editor.on("update", read);
    return () => {
      editor.off("transaction", read);
      editor.off("update", read);
      discardFigmaDraft(editor);
    };
  }, [editor]);
  if (draft === null) return null;
  return createPortal(<>
    <span className="ub-block-caption">
      <span className="ub-block-label">Figma</span>
      <span className="ub-block-actions"><button type="button"
        onClick={() => draft.slot.querySelector("form")?.requestSubmit()}>Done</button></span>
    </span>
    <FigmaFields
      url=""
      title=""
      height=""
      focusLink
      discardInvalid
      saveOnBlur={false}
      onSave={(values) => { commitFigmaDraft(editor, draft, values); }}
      onDone={() => { discardFigmaDraft(editor); if (!editor.isDestroyed) editor.view.focus(); }}
    />
  </>, draft.slot);
}
