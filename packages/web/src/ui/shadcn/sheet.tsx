/**
 * Project-trimmed shadcn Sheet: right-edge content and its close control.
 * Source (MIT):
 * https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/sheet.tsx
 *
 * Radix owns the portal, modal isolation, focus scope and dismissal. Unused
 * sides, layout helpers and animation utilities are omitted. Content follows
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
  ...props
}: ComponentProps<typeof SheetPrimitive.Content> & {
  closeLabel?: string;
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
          "fixed inset-y-0 right-0 z-30 flex h-dvh w-[min(20rem,85vw)] flex-col border-l border-border bg-card text-card-foreground shadow-lg outline-hidden",
          className,
        )}
        {...props}
      >
        {children}
        <SheetClose className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
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
        </SheetClose>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export { Sheet, SheetClose, SheetContent, SheetTitle };
