/**
 * Trimmed official shadcn Sonner wrapper. Product appearance replaces
 * next-themes; Sonner retains its native stack, timers, focus and gestures.
 */
import type { CSSProperties, ReactElement } from "react";
import { createPortal } from "react-dom";
import { Toaster } from "sonner";
import { useAppearance } from "../theme.js";

export function NotificationToaster(): ReactElement {
  const [appearance] = useAppearance();
  // Radix preserves live regions when hiding a modal's background. Keep this
  // region outside #root so it can hide the app as one subtree.
  return createPortal(
    <Toaster
      theme={appearance}
      className="[font-family:var(--font-sans)]!"
      style={{
        "--normal-bg": "var(--card)",
        "--normal-text": "var(--card-foreground)",
        "--normal-border": "var(--border)",
        "--border-radius": "var(--radius-sm)",
      } as CSSProperties}
      toastOptions={{
        classNames: {
          toast: "ub-type-small! shadow-(--shadow-float)! focus-visible:shadow-[inset_0_0_0_2px_var(--card-foreground)]!",
          title: "ub-type-small! font-normal! text-card-foreground!",
          actionButton: "ub-type-small! rounded-(--radius-sm)! focus-visible:shadow-none! focus-visible:[outline:revert]! focus-visible:outline-offset-2! [@media(any-pointer:coarse)]:min-h-11! [@media(any-pointer:coarse)]:min-w-11!",
        },
      }}
    />,
    document.body,
  );
}
