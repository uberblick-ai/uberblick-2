/**
 * Trimmed official shadcn Sonner wrapper. Product appearance replaces
 * next-themes; Sonner retains its native stack, timers, focus and gestures.
 */
import type { CSSProperties, ReactElement } from "react";
import { createPortal } from "react-dom";
import { Toaster } from "sonner";
import { TRANSIENT_DURATION } from "../../notifications.js";
import { useAppearance } from "../theme.js";

export function NotificationToaster(): ReactElement {
  const [appearance] = useAppearance();
  // Radix preserves live regions when hiding a modal's background. Keep this
  // region outside #root so it can hide the app as one subtree.
  return createPortal(
    <Toaster
      theme={appearance}
      position="bottom-right"
      duration={TRANSIENT_DURATION}
      hotkey={["shiftKey", "F8"]}
      customAriaLabel="Notifications (Shift+F8)"
      closeButton
      // Sonner's default cap also hides old notices after keyboard expansion.
      // Keep all active conditions reachable through the native scroll/Tab route.
      // Expanded bottom stacks need in-flow boxes for Safari to count upward
      // overflow. Relative placement cancels the primitive's translation offset;
      // its transforms, gestures, focus and timers stay with Sonner.
      visibleToasts={Infinity}
      offset={{ bottom: "max(16px, env(safe-area-inset-bottom))", right: "max(16px, env(safe-area-inset-right))" }}
      mobileOffset={{ bottom: "max(16px, env(safe-area-inset-bottom))", right: "max(16px, env(safe-area-inset-right))", left: "max(16px, env(safe-area-inset-left))" }}
      className={[
        "[font-family:var(--font-sans)]! w-(--width)! h-[calc(100dvh-max(16px,env(safe-area-inset-top))-max(16px,env(safe-area-inset-bottom)))]",
        "flex flex-col-reverse gap-(--gap) overflow-x-hidden overflow-y-auto pointer-events-none [&>[data-sonner-toast]]:pointer-events-auto",
        "[&>[data-sonner-toast][data-expanded=true][data-removed=false]]:relative! [&>[data-sonner-toast][data-expanded=true][data-removed=false]]:shrink-0",
        "[&>[data-sonner-toast][data-expanded=true][data-removed=false]]:bottom-[calc(-1*var(--offset))]!",
      ].join(" ")}
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
    />,
    document.body,
  );
}
