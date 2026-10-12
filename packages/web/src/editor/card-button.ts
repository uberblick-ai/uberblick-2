/** Card actions have a separate destination boundary from ordinary links. */
import { isCardButtonHref } from "@uberblick/schema";

export function openCardButton(href: unknown): void {
  if (!isCardButtonHref(href)) return;
  if (href.startsWith("https://")) {
    window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  // A native same-tab app link hands the route to the browser without the
  // blank tab created by window.open. Its query remains opaque.
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.target = "_self";
  anchor.rel = "noreferrer";
  anchor.hidden = true;
  anchor.dataset.cardButtonNavigation = "true";
  document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); }
}
