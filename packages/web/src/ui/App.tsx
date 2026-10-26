/** The shell keeps its state across document and workspace navigation. */
import type { ReactElement } from "react";
import { Dialog } from "./shadcn/dialog.js";
import { AlterDecisionDialog } from "./document/AlterDecisionDialog.js";
import { RemoteHubGuide } from "./shell/RemoteHubGuide.js";
import { LocalSessionNotice } from "./shell/ShellNotices.js";
import { ShellFrame } from "./shell/ShellFrame.js";
import { useAppShell } from "./shell/use-app-shell.js";
import { WorkspaceMembersContext } from "./workspace-members.js";

const NO_MEMBERS: readonly string[] = [];

export function App(): ReactElement {
  const shell = useAppShell();
  const { remoteSignIn, sessionMissing, identity } = shell.environment;
  const { alterDecision, onAlterDecisionOpenChange, closeAlterDecision, onDecisionRecorded } = shell.alter;
  return (
    <WorkspaceMembersContext value={shell.environment.members ?? NO_MEMBERS}>
    <Dialog open={alterDecision !== null} onOpenChange={onAlterDecisionOpenChange}>
      {remoteSignIn ? <main className="ub-app"><RemoteHubGuide /></main>
        : sessionMissing ? <main className="ub-app"><LocalSessionNotice /></main>
          : <ShellFrame shell={shell} />}
      {alterDecision !== null && <AlterDecisionDialog session={alterDecision} displayName={identity.name}
        docLinks={shell.navigation.docLinks} onClose={closeAlterDecision} onRecorded={onDecisionRecorded} />}
    </Dialog>
    </WorkspaceMembersContext>
  );
}
