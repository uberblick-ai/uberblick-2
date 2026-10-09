/**
 * Project-trimmed shadcn Sheet: left/right content and its close control.
 * Source (MIT):
 * https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/sheet.tsx
 *
 * Radix owns the portal, modal isolation, focus scope and dismissal. Unused
 * layout helpers and animation utilities are omitted. Content follows
 * Radix's normal mount lifetime so a closed sheet releases background hiding.
 */
import * as SheetPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps, ReactElement } from "react";
import { cn } from "./cn.js";

function Sheet(props: ComponentProps<typeof SheetPrimitive.Root>): ReactElement {
  return <SheetPrimitive.Root {...props} />;
}

function SheetClose(
  props: ComponentProps<typeof SheetPrimitive.Close>,
): ReactElement {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetTitle({
  className,
  ...props
}: ComponentProps<typeof SheetPrimitive.Title>): ReactElement {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  closeLabel = "Close",
  side = "right",
  showClose = true,
  ...props
}: ComponentProps<typeof SheetPrimitive.Content> & {
  closeLabel?: string;
  side?: "left" | "right";
  showClose?: boolean;
}): ReactElement {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay
        data-slot="sheet-overlay"
        className="fixed inset-0 z-30 bg-black/45"
      />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 z-30 flex h-dvh flex-col border-border shadow-lg outline-hidden",
          side === "left"
            ? "left-0 border-r w-[min(var(--sidebar-width),85vw)] bg-sidebar text-sidebar-foreground"
            : "right-0 border-l w-[min(20rem,85vw)] bg-card text-card-foreground",
          className,
        )}
        {...props}
      >
        {children}
        {/* Center the target on the original 16px glyph (17px from the top,
            22px from the right), independently of native button padding. */}
        {showClose && <SheetClose className="absolute top-[0.8125rem] right-[1.125rem] inline-flex items-center justify-center p-0 min-h-6 min-w-6 [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:min-w-11 [@media(any-pointer:coarse)]:top-[0.1875rem] [@media(any-pointer:coarse)]:right-2 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
          <svg
            aria-hidden="true"
            className="size-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
          <span className="sr-only">{closeLabel}</span>
        </SheetClose>}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export { Sheet, SheetClose, SheetContent, SheetTitle };
