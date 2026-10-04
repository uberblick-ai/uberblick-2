/**
 * The user card at the foot of the sidebar, and the panel it opens (#74,
 * design 1c).
 *
 * There are no accounts, so there is nothing here to sign into or out of. What
 * the panel holds is everything this client *is*: the name it publishes in
 * awareness, the colour peers see it in, which token set it paints with, how
 * many agent sessions are in the workspace. All of it was already real
 * client-held state — only the affordances were missing.
 *
 * The trigger is an identity card (#482): a tile in this session's presence
 * colour carrying the first character of the name it publishes, then the name.
 * There is still no role, account or e-mail line under it — there are no
 * accounts, so a second line would have nothing true to say.
 *
 * A popover rather than a menu, deliberately. A menu is a list of commands you
 * pick one of and leave; this is a small panel of controls and readouts you
 * come back out of unchanged, and two of its rows are facts rather than
 * actions. The workspace switcher above it *is* a list of commands, and is a
 * menu (see `WorkspaceSwitcher`). Both surfaces use vendored shadcn; their
 * remaining `.ub-*` styling moves to utilities when next changed, under Web UI
 * system's Styling rule.
 */

import { useState } from "react";
import type { ReactElement } from "react";
import { AWARENESS_COLORS } from "../collab/identity.js";
import type { AwarenessUser } from "../collab/identity.js";
import { setSetting } from "../settings.js";
import type { Appearance } from "../settings.js";
import { useSetting } from "./hooks.js";
import { initialOf } from "./PeerAvatar.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./shadcn/popover.js";
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
}): ReactElement {
  const [open, setOpen] = useState(false);
  const color = useSetting("presenceColor") ?? identity.color;
  const [appearance, chooseAppearance] = useAppearance();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="ub-user-card flex w-full items-center gap-2 mt-[0.15rem] rounded-(--radius-sm) border-0 bg-transparent px-[0.4rem] py-[0.3rem] text-left text-inherit cursor-pointer hover:bg-(--sidebar-accent) hover:text-accent-foreground" aria-label="You">
          <span
            className="ub-identity-tile ub-user-tile"
            style={{ background: color }}
            aria-hidden="true"
          >
            {initialOf(identity.name)}
          </span>
          <span className="ub-user-name">{identity.name}</span>
          <span className="ub-menu-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="ub-user-panel">
        <p className="ub-user-heading">{identity.name}</p>

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
  );
}
