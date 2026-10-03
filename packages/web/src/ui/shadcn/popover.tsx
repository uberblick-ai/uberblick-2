/**
 * shadcn/ui popover, vendored (#27).
 *
 * Vendored means the source lives here and is ours to read and change — that is
 * how shadcn ships, and it is why adopting it costs three Radix packages rather
 * than a component framework. Trimmed against the upstream copy in two ways:
 * the enter/exit animation utilities are gone (they come from `tw-animate-css`,
 * a dependency for a fade), and the class strings read the product's own tokens
 * — see `../tailwind.css` for why radius and shadow are spelled
 * `rounded-(--radius)` rather than `rounded-lg`.
 */

import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ComponentProps, ReactElement } from "react";
import { cn } from "./cn.js";

function Popover(props: ComponentProps<typeof PopoverPrimitive.Root>): ReactElement {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(
  props: ComponentProps<typeof PopoverPrimitive.Trigger>,
): ReactElement {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

/** The invisible box a popover points at, when that is not the trigger. */
function PopoverAnchor(
  props: ComponentProps<typeof PopoverPrimitive.Anchor>,
): ReactElement {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 6,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>): ReactElement {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 rounded-(--radius) border border-border bg-popover p-3 text-[0.85rem] text-popover-foreground shadow-(--shadow-float) outline-hidden",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
