/** The served account opens its personal settings destinations. */
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { AccountIdentity } from "../../shell/account.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../shadcn/dropdown-menu.js";
import { SidebarMenu, SidebarMenuItem, SidebarMenuButton } from "../shadcn/sidebar.js";

export function UserMenu({
  account = { state: "unavailable" },
  active = true,
  onOpenPreferences,
  onOpenDevices,
}: {
  /** Safe account reading for the hub this page is served from. */
  account?: AccountIdentity | undefined;
  /** Retire the portalled menu when the docked sidebar is collapsed. */
  active?: boolean;
  onOpenPreferences: () => void;
  /** Present only while this computer is signed in to the workspace's hub. */
  onOpenDevices?: (() => void) | undefined;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const label = account.state === "signed-in"
    ? `@${account.handle}`
    : account.state === "signed-out" ? "Not signed in" : "Account unavailable";

  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu open={active && open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton data-testid="account-menu" aria-label={`${label}; preferences`}>
              <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
              <span className="shrink-0 ub-type-caption text-(--sidebar-muted-foreground)" aria-hidden="true">▾</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuItem className="min-h-8.5 [@media(any-pointer:coarse)]:min-h-11" onSelect={onOpenPreferences}>Preferences</DropdownMenuItem>
            {onOpenDevices !== undefined && <DropdownMenuItem className="min-h-8.5 [@media(any-pointer:coarse)]:min-h-11" onSelect={onOpenDevices}>Devices</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
