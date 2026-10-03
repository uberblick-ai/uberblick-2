/**
 * Native-button subset of shadcn/ui's Button (MIT; public/LICENSE-shadcn.txt).
 * No consumer needs Slot composition or a variant helper: these are static
 * class recipes, with the browser owning activation and keyboard focus.
 * Coarse-pointer floors and native outlines follow Web UI system.
 */
import type { ComponentProps, ReactElement } from "react";
import { cn } from "./cn.js";

const variants = {
  default: "bg-primary text-primary-foreground hover:enabled:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground hover:enabled:bg-secondary/80",
  selection: "relative cursor-pointer border border-transparent bg-transparent leading-none text-card-foreground hover:enabled:border-(--border) hover:enabled:bg-(--card-accent) hover:enabled:text-card-foreground focus-visible:border-(--border) focus-visible:bg-(--card-accent) data-[state=on]:border-brand data-[state=on]:bg-(--brand-subtle) data-[state=mixed]:border-dashed data-[state=mixed]:border-(--muted-foreground) data-[state=on]:after:content-['✓'] data-[state=mixed]:after:content-['−'] after:absolute after:top-0 after:right-[0.1rem] after:text-[0.55rem] after:leading-none data-[emphasis]:border-brand data-[emphasis]:bg-(--brand-subtle)",
  outline: "border border-(--border) bg-background text-foreground hover:enabled:bg-accent hover:enabled:text-accent-foreground",
};

const sizes = {
  selection: "h-auto min-h-[1.8rem] min-w-[1.8rem] px-[0.4rem] py-[0.15rem] text-[0.72rem] [@media(any-pointer:coarse)]:min-w-11",
  default: "h-9 px-4 py-2 text-sm",
  sm: "h-8 px-3 py-1 text-sm",
  icon: "size-9 text-sm [@media(any-pointer:coarse)]:min-w-11",
};

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ComponentProps<"button"> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}): ReactElement {
  return (
    <button
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-(--radius-sm) font-medium whitespace-nowrap transition-colors min-h-6 min-w-6 [@media(any-pointer:coarse)]:min-h-11 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}

export { Button };
