/**
 * Enter submits, Shift+Enter inserts a newline and Escape dismisses. Peer
 * chips append plain-text @name from current awareness only; they provide no
 * delivery, registry or autocomplete.
 */

import { useRef, useState } from "react";
import type { ReactElement } from "react";
import { Button } from "../shadcn/button.js";
import { Textarea } from "../shadcn/textarea.js";

/** `@name`, appended to `text` with a separating space where one is needed. */
export function withMention(text: string, name: string): string {
  const separator = text === "" || text.endsWith(" ") || text.endsWith("\n") ? "" : " ";
  return `${text}${separator}@${name} `;
}

export function CommentForm({
  placeholder,
  submitLabel,
  mentions = [],
  error,
  draft,
  autoFocus = true,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  /** Peer names offered as `@name` chips. */
  mentions?: string[];
  /** A refusal from the last submit, shown above the buttons. */
  error?: string | null;
  /** A reply draft owned outside a modal's mount lifetime. */
  draft?: { text: string; onChange: (text: string) => void };
  /** Remounted reply forms let the pane focus only a new Reply gesture. */
  autoFocus?: boolean;
  /**
   * Submit trimmed nonempty text. A refused write returns false and preserves
   * the draft.
   */
  onSubmit: (text: string) => boolean;
  onCancel: () => void;
}): ReactElement {
  const [localText, setLocalText] = useState("");
  const text = draft?.text ?? localText;
  const setText = draft?.onChange ?? setLocalText;
  const field = useRef<HTMLTextAreaElement | null>(null);
  const body = text.trim();
  const submit = (): void => {
    if (body === "") return;
    if (onSubmit(body)) setText("");
  };

  return (
    <div className="ub-comment-form">
      <Textarea
        ref={field}
        // Keep the floating card's measured height stable above its selection.
        // Replies in the rail can grow and resize with their content.
        className="ub-comment-input resize-y in-[.ub-composer]:max-h-16 in-[.ub-composer]:resize-none"
        rows={2}
        // New-comment composers focus on opening; reply forms can also remount
        // on a resize, so their pane owns the initial focus gesture instead.
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Safari can deliver the confirming key after compositionend, with
          // isComposing already false but the IME keyCode still set.
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      {mentions.length > 0 && (
        <div className="ub-mentions">
          {mentions.map((name) => (
            <Button variant="plain" size="custom"
              key={name}
              type="button"
              className="rounded-(--radius-sm) border border-(--border) bg-secondary px-[0.3rem] py-0 ub-type-caption text-secondary-foreground in-[.ub-composer]:bg-(--card-accent)"
              // Keep the caret in the field: a chip is a typing shortcut.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setText(withMention(text, name));
                field.current?.focus();
              }}
            >
              @{name}
            </Button>
          ))}
        </div>
      )}
      {error != null && error !== "" && <p className="ub-comment-error">{error}</p>}
      <div className="ub-comment-buttons">
        <Button variant="tool" size="custom" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="tool" size="custom"
          type="button"
          data-emphasis="true"
          disabled={body === ""}
          onClick={submit}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
