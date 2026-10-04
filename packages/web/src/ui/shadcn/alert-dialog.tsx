/**
 * shadcn/ui AlertDialog, trimmed to the archive confirmation's public parts.
 *
 * Radix owns the portal, focus scope, dismissal and background isolation. The
 * wrapper owns only Uberblick's composition and visual tokens; the animation
 * utilities, header and media components from upstream are not needed.
 */

import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import type { ComponentProps, ReactElement } from "react";
import { Button } from "./button.js";
import { cn } from "./cn.js";

function AlertDialog(
  props: ComponentProps<typeof AlertDialogPrimitive.Root>,
): ReactElement {
  return <AlertDialogPrimitive.Root {...props} />;
}

function AlertDialogTrigger(
  props: ComponentProps<typeof AlertDialogPrimitive.Trigger>,
): ReactElement {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogAction({
  children,
  className,
  variant = "default",
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Action> &
  Pick<ComponentProps<typeof Button>, "variant">): ReactElement {
  return (
    <AlertDialogPrimitive.Action data-slot="alert-dialog-action" asChild {...props}>
      <Button variant={variant} className={className}>
        {children}
      </Button>
    </AlertDialogPrimitive.Action>
  );
}

function AlertDialogCancel({
  children,
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Cancel>): ReactElement {
  return (
    <AlertDialogPrimitive.Cancel data-slot="alert-dialog-cancel" asChild {...props}>
      <Button variant="outline" className={className}>
        {children}
      </Button>
    </AlertDialogPrimitive.Cancel>
  );
}

function AlertDialogFooter({
  className,
  ...props
}: ComponentProps<"div">): ReactElement {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Title>): ReactElement {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("m-0 text-base font-semibold", className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Description>): ReactElement {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("mt-[0.65rem] mb-4 leading-normal text-muted-foreground", className)}
      {...props}
    />
  );
}

function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Content>): ReactElement {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay
        data-slot="alert-dialog-overlay"
        className="fixed inset-0 z-30 bg-black/45"
      />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-30 grid w-[min(28rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-(--radius) border border-border bg-card p-4 text-[0.85rem] text-card-foreground shadow-(--shadow-float) outline-hidden",
          className,
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
};
