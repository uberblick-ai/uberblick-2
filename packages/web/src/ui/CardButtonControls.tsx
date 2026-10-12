/** The card owns its action slot; prose stays in ProseMirror's contentDOM. */
import { useEffect, useId, useState } from "react";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { isCardButtonHref, parseCardButton, writeCardButton } from "@uberblick/schema";
import type { CardButton } from "@uberblick/schema";
import { yUndoPluginKey } from "y-prosemirror";
import { findBlockById } from "../editor/block-menu.js";
import { openCardButton } from "../editor/card-button.js";
import { Button } from "./shadcn/button.js";
import { Input } from "./shadcn/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "./shadcn/popover.js";

function buttonFromValue(value: unknown): CardButton | undefined {
  if (typeof value !== "string") return undefined;
  try { return parseCardButton(value); } catch { return undefined; }
}

export function CardButtonControls({ editor, canWrite }: {
  editor: Editor;
  canWrite: () => boolean;
}): ReactElement {
  const [, tick] = useState(0);
  useEffect(() => {
    const read = (): void => tick((value) => value + 1);
    editor.on("transaction", read);
    editor.on("update", read);
    return () => { editor.off("transaction", read); editor.off("update", read); };
  }, [editor]);
  const cards: { id: string; slot: Element; button: CardButton | undefined }[] = [];
  editor.state.doc.forEach((node, pos) => {
    if (node.type.name !== "card" || typeof node.attrs.id !== "string") return;
    const dom = editor.view.nodeDOM(pos);
    const slot = dom instanceof HTMLElement ? dom.querySelector(".ub-card-actions") : null;
    if (slot !== null) cards.push({ id: node.attrs.id, slot, button: buttonFromValue(node.attrs.button) });
  });
  return <>{cards.map(({ id, slot, button }) => createPortal(
    <CardAction key={id} id={id} editor={editor} button={button} canWrite={canWrite} />,
    slot,
    id,
  ))}</>;
}

function CardAction({ id, editor, button, canWrite }: {
  id: string;
  editor: Editor;
  button: CardButton | undefined;
  canWrite: () => boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [href, setHref] = useState("");
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const writable = editor.isEditable && canWrite();
  useEffect(() => { if (!writable) setOpen(false); }, [writable]);
  const change = (value: string | null): void => {
    if (!editor.isEditable || !canWrite()) return;
    const live = findBlockById(editor.state.doc, id);
    if (live?.node.type.name !== "card") return;
    const undo = yUndoPluginKey.getState(editor.state)?.undoManager;
    undo?.stopCapturing();
    editor.view.dispatch(editor.state.tr.setNodeMarkup(live.pos, undefined, { ...live.node.attrs, button: value }));
    undo?.stopCapturing();
    setOpen(false);
  };
  const save = (): void => {
    if (text.trim() === "" || /[\r\n]/.test(text)) {
      setError("Enter button text on one line.");
      return;
    }
    if (!isCardButtonHref(href)) {
      setError("Use an https:// URL, claude://code/new, claude-cli://open or codex://new, with an optional query.");
      return;
    }
    change(writeCardButton({ text, href }));
  };
  return <>
    {button !== undefined && <Button type="button" variant="outline" className="ub-card-button whitespace-pre-wrap! text-left!" onClick={() => openCardButton(button.href)}>{button.text}</Button>}
    {writable && <Popover open={open} onOpenChange={(next) => {
      if (next && (!editor.isEditable || !canWrite())) return;
      if (next) { setText(button?.text ?? ""); setHref(button?.href ?? ""); setError(null); }
      setOpen(next);
    }}>
      <PopoverTrigger asChild><Button type="button" variant="outline" size="sm" className="ub-card-button-edit">{button === undefined ? "Add button" : "Edit button"}</Button></PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw_-_2rem))]!" align="start">
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <label className="grid gap-1" htmlFor={`${formId}-text`}>Button text<Input id={`${formId}-text`} value={text} onChange={(event) => setText(event.currentTarget.value)} /></label>
          <label className="grid gap-1" htmlFor={`${formId}-href`}>Button destination<Input id={`${formId}-href`} value={href} aria-invalid={error !== null} onChange={(event) => setHref(event.currentTarget.value)} /></label>
          {error !== null && <p role="alert" className="text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="outline">Save button</Button>
            {button !== undefined && <Button type="button" variant="outline" onClick={() => change(null)}>Remove button</Button>}
          </div>
        </form>
      </PopoverContent>
    </Popover>}
  </>;
}
