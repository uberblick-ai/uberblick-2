/* Stamp explicit light/dark before first paint; module scripts run too late.
 * Keep the settings key/shape aligned with src/settings.ts. System, missing,
 * malformed or unreadable storage leaves the attribute off for CSS defaults.
 * src/ui/theme.ts owns later changes. */
try {
  const settings = JSON.parse(
    localStorage.getItem("uberblick.settings.v1") || "{}",
  );
  if (settings.appearance === "light" || settings.appearance === "dark") {
    document.documentElement.setAttribute("data-theme", settings.appearance);
  }
} catch {
  /* Unreadable storage: no stamp, so the system preference decides. */
}
