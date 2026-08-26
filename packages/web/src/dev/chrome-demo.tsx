/**
 * Entry point for `/chrome-demo.html` (#27).
 *
 * Dev-server only, and by construction rather than by a flag. Nothing here
 * configures an exclusion: Vite's default build input is the single
 * `index.html` at the package root, `chrome-demo.html` is not named as a second
 * one, and an entry nothing reaches is an entry nothing bundles. The dev server
 * serves every html file under the root, so `mise run web` and the e2e harness
 * — the two places that want to look at this — reach it anyway.
 *
 * The corollary matters more than the page does: adding a second entry to
 * `rollupOptions.input` would ship the demo, its Radix imports and its
 * Tailwind root. Do not.
 */

import { createRoot } from "react-dom/client";
import { ChromeDemo } from "./ChromeDemo.js";
import "../ui/styles.css";
// Not `../ui/tailwind.css` directly — see chrome-demo.css.
import "./chrome-demo.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("uberblick web: #root container is missing from chrome-demo.html");
}

createRoot(container).render(<ChromeDemo />);
