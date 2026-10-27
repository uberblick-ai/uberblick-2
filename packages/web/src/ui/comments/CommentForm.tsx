/**
 * Enter submits, Shift+Enter inserts a newline and Escape dismisses. The
 * shared mention field takes those keys first while its picker is open.
 */

import { useState } from "react";
import type { ReactElement } from "react";
import type { DocLinkContext } from "../../editor/doc-links.js";
import { Button } from "../shadcn/button.js";
import { CommentMentionField } from "./CommentMentionField.js";

export function CommentForm({
  placeholder,
  submitLabel,
  docLinks = null,
  openDocId = null,
  error,
  draft,
  autoFocus = true,
  hidden = false,
  compact = false,
  onFocus,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  docLinks?: DocLinkContext | null;
  openDocId?: string | null;
  /** A refusal from the last submit, shown above the buttons. */
  error?: string | null;
  /** A reply draft owned outside a modal's mount lifetime. */
  draft?: { text: string; onChange: (text: string) => void };
  /** Remounted reply forms let the pane focus only a new Reply gesture. */
  autoFocus?: boolean;
  hidden?: boolean;
  compact?: boolean;
  onFocus?: (() => void) | undefined;
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
  const body = text.trim();
  const submit = (): void => {
    if (body === "") return;
    if (onSubmit(body)) setText("");
  };

  return (
    <div className={`ub-comment-form${compact ? " ub-comment-form-compact" : ""}`}>
      <CommentMentionField
        autoFocus={autoFocus}
        hidden={hidden}
        placeholder={placeholder}
        text={text}
        setText={setText}
        docLinks={docLinks}
        openDocId={openDocId}
        onSubmit={submit}
        onCancel={onCancel}
        compact={compact}
        onFocus={onFocus}
      />
      {error != null && error !== "" && <p className="ub-comment-error">{error}</p>}
      <div className="ub-comment-buttons">
        {!compact &&
        <Button variant="tool" size="custom" type="button" onClick={onCancel}>
          Cancel
        </Button>}
        <Button variant={compact ? "plain" : "tool"} size="custom"
          type="button"
          data-emphasis={compact ? undefined : "true"}
          aria-label={compact ? submitLabel : undefined}
          className={compact ? "ub-comment-send" : undefined}
          disabled={body === ""}
          onClick={submit}
        >
          {compact ? <span aria-hidden="true">→</span> : submitLabel}
        </Button>
      </div>
    </div>
  );
}
