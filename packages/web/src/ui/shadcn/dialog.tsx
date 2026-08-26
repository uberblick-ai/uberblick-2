/**
 * shadcn/ui dialog, vendored (#27).
 *
 * The scrim, the lift and the z-index are the ones `.ub-modal` / `.ub-settings`
 * already use, so a Radix dialog and the hand-built settings dialog are the
 * same surface rather than two — see `--scrim` and `--shadow-modal` in
 * `styles.css`.
 *
 * Trimmed against upstream: no animation utilities (see `popover.tsx`), and no
 * `DialogHeader`/`DialogFooter`, which are `<div>`s with a flex class and
 * nothing a consumer cannot write. The close affordance is the `×` glyph the
 * settings dialog uses, not an icon package.
 */

import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "./cn.js";

function Dialog(props: ComponentProps<typeof DialogPrimitive.Root>): ReactElement {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
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

/**
 * The dialog itself: scrim, panel and a close button.
 *
 * `closeLabel` rather than a bare `×` with no name — a control whose only
 * content is a glyph has to say what it does to anything that is not a pair of
 * eyes, and "Close" alone is not enough once a page can have two dialogs.
 */
function DialogContent({
  className,
  children,
  closeLabel,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  closeLabel: string;
  children: ReactNode;
}): ReactElement {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        className="fixed inset-0 z-20 bg-(--scrim)"
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-20 grid w-[min(32rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 gap-3 overflow-y-auto",
          "rounded-(--radius) border border-border bg-card p-4 text-[0.85rem] text-card-foreground shadow-(--shadow-modal) outline-hidden",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          data-slot="dialog-close"
          aria-label={closeLabel}
          className="absolute top-3 right-3 cursor-pointer rounded-(--radius-sm) px-1 leading-none text-muted-foreground hover:text-foreground"
        >
          ×
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
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
