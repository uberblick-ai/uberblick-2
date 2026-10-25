import { Button } from "../shadcn/button.js";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";
import type * as Y from "yjs";
import { validRevisionName } from "@uberblick/schema";
import { toast } from "sonner";
import { documentRevisionChecksum } from "../../shell/document-revisions.js";
import type { DocumentHistory } from "./document-history.js";
import { TagIcon } from "./history-icons.js";

const INVALID = "Use a name of 1 to 100 characters on one line.";

/** What the open field writes to, fixed when it opens. */
type Target = { kind: "name"; checksum: Promise<string | Error> } | { kind: "rename"; revisionId: string; original: string };

/**
 * A quiet tag icon opens a one-line field in place. Each opening ends exactly
 * once: Enter submits, Escape cancels, and blur submits only a changed,
 * non-empty value that neither of those already settled.
 */
export function RevisionNameControls({ history, liveDocument, writable }: {
  history: DocumentHistory; liveDocument: Y.Doc | null; writable: boolean;
}): ReactElement | null {
  const [target, setTarget] = useState<Target | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settled = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  const refocus = useRef(false);
  const id = useId();
  const entry = history.entry;
  const naming = history.selection === null;
  const allowed = writable && (naming ? liveDocument !== null : entry?.name?.canManage === true);
  const stillTargeted = target === null || (target.kind === "name" ? naming : entry?.id === target.revisionId);
  // Authority or the revision can change while the field is open; it then closes unsaved.
  useEffect(() => {
    if (target !== null && (!allowed || !stillTargeted)) { settled.current = true; setTarget(null); setPending(false); }
  }, [allowed, stillTargeted, target]);
  useEffect(() => { if (target !== null && !pending) field.current?.focus(); }, [target, pending]);
  // The trigger returns in the same render that closes the field.
  useLayoutEffect(() => {
    if (target !== null || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus({ preventScroll: true });
  });
  if (!allowed && target === null) return null;
  const close = (focusTrigger: boolean): void => {
    settled.current = true;
    setTarget(null);
    setError(null);
    refocus.current = focusTrigger;
  };
  const open = (): void => {
    settled.current = false;
    setError(null);
    if (naming && liveDocument !== null) {
      setDraft("");
      // This is the live document behind this control, before later room
      // updates or the local server's replica can change the reviewed state.
      setTarget({ kind: "name", checksum: documentRevisionChecksum(liveDocument)
        .catch(() => new Error("Couldn't read this document's state. Review it and try again.")) });
    } else if (entry?.name != null) {
      setDraft(entry.name.text);
      setTarget({ kind: "rename", revisionId: entry.id, original: entry.name.text });
    }
  };
  const submit = async (): Promise<void> => {
    if (target === null || pending || history.busy) return;
    const text = draft.trim();
    const remove = target.kind === "rename" && text === "";
    if (target.kind === "rename" && text === target.original) { close(true); return; }
    if (!remove && !validRevisionName(text)) { setError(INVALID); return; }
    settled.current = true;
    setPending(true);
    setError(null);
    try {
      if (target.kind === "rename") {
        if (remove) await history.removeName(target.revisionId);
        else await history.rename(target.revisionId, text);
      } else {
        const checksum = await target.checksum;
        if (checksum instanceof Error) throw checksum;
        await history.name(text, checksum);
      }
      close(true);
      toast.success(remove ? "Revision name removed" : target.kind === "name" ? "Revision named" : "Revision name updated");
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "Couldn't change this revision name. Try again.";
      // The typed text stays; the person can retry, edit or press Escape.
      settled.current = false;
      setError(message);
      toast.error(message);
    } finally { setPending(false); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    // Enter that confirms an IME composition is not a submission.
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void submit();
  };
  const onBlur = (): void => {
    if (settled.current || pending || target === null) return;
    const text = draft.trim();
    if (text === "" || (target.kind === "rename" && text === target.original)) close(false);
    else void submit();
  };
  if (target !== null) {
    const label = target.kind === "name" ? "Name current revision" : "Rename revision";
    return <span className="ub-history-naming">
      <TagIcon />
      <input ref={field} className="ub-history-name-field" value={draft} disabled={pending} maxLength={100}
        aria-label="Revision name" title={label} placeholder={target.kind === "name" ? "Name this revision" : "Empty removes the name"}
        aria-invalid={error !== null} aria-describedby={error === null ? undefined : `${id}-error`}
        onChange={event => { setDraft(event.currentTarget.value); setError(null); }} onKeyDown={onKeyDown} onBlur={onBlur} />
      {error !== null && <span id={`${id}-error`} role="alert" className="ub-history-name-error">{error}</span>}
    </span>;
  }
  return <Button variant="history" size="custom" ref={trigger} type="button" className="ub-history-name-trigger opacity-70 data-named:text-(--brand-ink) data-named:opacity-100" disabled={history.busy}
    data-named={naming ? undefined : ""} aria-label={naming ? "Name current revision" : "Rename revision"}
    title={naming ? "Name this revision" : "Rename this revision"} onClick={open}><TagIcon className="text-current" /></Button>;
}
