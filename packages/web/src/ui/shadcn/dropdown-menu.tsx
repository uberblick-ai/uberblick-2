/**
 * shadcn/ui dropdown menu, vendored (#27).
 *
 * The set is what the first consumer needs (#74 — workspace switcher and user
 * menu): a trigger, a content surface, items, a label and a separator.
 * Upstream also ships checkbox items, radio groups and submenus; they are not
 * here because nothing asks for them yet, and each would drag in an icon
 * dependency for its indicator. Add them when a screen needs them.
 *
 * The enter/exit animations are dropped for the same reason as in `popover.tsx`
 * (`tw-animate-css` is a dependency for a fade). `data-highlighted` is Radix's
 * "the pointer or the keyboard is on this item" state — one state for both, so
 * hovering and arrowing look identical.
 */

import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ComponentProps, ReactElement } from "react";
import { cn } from "./cn.js";

type DropdownMenuContentProps = ComponentProps<
  typeof DropdownMenuPrimitive.Content
> & {
  /** Keep a pointer-opened menu from taking the reader's current focus. */
  onOpenAutoFocus?: (event: Event) => void;
};

function DropdownMenu(
  props: ComponentProps<typeof DropdownMenuPrimitive.Root>,
): ReactElement {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger(
  props: ComponentProps<typeof DropdownMenuPrimitive.Trigger>,
): ReactElement {
  return (
    <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
  );
}

function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: DropdownMenuContentProps): ReactElement {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-[12rem] overflow-y-auto overflow-x-hidden rounded-(--radius) border border-border bg-popover p-1 text-[0.85rem] text-popover-foreground shadow-(--shadow-float)",
          "max-h-(--radix-dropdown-menu-content-available-height)",
          className,
        )}
        {...(props as ComponentProps<typeof DropdownMenuPrimitive.Content>)}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item>): ReactElement {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-2 rounded-(--radius-sm) px-2 py-1.5 outline-hidden",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>): ReactElement {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn("px-2 py-1.5 text-[0.75rem] text-muted-foreground", className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>): ReactElement {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};
