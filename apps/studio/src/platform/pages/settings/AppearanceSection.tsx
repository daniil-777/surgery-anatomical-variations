// Settings ▸ Appearance (APPLE_STYLE_SPEC §3.7): System/Light/Dark is saved to the account (profiles.appearance) and
// applies at once; Glass and Reduce Transparency belong to this browser, like the macOS transparency setting.

import { FormGroup, FormRow, SegmentedControl, Switch, usePx, type PxGlass } from "../../ui";
import type { Appearance } from "../../core/types";
import { useThemePreference } from "../../app/shell/appearance";

const THEMES: ReadonlyArray<{ value: Appearance; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const GLASS: ReadonlyArray<{ value: PxGlass; label: string }> = [
  { value: "clear", label: "Clear" },
  { value: "regular", label: "Regular" },
  { value: "tinted", label: "Tinted" },
];

export function AppearanceSection({ id }: { id: string }) {
  const { appearance, setAppearance } = usePx();
  const { theme, setTheme } = useThemePreference();
  return (
    <section id={id} className="px-settings-section" aria-label="Appearance">
      <FormGroup
        title="Appearance"
        footer="Your appearance is saved to your account. Glass and transparency apply to this browser. Labs always use the Dark appearance."
      >
        <FormRow label="Appearance">
          <SegmentedControl aria-label="Appearance" items={THEMES} value={theme} onChange={setTheme} />
        </FormRow>
        <FormRow label="Glass" description="How much of the window behind shows through sidebars and toolbars.">
          <SegmentedControl aria-label="Glass" items={GLASS} value={appearance.glass} onChange={(glass) => setAppearance({ glass })} />
        </FormRow>
        <FormRow label="Reduce Transparency" description="Uses the system setting when off.">
          <Switch
            aria-label="Reduce Transparency"
            checked={appearance.transparency === "reduce"}
            onChange={(event) => setAppearance({ transparency: event.target.checked ? "reduce" : "system" })}
          />
        </FormRow>
      </FormGroup>
    </section>
  );
}
