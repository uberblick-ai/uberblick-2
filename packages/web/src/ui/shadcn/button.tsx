/**
 * Native-button subset of shadcn/ui's Button (MIT; public/LICENSE-shadcn.txt).
 * No consumer needs Slot composition or a variant helper: these are static
 * class recipes, with the browser owning activation and keyboard focus.
 * Coarse-pointer floors and native outlines follow Web UI system.
 * New React buttons use this component. Native buttons are only for controls
 * that cannot use its rendered target, such as a hidden form submit. Editor
 * node views built with document.createElement("button") stay native.
 */
import type { ComponentProps, ReactElement } from "react";
import { cn } from "./cn.js";

const variants = {
  plain: "",
  tool: "rounded-(--radius-sm) border border-(--border) bg-secondary text-secondary-foreground px-[0.45rem] py-[0.15rem] ub-type-caption [font-weight:inherit] disabled:opacity-50 in-[.ub-composer]:bg-(--card-accent) data-[emphasis=true]:bg-(--card-accent) data-[emphasis=true]:border-(--muted-foreground) data-[emphasis=true]:text-foreground",
  history: "inline-grid size-[26px] shrink-0 place-items-center rounded-(--radius-sm) border-0 bg-transparent p-0 text-(--muted-foreground) disabled:opacity-40 hover:enabled:bg-(--card-accent) hover:enabled:text-foreground hover:enabled:opacity-100 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 [@media(any-pointer:coarse)]:size-11",
  default: "bg-primary text-primary-foreground hover:enabled:bg-primary/90",
  destructive: "bg-destructive text-destructive-foreground hover:enabled:bg-destructive/90",
  secondary: "bg-secondary text-secondary-foreground hover:enabled:bg-secondary/80",
  selection: "relative border border-transparent bg-transparent text-card-foreground hover:enabled:border-(--border) hover:enabled:bg-(--card-accent) hover:enabled:text-card-foreground focus-visible:border-(--border) focus-visible:bg-(--card-accent) data-[state=on]:border-brand data-[state=on]:bg-(--brand-subtle) data-[state=mixed]:border-dashed data-[state=mixed]:border-(--muted-foreground) data-[state=on]:after:content-['✓'] data-[state=mixed]:after:content-['−'] after:absolute after:top-0 after:right-[0.1rem] after:text-[0.55rem] after:leading-none data-[emphasis]:border-(--muted-foreground) data-[emphasis]:bg-(--card-accent)",
  outline: "border border-(--border) bg-background text-foreground hover:enabled:bg-accent hover:enabled:text-accent-foreground",
};

const sizes = {
  custom: "",
  selection: "h-auto min-h-[1.8rem] min-w-[1.8rem] px-[0.4rem] py-[0.15rem] ub-type-caption [@media(any-pointer:coarse)]:min-w-11",
  default: "h-9 px-4 py-2 ub-type-ui",
  sm: "h-8 px-3 py-1 ub-type-ui",
  icon: "size-9 ub-type-ui [@media(any-pointer:coarse)]:min-w-11",
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
        "[@media(any-pointer:coarse)]:min-h-11 aria-invalid:border aria-invalid:border-destructive",
        variant !== "plain" && variant !== "tool" && variant !== "history" && "inline-flex shrink-0 items-center justify-center gap-2 rounded-(--radius-sm) font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}

export { Button };
