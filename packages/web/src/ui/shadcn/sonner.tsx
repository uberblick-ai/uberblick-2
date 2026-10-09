/**
 * Trimmed official shadcn Sonner wrapper. Product appearance replaces
 * next-themes; Sonner retains its native stack, timers, focus and gestures.
 */
import type { CSSProperties, ReactElement } from "react";
import { Toaster } from "sonner";
import { TRANSIENT_DURATION } from "../../notifications.js";
import { useAppearance } from "../theme.js";

export function NotificationToaster(): ReactElement {
  const [appearance] = useAppearance();
  return (
    <Toaster
      theme={appearance}
      position="top-right"
      duration={TRANSIENT_DURATION}
      hotkey={["shiftKey", "F8"]}
      customAriaLabel="Notifications (Shift+F8)"
      closeButton
      // Sonner's default cap also hides old notices after keyboard expansion.
      // Keep all active conditions reachable through the native scroll/Tab route.
      visibleToasts={Infinity}
      offset={{ top: "max(16px, env(safe-area-inset-top))", right: "max(16px, env(safe-area-inset-right))" }}
      mobileOffset={{ top: "max(16px, env(safe-area-inset-top))", right: "max(16px, env(safe-area-inset-right))", left: "max(16px, env(safe-area-inset-left))" }}
      className="[font-family:var(--font-sans)]! w-(--width)! h-[calc(100dvh-max(16px,env(safe-area-inset-top))-max(16px,env(safe-area-inset-bottom)))] overflow-x-hidden overflow-y-auto pointer-events-none [&>[data-sonner-toast]]:pointer-events-auto"
      style={{
        "--width": "min(356px, calc(100vw - max(16px, env(safe-area-inset-left)) - max(16px, env(safe-area-inset-right))))",
        "--normal-bg": "var(--card)",
        "--normal-text": "var(--card-foreground)",
        "--normal-border": "var(--border)",
        "--border-radius": "var(--radius-sm)",
      } as CSSProperties}
      toastOptions={{
        closeButtonAriaLabel: "Dismiss notification",
        classNames: {
          toast: "shadow-(--shadow-float)! focus-visible:shadow-[inset_0_0_0_2px_var(--card-foreground)]! pr-10! w-full!",
          description: "text-card-foreground!",
          closeButton: "left-auto! right-2! top-2! transform-none! size-6! text-card-foreground! bg-card! border-(--border)! hover:bg-secondary! focus-visible:shadow-[0_0_0_2px_var(--card-foreground)]!",
        },
      }}
    />
  );
}
