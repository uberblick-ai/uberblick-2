/** Production editor and its competing controls, with document transport omitted. */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { appendBlock, getBlockInline, getBlocks, getBlocksFragment } from "@uberblick/schema";
import * as Y from "yjs";
import { createUberblickEditor } from "../../src/editor/create-editor.js";
import { CommentComposer } from "../../src/ui/comments/CommentComposer.js";
import { BlockMenu } from "../../src/ui/editor-controls/BlockMenu.js";
import { CalloutControl } from "../../src/ui/editor-controls/CalloutControl.js";
import { CardButtonControls } from "../../src/ui/editor-controls/CardButtonControls.js";
import { CodeLanguageControl } from "../../src/ui/editor-controls/CodeLanguageControl.js";
import { EmojiMenu } from "../../src/ui/editor-controls/EmojiMenu.js";
import { MentionMenu } from "../../src/ui/editor-controls/MentionMenu.js";
import { TableControls } from "../../src/ui/editor-controls/TableControls.js";
import { WorkspaceMembersContext } from "../../src/ui/workspace-members.js";
import "../../src/ui/styles.css";
import "../../src/ui/tailwind.css";

const canWrite = () => true;
const onCreated = () => {};
const members: readonly string[] = [];

function CalloutControlsFixture() {
  const host = useRef<HTMLDivElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const [bound, setBound] = useState<{ editor: Editor; ydoc: Y.Doc } | null>(null);
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState("");
  const footnotes = new URLSearchParams(location.search).has("footnotes");

  useEffect(() => {
    const ydoc = new Y.Doc();
    if (footnotes) {
      appendBlock(ydoc, { type: "paragraph", inline: [{ text: "Read ", marks: {} }, { text: "[^Source]", marks: { footnoteRef: true } }] });
      appendBlock(ydoc, { type: "footnote", label: "Source", text: "Kept note" });
    } else appendBlock(ydoc, { type: "callout", variant: "tip", icon: "🚀", text: "Keep this text." });
    const editor = createUberblickEditor({ element: host.current, fragment: getBlocksFragment(ydoc), awareness: null });
    const update = () => setSnapshot(JSON.stringify(getBlocks(ydoc).map((block) => ({ ...block, inline: getBlockInline(ydoc, block.id) }))));
    ydoc.on("update", update);
    update();
    setBound({ editor, ydoc });
    return () => { editor.destroy(); ydoc.destroy(); };
  }, [footnotes]);

  useEffect(() => { if (bound !== null) setReady(true); }, [bound]);

  return <WorkspaceMembersContext value={members}>
    <main className="ub-pane ub-page-pane ub-document-pane" data-callout-controls-ready={ready}>
      <div className="ub-column">
        <div className="ub-editor-frame" ref={frame}>
          <div className="ub-editor" ref={host} />
          {bound !== null && <>
            <CardButtonControls editor={bound.editor} canWrite={canWrite} />
            <CodeLanguageControl editor={bound.editor} canWrite={canWrite} />
            <CalloutControl editor={bound.editor} canWrite={canWrite} />
            <BlockMenu editor={bound.editor} host={frame} />
            <TableControls editor={bound.editor} host={frame} />
            <EmojiMenu editor={bound.editor} host={frame} />
            <MentionMenu editor={bound.editor} host={frame} docLinks={null} openDocId={null} />
            <CommentComposer editor={bound.editor} ydoc={bound.ydoc} author="Fixture reader" host={frame} onCreated={onCreated} />
          </>}
        </div>
      </div>
      <output hidden aria-label="Stored editor blocks">{snapshot}</output>
    </main>
  </WorkspaceMembersContext>;
}

const root = document.getElementById("root");
if (root === null) throw new Error("no fixture root");
createRoot(root).render(<CalloutControlsFixture />);
