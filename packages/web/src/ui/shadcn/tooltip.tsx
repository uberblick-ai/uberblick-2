/**
 * shadcn/ui Tooltip, trimmed from the official Radix component.
 * Product tokens replace upstream colours; optional arrows and animations are
 * omitted. Radix owns hover, focus, touch activation and dismissal.
 */

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ComponentProps, ReactElement } from "react";
import { cn } from "./cn.js";

function TooltipProvider({
  delayDuration = 0,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>): ReactElement {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}

function Tooltip(props: ComponentProps<typeof TooltipPrimitive.Root>): ReactElement {
  return <TooltipPrimitive.Root {...props} />;
}

function TooltipTrigger(
  props: ComponentProps<typeof TooltipPrimitive.Trigger>,
): ReactElement {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>): ReactElement {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-max max-w-[min(18rem,80vw)] rounded-(--radius-sm) border border-(--border) bg-card px-[0.4rem] py-1 text-xs text-card-foreground shadow-[0_4px_12px_rgb(0_0_0/0.16)] [font-family:var(--font-sans)] [overflow-wrap:anywhere]",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
