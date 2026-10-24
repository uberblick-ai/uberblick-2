import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { decisionTopicTitle, getBlocksFragment, getMeta, parseRoom, resolveDecisionTopics } from "@uberblick/schema";
import { alteredDecisionAnswerProblem, createDecisionDraft, recordAlteredDecision } from "../../collab/alter-decision.js";
import type { AlterDecisionResult } from "../../collab/alter-decision.js";
import type { AwarenessUser } from "../../collab/identity.js";
import type { RoomConnection } from "../../collab/rooms.js";
import { bindGuardedEditor } from "../../editor/guarded-binding.js";
import { findForeignBlocks } from "../../editor/palette.js";
import { docLinkFromTarget } from "../../editor/doc-links.js";
import type { DocLinkContext } from "../../editor/doc-links.js";
import { DECISION_ANSWER_MENU_ENTRIES } from "../../editor/block-menu.js";
import { BlockMenu } from "../editor-controls/BlockMenu.js";
import { MentionMenu } from "../editor-controls/MentionMenu.js";
import { EmojiMenu } from "../editor-controls/EmojiMenu.js";
import { CodeLanguageControl } from "../editor-controls/CodeLanguageControl.js";
import { TableControls } from "../editor-controls/TableControls.js";
import { EditorControlsHost, editorControlsOwnEscape } from "../editor-controls/EditorControlsHost.js";
import { CommentComposer } from "../comments/CommentComposer.js";
import { DialogContent, DialogTitle } from "../shadcn/dialog.js";
import { Button } from "../shadcn/button.js";
import { useDirectory, useRoomStatus } from "../hooks.js";

export interface AlterDecisionSession {
  source: RoomConnection;
  directory: RoomConnection;
  catalog: RoomConnection;
  identity: AwarenessUser;
  topicPath: string;
  segment: string;
  cancellation: AbortController;
  release(): void;
}

export type RecordedDecision = Extract<AlterDecisionResult, { ok: true }>;

function answerProblem(draft: Y.Doc): string | null {
  const fragment = getBlocksFragment(draft);
  const foreign = findForeignBlocks(fragment);
  if (foreign.length > 0) return `This client cannot edit these answer types: ${[...new Set(foreign.map((block) => block.nodeName))].join(", ")}. Neither action is available.`;
  const problem = alteredDecisionAnswerProblem(draft);
  if (problem === null) return null;
  if (problem.code === "decision_block_unsupported") return `Remove unsupported answer blocks: ${problem.blockTypes.join(", ")}. Use paragraphs, lists, code blocks or tables.`;
  if (problem.code === "decision_answer_too_long") {
    return "Shorten the answer to at most three blocks; adjacent list items count as one block.";
  }
  return "Write a non-blank new answer.";
}

function AnswerEditor({ draft, readOnly = false, session, docLinks, displayName, waiting, onEditor }: {
  draft: Y.Doc; readOnly?: boolean; session: AlterDecisionSession;
  docLinks: DocLinkContext | null; displayName: string; waiting: boolean;
  onEditor?: (editor: Editor | null) => void;
}): ReactElement {
  const host = useRef<HTMLDivElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const binding = bindGuardedEditor({
      element, fragment: getBlocksFragment(draft),
      editable: !readOnly, canWrite: () => !readOnly, canNormalize: () => false,
      blockMenuEntries: DECISION_ANSWER_MENU_ENTRIES,
      docLinks, workspaceSettings: session.catalog.ydoc,
      onUnbind: () => { setEditor(null); onEditor?.(null); },
    });
    binding.editor?.setOptions({ editorProps: { attributes: { "aria-label": readOnly ? "Current answer" : "New answer" } } });
    setEditor(binding.editor);
    onEditor?.(binding.editor);
    // References in either detached answer must not navigate away from an unsaved draft.
    const preventNavigation = (event: MouseEvent): void => {
      if (docLinkFromTarget(event.target) !== null) event.preventDefault();
    };
    element.addEventListener("click", preventNavigation);
    return () => {
      element.removeEventListener("click", preventNavigation);
      setEditor(null); onEditor?.(null); binding.destroy();
    };
  }, [draft, readOnly, session, docLinks, onEditor]);
  useEffect(() => { editor?.setEditable(!readOnly && !waiting); }, [editor, readOnly, waiting]);
  return <div className={`ub-alter-answer${readOnly ? " ub-alter-current" : ""}`}>
    <div className="ub-editor-frame" ref={frame}>
      <div ref={host} className="ub-editor" />
      {editor !== null && !readOnly && !waiting && <>
        <CodeLanguageControl editor={editor} canWrite={() => editor.isEditable} />
        <BlockMenu editor={editor} host={frame} entries={DECISION_ANSWER_MENU_ENTRIES} />
        <TableControls editor={editor} host={frame} />
        <MentionMenu editor={editor} host={frame} docLinks={docLinks} openDocId={parseRoom(session.source.room).uuid} />
        <EmojiMenu editor={editor} host={frame} />
        <CommentComposer editor={editor} ydoc={draft} author={displayName} mentions={[]} host={frame}
          onCreated={() => {}} formattingOnly />
      </>}
    </div>
  </div>;
}

export function AlterDecisionDialog({ session, displayName, docLinks, onClose, onRecorded }: {
  session: AlterDecisionSession; displayName: string; docLinks: DocLinkContext | null;
  onClose(): void; onRecorded(result: RecordedDecision): void;
}): ReactElement {
  const [drafts] = useState(() => {
    try { return { current: createDecisionDraft(session.source.ydoc), next: createDecisionDraft(session.source.ydoc), error: null }; }
    catch { return { current: null, next: null, error: "This client cannot copy an unsupported answer type. Neither action is available." }; }
  });
  const [boundary, setBoundary] = useState<HTMLDivElement | null>(null);
  const [draftEditor, setDraftEditor] = useState<Editor | null>(null);
  const [problem, setProblem] = useState(() => drafts.next === null ? drafts.error : answerProblem(drafts.next));
  const [failure, setFailure] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const catalogStatus = useRoomStatus(session.catalog);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      operation.current?.abort();
      drafts.current?.destroy();
      drafts.next?.destroy();
    };
  }, [drafts]);
  useEffect(() => {
    const draft = drafts.next;
    if (draft === null) return;
    const refresh = (): void => setProblem(answerProblem(draft));
    draft.on("update", refresh);
    return () => draft.off("update", refresh);
  }, [drafts]);
  const close = (): void => { operation.current?.abort(); onClose(); };
  const submit = async (mode: "decide" | "rfc"): Promise<void> => {
    if (operation.current !== null || drafts.next === null || !catalogStatus.synced) return;
    const controller = session.cancellation;
    operation.current = controller;
    setFailure(null);
    setWaiting(true);
    try {
      const result = await recordAlteredDecision({
        source: session.source, directory: session.directory, draft: drafts.next,
        identity: session.identity, mode, displayName,
        tagCatalog: session.catalog.ydoc, signal: controller.signal,
      });
      if (result.ok) onRecorded(result);
      else if (alive.current && !controller.signal.aborted) setFailure(result.message);
    } catch {
      if (alive.current && !controller.signal.aborted) setFailure("The change could not be recorded. Try again.");
    } finally {
      operation.current = null;
      if (alive.current) setWaiting(false);
    }
  };
  const disabled = problem !== null || waiting || !catalogStatus.synced;
  const entries = useDirectory(session.directory, true);
  const sourceMeta = getMeta(session.source.ydoc, parseRoom(session.source.room).uuid);
  const topic = resolveDecisionTopics(entries).find((entry) => entry.topic === sourceMeta.topic);
  const topicTitle = topic === undefined ? sourceMeta.title : decisionTopicTitle(topic);
  return <DialogContent ref={setBoundary} className="ub-alter-dialog" aria-describedby="alter-decision-topic"
      onEscapeKeyDown={(event) => { if (editorControlsOwnEscape(boundary, event, draftEditor)) event.preventDefault(); }}>
      <EditorControlsHost value={{ portalContainer: boundary, boundary }}>
        <DialogTitle className="ub-alter-title">Alter decision</DialogTitle>
        <p id="alter-decision-topic" className="ub-alter-topic">{topicTitle}</p>
        <div className="ub-alter-fields">
          <p className="ub-alter-label">Current answer</p>
          {drafts.current !== null && <AnswerEditor draft={drafts.current} readOnly session={session} docLinks={docLinks} displayName={displayName} waiting={waiting} />}
          <p className="ub-alter-label" id="alter-new-answer">New answer</p>
          {drafts.next !== null && <AnswerEditor draft={drafts.next} session={session} docLinks={docLinks} displayName={displayName} waiting={waiting} onEditor={setDraftEditor} />}
          {problem !== null && <p className="ub-alter-error" role="status">{problem}</p>}
          {failure !== null && <p className="ub-alter-error" role="alert">{failure}</p>}
          {waiting && <p role="status">Waiting for the new rooms to synchronize. You can still cancel.</p>}
          {!catalogStatus.synced && <p role="status">Waiting for workspace settings to synchronize.</p>}
        </div>
        <div className="ub-alter-footer">
          <Button variant="outline" disabled={disabled} onClick={() => { void submit("rfc"); }}>Open an RFC instead</Button>
          <p className="ub-alter-hint">Decide puts the answer in force now under {displayName.trim() || "your display name (set one first)"}.</p>
          <Button variant="secondary" className="bg-transparent" onClick={close}>Cancel</Button>
          <Button disabled={disabled || displayName.trim() === ""} onClick={() => { void submit("decide"); }}>Decide</Button>
        </div>
      </EditorControlsHost>
    </DialogContent>;
}
