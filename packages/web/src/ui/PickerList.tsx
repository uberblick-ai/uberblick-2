import { useRef } from "react";
import type { ReactElement, RefObject } from "react";

export interface PickerOption {
  id: string;
  label: string;
  selected: boolean;
  detail?: string;
}

/** Shared option list for the tag and code-language popovers. */
export function PickerList({
  id,
  label,
  options,
  multiple = false,
  onPick,
  empty,
  listRef,
}: {
  id: string;
  label: string;
  options: readonly PickerOption[];
  multiple?: boolean;
  onPick: (id: string) => void;
  empty: string;
  listRef?: RefObject<HTMLDivElement | null>;
}): ReactElement {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const list = listRef ?? ownRef;
  const focusOption = (index: number): void => {
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>("[role='option']");
    if (buttons === undefined || buttons.length === 0) return;
    buttons[(index + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div
      ref={list}
      id={id}
      className={`${multiple ? "ub-tag-options " : ""}ub-picker-options max-h-56 overflow-y-auto p-[0.35rem]`}
      role="listbox"
      aria-multiselectable={multiple || undefined}
      aria-label={label}
    >
      {options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          className={`${multiple ? "ub-tag-option " : ""}ub-picker-option flex w-full cursor-pointer items-center gap-[0.45rem] rounded-(--radius-sm) border-0 bg-transparent px-[0.45rem] py-[0.4rem] text-left text-popover-foreground [font:inherit] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none [@media(pointer:coarse)]:min-h-11`}
          role="option"
          aria-selected={option.selected}
          onClick={() => onPick(option.id)}
          onKeyDown={(event) => {
            const native = event.nativeEvent;
            if (native.isComposing || native.keyCode === 229) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              focusOption(index + 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              focusOption(index - 1);
            } else if (event.key === "Home") {
              event.preventDefault();
              focusOption(0);
            } else if (event.key === "End") {
              event.preventDefault();
              focusOption(options.length - 1);
            }
          }}
        >
          <span
            className={multiple
              ? "ub-tag-check ub-picker-check inline-flex size-4 shrink-0 items-center justify-center rounded-[0.2rem] border border-(--sidebar-muted-foreground)"
              : "ub-picker-check inline-flex size-4 shrink-0 items-center justify-center"}
            aria-hidden="true"
          >
            {option.selected ? "✓" : ""}
          </span>
          <span>{option.label}</span>
          {option.detail !== undefined && (
            <span className={`${multiple ? "ub-tag-retired " : ""}ub-picker-detail ml-auto text-muted-foreground`}>
              {option.detail}
            </span>
          )}
        </button>
      ))}
      {options.length === 0 && (
        <p className={`${multiple ? "ub-tag-empty " : ""}ub-picker-empty m-0 px-2 py-[0.65rem] text-muted-foreground`}>
          {empty}
        </p>
      )}
    </div>
  );
}
