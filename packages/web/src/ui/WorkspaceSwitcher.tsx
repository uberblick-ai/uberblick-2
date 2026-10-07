/**
 * Workspace switching is navigation to each configured address. Display names
 * come from shared settings, keyed by UUID; this menu owns no workspace state.
 * The standard sidebar menu button composes with the existing DropdownMenu.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./shadcn/dropdown-menu.js";
import { SidebarMenu, SidebarMenuItem, SidebarMenuButton } from "./shadcn/sidebar.js";
import type { Workspace } from "./route.js";
import { workspaceLabel } from "./workspace-names.js";

const NO_NAMES: ReadonlyMap<string, string | null> = new Map();

export function WorkspaceSwitcher({
  workspaces,
  current,
  names = NO_NAMES,
  onSwitch,
  active = true,
  onOpenChange,
}: {
  /** What to offer, already validated and deduplicated — see `workspaceList`. */
  workspaces: readonly Workspace[];
  /** The workspace the address names, or null when it names none. */
  current: Workspace | null;
  /** Live readings from each workspace's shared settings room. */
  names?: ReadonlyMap<string, string | null> | undefined;
  /** Go there. The value is a segment, spelled as the list spells it. */
  onSwitch: (segment: string) => void;
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
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu open={active && open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton className="ub-workspace">
              {current !== null && (
                <span className="ub-workspace-marker size-2 shrink-0 rounded-full bg-(--brand)" aria-hidden="true" />
              )}
              <span className="ub-workspace-name min-w-0 flex-1 truncate" title={current === null ? undefined : currentLabel}>
                {currentLabel}
              </span>
              <span className="ub-workspace-caret shrink-0 text-[0.7rem] text-(--sidebar-muted-foreground)" aria-hidden="true">
                ▾
              </span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="ub-workspace-menu w-(--radix-dropdown-menu-trigger-width)">
            <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
            {workspaces.map((workspace) => {
              const here = workspace.uuid === current?.uuid;
              return (
                <DropdownMenuItem
                  key={workspace.uuid}
                  className={`[@media(any-pointer:coarse)]:min-h-11 ${here ? "ub-menu-current text-(--brand-ink)" : ""}`}
                  aria-current={here ? "true" : undefined}
                  onSelect={() => onSwitch(workspace.segment)}
                >
                  <span className="ub-menu-text min-w-0 flex-1 truncate text-[0.8rem]">{workspaceLabel(workspace, names, workspaces)}</span>
                  {here && <span className="ub-workspace-current shrink-0" aria-hidden="true">✓</span>}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
