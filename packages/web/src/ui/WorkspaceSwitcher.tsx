/**
 * The workspace switcher: where you are, what is in it, and the way to the
 * other workspaces this client was configured with (#74, design 1c).
 *
 * It sits at the top of the sidebar and opens across it — the menu takes the
 * trigger's width (`--radix-dropdown-menu-trigger-width`), so it reads as the
 * sidebar's own header opening rather than as a popup that happens to be near
 * it.
 *
 * The trigger is an identity card (#482): a tile carrying the workspace's first
 * character, then the name over the doc count as a subtitle. Where the address
 * names no workspace there is neither tile nor count — a letter and a number
 * for a workspace that is not there would both be invented.
 *
 * Switching is navigating. There is no "active workspace" state to set: the
 * control writes `/<workspace>` into the address bar and the app re-reads it
 * like any other navigation, which is what keeps a switch and a pasted link the
 * same gesture. Nothing here knows about rooms, and nothing carries across the
 * switch — two workspaces are two corpora.
 *
 * It renders *configuration*, not accounts. "New workspace" is on the menu and
 * disabled: making a workspace is `ub init` on a machine, and there is nothing
 * here that could do it. It is rendered rather than hidden because a disabled
 * item says "this exists and is not yours to do from here", which is the truth,
 * while an absent one says the idea does not exist. "Workspace settings" shipped
 * disabled under that same rationale and is now live (#485) — settings exist as
 * a place, so the item goes there; the reasoning survives for the item that
 * still has nowhere to go.
 *
 * The surface is the vendored shadcn menu (#27); everything about how this
 * particular menu *looks* is plain CSS on `.ub-*` classes, like every other
 * product surface. See `ui/tailwind.css` for why the two coexist.
 */

import type { ReactElement } from "react";
import { initialOf } from "./PeerAvatar.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./shadcn/dropdown-menu.js";
import type { Workspace } from "./route.js";

/** "3 docs", and "1 doc" — the count is chrome, so it should read as English. */
function docCountLabel(docs: number): string {
  return docs === 1 ? "1 doc" : `${docs} docs`;
}

export function WorkspaceSwitcher({
  workspaces,
  current,
  docs,
  onSwitch,
  onOpenSettings,
}: {
  /** What to offer, already validated and deduplicated — see `workspaceList`. */
  workspaces: readonly Workspace[];
  /** The workspace the address names, or null when it names none. */
  current: Workspace | null;
  /**
   * How many documents the open workspace holds, live from the directory. Only
   * the open one has a number: the other workspaces' directories are rooms this
   * client has not joined, and guessing at their size would be a made-up fact.
   */
  docs: number;
  /** Go there. The value is a segment, spelled as the list spells it. */
  onSwitch: (segment: string) => void;
  /** Open workspace settings (#485) — a navigation, like switching. */
  onOpenSettings: () => void;
}): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="ub-workspace" aria-label="Workspace">
          {/* Hidden like the user card's tile: a letter announced beside the
              name it repeats is the name read twice. */}
          {current !== null && (
            <span className="ub-identity-tile ub-workspace-tile" aria-hidden="true">
              {initialOf(current.segment)}
            </span>
          )}
          <span className="ub-workspace-identity">
            {/* The name truncates, and a segment can be a bare uuid — so the
                whole of it is on the hover. */}
            <span className="ub-workspace-name" title={current?.segment}>
              {/* As the address spells it: the slug is what a person reads. */}
              {current === null ? "no workspace" : current.segment}
            </span>
            {current !== null && (
              <span className="ub-workspace-count">{docCountLabel(docs)}</span>
            )}
          </span>
          <span className="ub-menu-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="ub-workspace-menu">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaces.map((workspace) => {
          const here = workspace.uuid === current?.uuid;
          return (
            <DropdownMenuItem
              key={workspace.uuid}
              className={here ? "ub-menu-current" : undefined}
              aria-current={here ? "true" : undefined}
              onSelect={() => onSwitch(workspace.segment)}
            >
              <span className="ub-menu-text">{workspace.segment}</span>
              {here && <span className="ub-menu-value">{docCountLabel(docs)}</span>}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        {/* Configuration, not accounts — see the header. */}
        <DropdownMenuItem disabled>New workspace</DropdownMenuItem>
        {/* Unavailable where the address names no workspace: there would be no
            workspace to have settings, so the item would promise a navigation
            it cannot make. Shown and disabled rather than hidden, like the
            item above it. */}
        <DropdownMenuItem disabled={current === null} onSelect={onOpenSettings}>
          Workspace settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
