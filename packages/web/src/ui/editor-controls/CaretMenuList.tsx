import { Fragment, useEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import { Button } from "../shadcn/button.js";

export interface CaretMenuOption {
  id: string;
  label: string;
  glyph?: ReactNode;
  group?: string;
  hint?: string | null | undefined;
}

/** The editor and plain-text comment pickers share their rows and selection. */
export function CaretMenuList({
  listId, listKey, label, options, active, reveal, highlightAt, choose, empty,
}: {
  listId: string;
  listKey: string;
  label: string;
  options: CaretMenuOption[];
  active: number;
  reveal: boolean;
  highlightAt: (index: number) => void;
  choose: (index: number) => void;
  empty: string;
}): ReactElement {
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Pointer movement must never scroll a different option beneath it.
    if (!reveal) return;
    const box = list.current;
    const option = box?.querySelectorAll<HTMLElement>('[role="option"]')[active];
    if (!box || !option) return;
    const view = box.getBoundingClientRect();
    const rect = option.getBoundingClientRect();
    if (rect.top < view.top) box.scrollTop -= view.top - rect.top;
    else if (rect.bottom > view.bottom) box.scrollTop += rect.bottom - view.bottom;
  }, [active, reveal]);

  if (options.length === 0) {
    return <p className="m-0 p-[0.4rem] text-(--muted-foreground)">{empty}</p>;
  }
  return <div key={listKey} ref={list} id={listId} role="listbox" aria-label={label}
    className="min-h-0 max-h-[17rem] overflow-y-auto">
    {options.map((option, index) => <Fragment key={option.id}>
      {option.group && options[index - 1]?.group !== option.group && (
        <p role="presentation" className="mt-[0.35rem] mb-[0.15rem] px-[0.4rem] ub-type-caption tracking-[0.06em] text-(--muted-foreground) uppercase">
          {option.group}
        </p>
      )}
      <Button variant="plain" size="custom" id={`${listId}-${index}`} type="button" role="option" tabIndex={-1}
        aria-label={option.label} aria-selected={index === active}
        className={`flex w-full items-center gap-2 rounded-(--radius-sm) border px-[0.4rem] py-[0.3rem] text-left ub-type-ui [font-family:inherit] ${index === active ? "border-(--border) bg-(--card-accent) text-(--accent-foreground)" : "border-transparent bg-transparent text-card-foreground"}`}
        // Pick against the prose selection before focus leaves the editor.
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => highlightAt(index)} onClick={() => choose(index)}>
        {option.glyph}
        <span className="min-w-0 flex-1">{option.label}</span>
        {option.hint && <span className="ub-type-small text-(--muted-foreground)">{option.hint}</span>}
      </Button>
    </Fragment>)}
  </div>;
}
