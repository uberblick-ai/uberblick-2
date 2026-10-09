/** Test-only publishers: product consumers are separate follow-ups. */
import { createRoot } from "react-dom/client";
import { notifySticky, notifyTransient, resolveSticky } from "../../src/notifications.js";
import { setSetting } from "../../src/settings.js";
import { NotificationToaster } from "../../src/ui/shadcn/sonner.js";
import "../../src/ui/styles.css";
import "../../src/ui/tailwind.css";

const fixture = {
  transient: notifyTransient,
  sticky: notifySticky,
  resolve: resolveSticky,
  appearance: (appearance: "light" | "dark") => setSetting("appearance", appearance),
};

// Calls through this object execute outside a component and React context,
// just as the non-React editor's controls will publish.
declare global {
  interface Window { notificationFixture: typeof fixture }
}
window.notificationFixture = fixture;

const root = document.getElementById("root");
if (root === null) throw new Error("no fixture root");

createRoot(root).render(
  <>
    <main style={{ padding: 24, minHeight: "100dvh", background: "var(--background)", color: "var(--foreground)" }}>
      <h1>Shared notifications</h1>
      <label>
        Origin control
        <input aria-label="Origin control" defaultValue="Editor text" />
      </label>
      <button type="button" onClick={() => notifyTransient({ severity: "success", message: "React publisher" })}>
        Publish from React
      </button>
      <button type="button">Following control</button>
    </main>
    <div aria-hidden="true" data-fixture-chrome="" style={{ position: "fixed", inset: 0, zIndex: 50, pointerEvents: "none" }} />
    <NotificationToaster />
  </>,
);
