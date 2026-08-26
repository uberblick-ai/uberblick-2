/**
 * Entry point for `/chrome-demo.html` (#27).
 *
 * Dev-server only, and by construction rather than by a flag: `vite build`
 * bundles the entries named in `rollupOptions.input`, which is `index.html` and
 * nothing else, so neither this module nor its page reaches a production
 * bundle. It is reachable from `mise run web` and from the e2e harness, which
 * are the two places that want to look at it.
 */

import { createRoot } from "react-dom/client";
import { ChromeDemo } from "./ChromeDemo.js";
import "../ui/styles.css";
import "../ui/tailwind.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("uberblick web: #root container is missing from chrome-demo.html");
}

createRoot(container).render(<ChromeDemo />);
