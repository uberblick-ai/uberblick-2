/**
 * The workspace switcher (#151): where you are, and — when the build was
 * configured with more than one workspace — a way to the others.
 *
 * Switching is navigating. There is no "active workspace" state to set: the
 * control writes `/<workspace>` into the address bar and the app re-reads it
 * like any other navigation, which is what keeps a switch and a pasted link the
 * same gesture. Nothing here knows about rooms, and nothing carries across the
 * switch — two workspaces are two corpora.
 *
 * With one workspace (the ordinary case) this is the plain label it has always
 * been: a menu of one is a control that does nothing.
 *
 * #74 owns what a switcher should eventually look like — self-described names,
 * a real menu. This is the minimum that lists the configured workspaces and
 * navigates.
 */

import type { ReactElement } from "react";
import type { Workspace } from "./route.js";

export function WorkspaceSwitcher({
  workspaces,
  current,
  onSwitch,
}: {
  /** What to offer, already validated and deduplicated — see `workspaceList`. */
  workspaces: readonly Workspace[];
  /** The workspace the address names, or null when it names none. */
  current: Workspace | null;
  /** Go there. The value is a segment, spelled as the list spells it. */
  onSwitch: (segment: string) => void;
}): ReactElement {
  if (workspaces.length < 2) {
    return (
      <span className="ub-muted">
        {/* As the address spells it: the slug is what a person reads. */}
        {current === null ? "no workspace" : `workspace ${current.segment}`}
      </span>
    );
  }
  return (
    <select
      className="ub-muted ub-workspace"
      aria-label="Workspace"
      // The empty value is unreachable once a workspace is open: it exists so
      // the control has something to show at the one address that names none.
      value={current?.segment ?? ""}
      onChange={(event) => onSwitch(event.target.value)}
    >
      {current === null && (
        <option value="" disabled>
          no workspace
        </option>
      )}
      {workspaces.map((workspace) => (
        <option key={workspace.uuid} value={workspace.segment}>
          {workspace.segment}
        </option>
      ))}
    </select>
  );
}
