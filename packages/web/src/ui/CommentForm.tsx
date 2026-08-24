/**
 * The one text field comments are written in — a new thread's first comment in
 * the composer, a reply in the rail.
 *
 * Enter submits and Shift+Enter breaks the line: a comment is a message, not a
 * document, and the keyboard should say so. Escape closes, because a card that
 * appeared over the prose has to be dismissible without reaching for the mouse.
 *
 * Mentions are a plain-text convention and nothing else. A chip types `@name`
 * into the comment; no delivery, no registry, no autocomplete — the only names
 * anyone can know are the peers publishing awareness right now, and those are
 * the only chips offered.
 */

import { useRef, useState } from "react";
import type { ReactElement } from "react";

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
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  /** Peer names offered as `@name` chips. */
  mentions?: string[];
  /** A refusal from the last submit, shown above the buttons. */
  error?: string | null;
  /**
   * Called with the trimmed text; never with an empty string. Returns whether
   * the write went through — a refused comment keeps the text in the field,
   * because the writer is about to try it somewhere else and typing it twice is
   * the wrong way to learn that.
   */
  onSubmit: (text: string) => boolean;
  onCancel: () => void;
}): ReactElement {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement | null>(null);
  const body = text.trim();
  const submit = (): void => {
    if (body === "") return;
    if (onSubmit(body)) setText("");
  };

  return (
    <div className="ub-comment-form">
      <textarea
        ref={field}
        className="ub-comment-input"
        rows={2}
        // The form mounts when it opens, so this focuses exactly once, on the
        // gesture that asked for it.
        // biome-ignore lint/a11y/noAutofocus: the form exists only while the writer is writing.
        autoFocus
        placeholder={placeholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
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
            <button
              key={name}
              type="button"
              className="ub-mention"
              // Keep the caret in the field: a chip is a typing shortcut.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setText((current) => withMention(current, name));
                field.current?.focus();
              }}
            >
              @{name}
            </button>
          ))}
        </div>
      )}
      {error != null && error !== "" && <p className="ub-comment-error">{error}</p>}
      <div className="ub-comment-buttons">
        <button type="button" className="ub-tool" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="ub-tool ub-tool-on"
          disabled={body === ""}
          onClick={submit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
