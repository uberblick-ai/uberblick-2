import { useId, useState } from "react";
import type { ReactElement } from "react";
import type * as Y from "yjs";
import { validRevisionName } from "@uberblick/schema";
import { toast } from "sonner";
import { documentRevisionChecksum } from "../../shell/document-revisions.js";
import { Button } from "../shadcn/button.js";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../shadcn/dialog.js";
import { Input } from "../shadcn/input.js";
import type { DocumentHistory } from "./document-history.js";
import { TagIcon } from "./history-icons.js";

/** A quiet tag icon opens naming beside the revision it names. */
export function RevisionNameControls({ history, liveDocument, writable }: {
  history: DocumentHistory; liveDocument: Y.Doc | null; writable: boolean;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [checksum, setChecksum] = useState<Promise<string | Error> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const entry = history.entry;
  const naming = history.selection === null;
  const manageable = entry?.name?.canManage === true;
  if (!writable || (naming ? liveDocument === null : !manageable)) return null;
  const perform = async (remove: boolean): Promise<void> => {
    if (pending || history.busy || !writable) return;
    setPending(true);
    setError(null);
    try {
      if (!remove && !validRevisionName(draft)) throw new Error("Use a name of 1 to 100 characters on one line.");
      if (remove && entry !== null) await history.removeName(entry.id);
      else if (!naming && entry !== null) await history.rename(entry.id, draft);
      else {
        const captured = await checksum;
        if (captured === null || captured instanceof Error) throw captured ?? new Error("Review this document and try naming it again.");
        await history.name(draft, captured);
      }
      setOpen(false);
      toast.success(remove ? "Revision name removed" : naming ? "Revision named" : "Revision name updated");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't change this revision name. Try again.";
      setError(message);
      toast.error(message);
    } finally { setPending(false); }
  };
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>
      <button type="button" className="ub-history-icon ub-history-name-trigger" disabled={history.busy} data-named={naming ? undefined : ""}
        aria-label={naming ? "Name current revision" : "Rename revision"} title={naming ? "Name this revision" : "Rename this revision"} onClick={() => {
        setDraft(naming ? "" : entry?.name?.text ?? "");
        setError(null);
        // This is the live document behind this control, before later room
        // updates or the local server's replica can change the reviewed state.
        setChecksum(naming && liveDocument !== null ? documentRevisionChecksum(liveDocument)
          .catch(() => new Error("Couldn't read this document's state. Review it and try again.")) : null);
      }}><TagIcon /></button>
    </DialogTrigger>
    <DialogContent className="p-6" aria-describedby={undefined}>
      <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void perform(false); }}>
        <DialogTitle className="m-0 ub-type-h2 font-semibold">{naming ? "Name current revision" : "Rename revision"}</DialogTitle>
        <div className="flex flex-col gap-2">
          <label htmlFor={id} className="font-medium">Revision name</label>
          <Input id={id} value={draft} required disabled={pending}
            aria-invalid={error !== null} aria-describedby={error === null ? undefined : `${id}-error`}
            onChange={event => { setDraft(event.currentTarget.value); setError(null); }} />
          {error !== null && <p id={`${id}-error`} role="alert" className="m-0 ub-type-ui text-destructive">{error}</p>}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {!naming && <Button type="button" variant="secondary" className="mr-auto" disabled={pending || history.busy}
            onClick={() => void perform(true)}>Remove name</Button>}
          <Button type="button" variant="secondary" className="bg-transparent" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" disabled={pending || history.busy}>{naming ? "Name revision" : "Rename"}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
