/** Personal appearance and collaboration preferences stay in this browser. */
import { useEffect, useId, useState } from "react";
import type { ReactElement } from "react";
import { AWARENESS_COLORS } from "../../collab/identity.js";
import type { AwarenessUser } from "../../collab/identity.js";
import { getSetting, setSetting } from "../../settings.js";
import type { Appearance } from "../../settings.js";
import { useSetting } from "../hooks.js";
import { Button } from "../shadcn/button.js";
import { Input } from "../shadcn/input.js";
import { APPEARANCES, useAppearance } from "../theme.js";
import { SettingsPage } from "./settings-kit.js";

const APPEARANCE_LABELS: Record<Appearance, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export function PreferencesSettings({ identity }: { identity: AwarenessUser }): ReactElement {
  const [name, setName] = useState(identity.name);
  const nameId = useId();
  const color = useSetting("presenceColor") ?? identity.color;
  const [appearance, chooseAppearance] = useAppearance();

  useEffect(() => setName(identity.name), [identity.name]);

  return <SettingsPage title="Preferences" gap="gap-6" note="Saved in this browser only.">
    <section className="flex flex-col gap-3" aria-labelledby="ub-appearance-title">
      <h2 id="ub-appearance-title" className="m-0 ub-type-h2 font-semibold">Appearance</h2>
      <fieldset className="ub-appearance m-0 min-w-0 border-0 p-0" aria-label="Appearance">
        {APPEARANCES.map((option) => <Button key={option} type="button" variant="outline"
          className="ub-appearance-option aria-pressed:bg-(--brand-subtle) aria-pressed:hover:enabled:bg-(--brand-subtle) aria-pressed:border-foreground"
          aria-pressed={option === appearance} onClick={() => chooseAppearance(option)}>
          {APPEARANCE_LABELS[option]}
        </Button>)}
      </fieldset>
    </section>
    <section className="flex flex-col gap-3" aria-labelledby="ub-presence-title">
      <h2 id="ub-presence-title" className="m-0 ub-type-h2 font-semibold">Presence</h2>
      <p className="m-0 ub-type-ui">How others see you while you edit: {identity.name}</p>
      <fieldset className="ub-swatches m-0 min-w-0 border-0 p-0" aria-label="Presence colour">
        {AWARENESS_COLORS.map((swatch) => <button key={swatch.hex} type="button" className="ub-swatch [@media(any-pointer:coarse)]:min-h-11"
          style={{ background: swatch.hex }} aria-label={swatch.name} aria-pressed={swatch.hex === color}
          onClick={() => setSetting("presenceColor", swatch.hex)} />)}
      </fieldset>
      <form className="flex flex-col gap-2" onSubmit={(event) => {
        event.preventDefault();
        setSetting("presenceName", name);
        setName(getSetting("presenceName") ?? identity.name);
      }}>
        <label className="ub-type-ui" htmlFor={nameId}>Presence name</label>
        <div className="flex items-center gap-2">
          <Input id={nameId} value={name} onChange={(event) => setName(event.target.value)} />
          <Button type="submit" variant="outline" size="sm">Save name</Button>
        </div>
      </form>
    </section>
  </SettingsPage>;
}
