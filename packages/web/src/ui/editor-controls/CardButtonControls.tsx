/** The card owns its action slot; prose stays in ProseMirror's contentDOM. */
import { useEffect, useId, useState } from "react";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import {
  CARD_BUTTON_COLORS, CARD_BUTTON_STYLES, isCardButtonHref, parseCardButtons, writeCardButtons,
} from "@uberblick/schema";
import type { CardButton, CardButtonColor, CardButtonStyle } from "@uberblick/schema";
import { yUndoPluginKey } from "y-prosemirror";
import { findBlockById } from "../../editor/block-menu.js";
import { openCardButton } from "../../editor/card-button.js";
import { Button } from "../shadcn/button.js";
import { Input } from "../shadcn/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "../shadcn/popover.js";

function buttonsFromValue(value: unknown): CardButton[] {
  if (typeof value !== "string") return [];
  try { return parseCardButtons(value); } catch { return []; }
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
  const cards: { id: string; slot: Element; buttons: CardButton[] }[] = [];
  editor.state.doc.forEach((node, pos) => {
    if (node.type.name !== "card" || typeof node.attrs.id !== "string") return;
    const dom = editor.view.nodeDOM(pos);
    const slot = dom instanceof HTMLElement ? dom.querySelector(".ub-card-actions") : null;
    if (slot !== null) cards.push({ id: node.attrs.id, slot, buttons: buttonsFromValue(node.attrs.button) });
  });
  return <>{cards.map(({ id, slot, buttons }) => createPortal(
    <CardActions key={id} id={id} editor={editor} buttons={buttons} canWrite={canWrite} />,
    slot,
    id,
  ))}</>;
}

function CardActions({ id, editor, buttons, canWrite }: {
  id: string;
  editor: Editor;
  buttons: CardButton[];
  canWrite: () => boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [href, setHref] = useState("");
  const [style, setStyle] = useState<CardButtonStyle>("outline");
  const [color, setColor] = useState<CardButtonColor>("neutral");
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const writable = editor.isEditable && canWrite();
  useEffect(() => { if (!writable) setOpen(false); }, [writable]);
  const occurrences = new Map<string, number>();
  const keyedButtons = buttons.map((button) => {
    const value = writeCardButtons([button]);
    const occurrence = occurrences.get(value) ?? 0;
    occurrences.set(value, occurrence + 1);
    return { button, key: JSON.stringify([value, occurrence]) };
  });
  const select = (index: number | null): void => {
    const button = index === null ? undefined : buttons[index];
    setSelected(index);
    setSelectedValue(button === undefined ? null : writeCardButtons([button]));
    setText(button?.text ?? "");
    setHref(button?.href ?? "");
    setStyle(button?.style ?? "outline");
    setColor(button?.color ?? "neutral");
    setError(null);
  };
  const change = (button: CardButton | null): void => {
    if (!editor.isEditable || !canWrite()) return;
    const live = findBlockById(editor.state.doc, id);
    if (live?.node.type.name !== "card") return;
    const next = buttonsFromValue(live.node.attrs.button);
    if (selected === null) {
      if (button === null) return;
      next.push(button);
    } else {
      if (next[selected] === undefined) {
        setError("This button was removed. Select another button or add one.");
        return;
      }
      if (writeCardButtons([next[selected]]) !== selectedValue) {
        setError("This button changed while you were editing. Select it again or add one.");
        return;
      }
      if (button === null) next.splice(selected, 1);
      else next[selected] = button;
    }
    const undo = yUndoPluginKey.getState(editor.state)?.undoManager;
    undo?.stopCapturing();
    editor.view.dispatch(editor.state.tr.setNodeMarkup(live.pos, undefined, {
      ...live.node.attrs, button: next.length === 0 ? null : writeCardButtons(next),
    }));
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
    change({ text, href, style, color });
  };
  const remove = (): void => {
    if (!editor.isEditable || !canWrite()) return;
    const live = findBlockById(editor.state.doc, id);
    if (live?.node.type.name !== "card") return;
    const hasFollowing = live.pos + live.node.nodeSize < editor.state.doc.content.size;
    const tr = editor.state.tr.delete(live.pos, live.pos + live.node.nodeSize);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(live.pos, tr.doc.content.size)), hasFollowing ? 1 : -1));
    const undo = yUndoPluginKey.getState(editor.state)?.undoManager;
    undo?.stopCapturing();
    editor.view.dispatch(tr);
    undo?.stopCapturing();
    editor.view.focus();
  };
  return <>
    {keyedButtons.map(({ button, key }) => <Button key={key} type="button"
      variant={button.style === "filled" ? "default" : "outline"}
      className="ub-card-button" data-card-button-style={button.style ?? "outline"}
      data-card-button-color={button.color ?? "neutral"}
      onClick={() => openCardButton(button.href)}>{button.text}</Button>)}
    {writable && <div className="ub-card-edit-controls">
      <Button type="button" variant="outline" size="sm" onClick={remove}>Remove card</Button>
      <Popover open={open} onOpenChange={(next) => {
      if (next && (!editor.isEditable || !canWrite())) return;
      if (next) select(buttons.length === 0 ? null : 0);
      setOpen(next);
    }}>
      <PopoverTrigger asChild><Button type="button" variant="outline" size="sm" className="ub-card-button-edit">{buttons.length === 0 ? "Add button" : "Edit buttons"}</Button></PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw_-_2rem))]! max-h-[min(36rem,calc(100dvh_-_2rem),var(--radix-popover-content-available-height))] overflow-y-auto" align="start" collisionPadding={16}>
        {buttons.length > 0 && <fieldset className="mb-3 grid gap-1" aria-label="Card buttons">
          {keyedButtons.map(({ button, key }, index) => <Button key={key} type="button" variant="selection"
            className="justify-start! whitespace-pre-wrap! text-left! break-words" aria-pressed={selected === index}
            data-state={selected === index ? "on" : "off"} onClick={() => select(index)}>{index + 1}. {button.text}</Button>)}
          <Button type="button" variant="outline" size="sm" onClick={() => select(null)}>Add button</Button>
        </fieldset>}
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <label className="grid gap-1" htmlFor={`${formId}-text`}>Button text<Input id={`${formId}-text`} value={text} onChange={(event) => setText(event.currentTarget.value)} /></label>
          <label className="grid gap-1" htmlFor={`${formId}-href`}>Button destination<Input id={`${formId}-href`} value={href} aria-invalid={error !== null} onChange={(event) => setHref(event.currentTarget.value)} /></label>
          <fieldset className="grid gap-1"><legend className="mb-1">Button style</legend><div className="flex gap-1">
            {CARD_BUTTON_STYLES.map((value) => <Button key={value} type="button" variant="selection"
              aria-pressed={style === value} data-state={style === value ? "on" : "off"}
              onClick={() => setStyle(value)}>{value}</Button>)}
          </div></fieldset>
          <fieldset className="grid gap-1"><legend className="mb-1">Button color</legend><div className="flex flex-wrap gap-1">
            {CARD_BUTTON_COLORS.map((value) => <Button key={value} type="button" variant="selection"
              aria-pressed={color === value} data-state={color === value ? "on" : "off"}
              onClick={() => setColor(value)}>{value}</Button>)}
          </div></fieldset>
          {error !== null && <p role="alert" className="text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="outline">Save button</Button>
            {selected !== null && <Button type="button" variant="outline" onClick={() => change(null)}>Remove button</Button>}
          </div>
        </form>
      </PopoverContent>
      </Popover>
    </div>}
  </>;
}
