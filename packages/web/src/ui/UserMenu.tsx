/**
 * The standard sidebar account control and this tab's preferences panel.
 * The account comes from the local serving process; presence remains a
 * separate collaboration identity inside the panel.
 *
 * A popover rather than a menu, deliberately. A menu is a list of commands you
 * pick one of and leave; this is a small panel of controls and readouts you
 * come back out of unchanged, and two of its rows are facts rather than
 * actions. The workspace switcher above it *is* a list of commands, and is a
 * menu (see `WorkspaceSwitcher`). Both surfaces compose the existing local
 * shadcn components and keep Radix's keyboard, focus and dismissal behavior.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { AWARENESS_COLORS } from "../collab/identity.js";
import type { AwarenessUser } from "../collab/identity.js";
import type { AccountIdentity } from "../shell/account.js";
import { setSetting } from "../settings.js";
import type { Appearance } from "../settings.js";
import { useSetting } from "./hooks.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./shadcn/popover.js";
import { SidebarMenu, SidebarMenuItem, SidebarMenuButton } from "./shadcn/sidebar.js";
import { APPEARANCES, useAppearance } from "./theme.js";

/** What each appearance is called. */
const APPEARANCE_LABELS: Record<Appearance, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export function UserMenu({
  identity,
  agentSessions,
  account = { state: "unavailable" },
  active = true,
}: {
  /**
   * This tab's awareness identity: the name it publishes, and the colour it was
   * given before anybody chose one.
   */
  identity: AwarenessUser;
  /**
   * MCP sessions in the workspace right now — `useAgentSessions` is where
   * "which of these is an agent" is decided.
   */
  agentSessions: number;
  /** Safe account reading for the hub this page is served from. */
  account?: AccountIdentity | undefined;
  /** Retire the portalled panel when the docked sidebar is collapsed. */
  active?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const color = useSetting("presenceColor") ?? identity.color;
  const [appearance, chooseAppearance] = useAppearance();
  const label = account.state === "signed-in"
    ? `@${account.handle}`
    : account.state === "signed-out" ? "Not signed in" : "Account unavailable";

  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Popover open={active && open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <SidebarMenuButton data-testid="account-menu" aria-label={`${label}; preferences`}>
              <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
              <span className="shrink-0 text-[0.7rem] text-(--sidebar-muted-foreground)" aria-hidden="true">
                ▾
              </span>
            </SidebarMenuButton>
          </PopoverTrigger>
          <PopoverContent align="start" side="top" className="ub-user-panel">
            <p className="ub-user-heading">Presence name: {identity.name}</p>

            {/* A caption over a set of related controls is what a fieldset is. */}
            <fieldset className="ub-panel-group">
              <legend className="ub-panel-label">Presence colour</legend>
              <div className="ub-swatches">
                {AWARENESS_COLORS.map((swatch) => (
                  <button
                    key={swatch.hex}
                    type="button"
                    className="ub-swatch"
                    style={{ background: swatch.hex }}
                    // The palette is unnamed hues; the name is what makes a swatch
                    // choosable without seeing it.
                    aria-label={swatch.name}
                    aria-pressed={swatch.hex === color}
                    onClick={() => setSetting("presenceColor", swatch.hex)}
                  />
                ))}
              </div>
            </fieldset>

            <fieldset className="ub-panel-group">
              <legend className="ub-panel-label">Appearance</legend>
              <div className="ub-appearance">
                {APPEARANCES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="ub-appearance-option rounded-(--radius-sm) border border-solid border-sidebar-border bg-transparent px-[0.4rem] py-1 text-[0.8rem]/[inherit] font-[inherit] text-inherit cursor-pointer hover:aria-[pressed=false]:bg-(--sidebar-accent) hover:text-accent-foreground aria-pressed:bg-(--brand-subtle) aria-pressed:border-foreground"
                    aria-pressed={option === appearance}
                    onClick={() => chooseAppearance(option)}
                  >
                    {APPEARANCE_LABELS[option]}
                  </button>
                ))}
              </div>
            </fieldset>

            {/* Facts, not actions — see the header. */}
            <dl className="ub-panel-facts">
              <div className="ub-panel-fact">
                <dt>MCP connections</dt>
                <dd>{agentSessions}</dd>
              </div>
            </dl>
          </PopoverContent>
        </Popover>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <p className="m-0 px-2 text-xs text-(--sidebar-muted-foreground)">Account settings</p>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
