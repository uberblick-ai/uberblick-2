/**
 * shadcn/ui Textarea, with product tokens, touch floors and native focus.
 * MIT; public/LICENSE-shadcn.txt.
 */
import type { ComponentProps, ReactElement } from "react";
import { cn } from "./cn.js";

function Textarea({ className, ...props }: ComponentProps<"textarea">): ReactElement {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full min-w-0 rounded-(--radius-sm) border border-solid border-input bg-background px-3 py-2 text-sm pointer-coarse:text-base text-foreground transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
