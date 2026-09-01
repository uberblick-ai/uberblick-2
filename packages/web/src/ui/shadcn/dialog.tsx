/**
 * shadcn/ui dialog, trimmed to the archive confirmation's public primitives.
 *
 * Radix owns the portal, focus scope, dismissal and background isolation. The
 * wrapper owns only Uberblick's composition and visual tokens; the animation
 * utilities and convenience layout components from upstream are not needed.
 */

import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps, ReactElement } from "react";
import { cn } from "./cn.js";

function Dialog(props: ComponentProps<typeof DialogPrimitive.Root>): ReactElement {
  return <DialogPrimitive.Root {...props} />;
}

function DialogTrigger(
  props: ComponentProps<typeof DialogPrimitive.Trigger>,
): ReactElement {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(
  props: ComponentProps<typeof DialogPrimitive.Close>,
): ReactElement {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>): ReactElement {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-medium text-foreground", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>): ReactElement {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

function DialogContent({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>): ReactElement {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        className="fixed inset-0 z-30 bg-black/45"
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-30 grid w-[min(32rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 gap-3 overflow-y-auto",
          "rounded-(--radius) border border-border bg-card p-4 text-[0.85rem] text-card-foreground shadow-(--shadow-float) outline-hidden",
          className,
        )}
        {...props}
      />
    </DialogPrimitive.Portal>
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
};
