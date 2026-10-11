/**
 * Start runtime config before React; room acquisition waits for it to prevent
 * dialing the fallback prematurely. Rendering may proceed during the read.
 * StrictMode doubles sockets and bindings, adding dev-only awareness noise;
 * refcounted rooms tolerate it, but this entry mounts without it.
 */

import { createRoot } from "react-dom/client";
import { resolveClientConfig } from "./config.js";
import { App } from "./ui/App.js";
import { NotificationToaster } from "./ui/shadcn/sonner.js";
import { applyStoredAppearance } from "./ui/theme.js";
import "./ui/styles.css";
import "@uberblick/wireframe/styles.css";
import "./ui/wireframe.css";
// Layered Tailwind styles product controls; unlayered .ub-* rules still win.
// Keep editor content in plain CSS; see ui/tailwind.css.
import "./ui/tailwind.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("uberblick web: #root container is missing from index.html");
}

// Startup and room hooks share config.ts's non-rejecting read.
void resolveClientConfig();

// index.html stamps before first paint; this deferred module catches runtime
// state up with it and also handles a missing bootstrap snippet.
applyStoredAppearance();

createRoot(container).render(<><App /><NotificationToaster /></>);
