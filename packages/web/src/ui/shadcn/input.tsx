/**
 * shadcn/ui Input, with product tokens, touch floors and native focus.
 * MIT; public/LICENSE-shadcn.txt.
 */
import type { ComponentProps, ReactElement } from "react";
import { cn } from "./cn.js";

function Input({ className, type, ...props }: ComponentProps<"input">): ReactElement {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 min-h-6 pointer-coarse:min-h-11 w-full min-w-0 rounded-(--radius-sm) border border-solid border-input bg-background px-3 py-1 text-sm pointer-coarse:text-base text-foreground transition-colors selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive file:inline-flex file:border-0 file:bg-transparent file:text-sm pointer-coarse:file:text-base file:font-medium file:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
