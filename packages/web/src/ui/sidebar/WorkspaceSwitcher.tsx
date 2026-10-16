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
} from "../shadcn/dropdown-menu.js";
import { SidebarMenu, SidebarMenuItem, SidebarMenuButton } from "../shadcn/sidebar.js";
import type { Workspace } from "../route.js";
import { workspaceLabel } from "../workspace-names.js";
import { workspaceLocationLabel } from "../workspace-location.js";

const NO_NAMES: ReadonlyMap<string, string | null> = new Map();

export function WorkspaceSwitcher({
  workspaces,
  current,
  names = NO_NAMES,
  workspaceLocation = null,
  onSwitch,
  active = true,
  onOpenChange,
}: {
  /** What to offer, already validated and deduplicated — see `workspaceList`. */
  workspaces: readonly Workspace[];
  /** The workspace the address names, or null when it names none. */
  current: Workspace | null;
  /** Names from local replicas or live shared settings, keyed by workspace. */
  names?: ReadonlyMap<string, string | null> | undefined;
  /** The route's reported upstream address, or `local` for this device. */
  workspaceLocation?: string | null | undefined;
  /** Go there. The value is a segment, spelled as the list spells it. */
  onSwitch: (segment: string) => void;
  /** Whether the document-sidebar pane that owns this portalled menu is live. */
  active?: boolean;
  /** Limit direct-hub name readings to the time their menu is open. */
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
  const location = current === null ? null : workspaceLocationLabel(workspaceLocation);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu open={active && open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton className="ub-workspace">
              {current !== null && (
                <span className="ub-workspace-marker size-8 shrink-0 rounded-(--radius-sm) bg-(--brand)" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 ub-type-ui">
                <span className="ub-workspace-name block truncate" title={current === null ? undefined : currentLabel}>
                  {currentLabel}
                </span>{" "}
                {location !== null && (
                  <span className="ub-workspace-location block truncate ub-type-small font-normal text-(--sidebar-muted-foreground)" title={location}>
                    {location}
                  </span>
                )}
              </span>
              <svg className="ub-workspace-caret text-(--sidebar-muted-foreground)" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                <path d="m8 9 4-4 4 4m-8 6 4 4 4-4" />
              </svg>
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
                  <span className="ub-menu-text min-w-0 flex-1 truncate ub-type-ui">{workspaceLabel(workspace, names, workspaces)}</span>
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
