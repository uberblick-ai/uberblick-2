/**
 * Project-trimmed shadcn Dialog; Radix owns modal focus and dismissal.
 * Source (MIT):
 * https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/dialog.tsx
 */
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps, ReactElement } from "react";
import { cn } from "./cn.js";

function Dialog(props: ComponentProps<typeof DialogPrimitive.Root>): ReactElement {
  return <DialogPrimitive.Root {...props} />;
}

function DialogTitle(props: ComponentProps<typeof DialogPrimitive.Title>): ReactElement {
  return <DialogPrimitive.Title data-slot="dialog-title" {...props} />;
}

function DialogTrigger(props: ComponentProps<typeof DialogPrimitive.Trigger>): ReactElement {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogContent({ className, children, ...props }: ComponentProps<typeof DialogPrimitive.Content>): ReactElement {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay data-slot="dialog-overlay" className="fixed inset-0 z-50 bg-black/45" />
    <DialogPrimitive.Content data-slot="dialog-content"
      className={cn("fixed top-[20%] left-1/2 z-50 w-[min(32rem,calc(100vw_-_2rem))] -translate-x-1/2 overflow-hidden rounded-(--radius) border border-border bg-popover text-popover-foreground ub-type-ui shadow-(--shadow-float) outline-hidden", className)}
      {...props}>
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>;
}

export { Dialog, DialogContent, DialogTitle, DialogTrigger };
