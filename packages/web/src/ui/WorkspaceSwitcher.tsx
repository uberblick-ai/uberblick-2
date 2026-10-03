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
 * It renders *configuration*, not accounts. "New workspace" remains disabled:
 * making a workspace is `ub init` on a machine, and there is nothing here that
 * could do it. Workspace settings is navigation now that the client has that
 * address, and uses the same route-driven selection as switching workspaces.
 *
 * The surface is the vendored shadcn menu, with utilities preserving its
 * established layout. Names come from shared settings, keyed by UUID.
 */

import { useEffect, useState } from "react";
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
import { workspaceLabel } from "./workspace-names.js";

const NO_NAMES: ReadonlyMap<string, string | null> = new Map();

/** "3 docs", and "1 doc" — the count is chrome, so it should read as English. */
function docCountLabel(docs: number): string {
  return docs === 1 ? "1 doc" : `${docs} docs`;
}

export function WorkspaceSwitcher({
  workspaces,
  current,
  names = NO_NAMES,
  docs,
  onSwitch,
  onOpenSettings,
  active = true,
  onOpenChange,
}: {
  /** What to offer, already validated and deduplicated — see `workspaceList`. */
  workspaces: readonly Workspace[];
  /** The workspace the address names, or null when it names none. */
  current: Workspace | null;
  /** Live readings from each workspace's shared settings room. */
  names?: ReadonlyMap<string, string | null> | undefined;
  /**
   * How many documents the open workspace holds, live from the directory. Only
   * the open one has a number: the other workspaces' directories are rooms this
   * client has not joined, and guessing at their size would be a made-up fact.
   */
  docs: number;
  /** Go there. The value is a segment, spelled as the list spells it. */
  onSwitch: (segment: string) => void;
  /** Go to this workspace's settings address. */
  onOpenSettings: () => void;
  /** Whether the document-sidebar pane that owns this portalled menu is live. */
  active?: boolean;
  /** Acquire other workspaces' name readings only while their menu is open. */
  onOpenChange?: ((open: boolean) => void) | undefined;
}): ReactElement {
  const [open, setOpen] = useState(false);

  // The menu is portalled outside the sidebar pane, so `inert` on that pane
  // cannot retire it when history changes the route underneath an open menu.
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  useEffect(() => {
    onOpenChange?.(active && open);
    return () => onOpenChange?.(false);
  }, [active, open, onOpenChange]);
  const currentLabel = current === null ? "no workspace" : workspaceLabel(current, names, workspaces);

  return (
    <DropdownMenu open={active && open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="ub-workspace -mx-2 -mt-2 mb-2 flex w-[calc(100%+1rem)] min-h-6 pointer-coarse:min-h-11 items-center gap-2 border-0 border-b border-(--sidebar-border) bg-transparent p-2 text-left font-inherit text-inherit cursor-pointer hover:border-b-[light-dark(var(--sidebar),var(--sidebar-border))] hover:bg-sidebar-accent hover:text-accent-foreground" aria-label="Workspace">
          {/* Hidden like the user card's tile: a letter announced beside the
              name it repeats is the name read twice. */}
          {current !== null && (
            <span className="ub-workspace-tile flex size-7 shrink-0 items-center justify-center rounded-(--radius-sm) bg-(--brand) text-[0.8rem] leading-none font-medium text-(--brand-foreground) select-none" aria-hidden="true">
              {initialOf(currentLabel)}
            </span>
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-[0.1rem]">
            <span className="ub-workspace-name min-w-0 truncate text-[0.8rem]" title={current === null ? undefined : currentLabel}>
              {currentLabel}
            </span>
            {current !== null && (
              <span className="ub-workspace-count text-[11px] font-medium tracking-[0.12em] text-(--sidebar-group-label) uppercase">{docCountLabel(docs)}</span>
            )}
          </span>
          <span className="ub-workspace-caret text-[0.7rem] text-(--sidebar-muted-foreground)" aria-hidden="true">
            ▾
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="ub-workspace-menu w-(--radix-dropdown-menu-trigger-width)">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaces.map((workspace) => {
          const here = workspace.uuid === current?.uuid;
          return (
            <DropdownMenuItem
              key={workspace.uuid}
              className={here ? "ub-menu-current text-(--brand-ink)" : undefined}
              aria-current={here ? "true" : undefined}
              onSelect={() => onSwitch(workspace.segment)}
            >
              <span className="ub-menu-text min-w-0 flex-1 truncate text-[0.8rem]">{workspaceLabel(workspace, names, workspaces)}</span>
              {here && <span className="text-xs text-(--sidebar-muted-foreground)">{docCountLabel(docs)}</span>}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        {/* Configuration, not accounts — see the header. */}
        <DropdownMenuItem disabled>New workspace</DropdownMenuItem>
        <DropdownMenuItem disabled={current === null} onSelect={onOpenSettings}>
          Workspace settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
