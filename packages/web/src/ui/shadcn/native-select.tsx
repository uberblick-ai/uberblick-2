/**
 * shadcn/ui NativeSelect (MIT; public/LICENSE-shadcn.txt): the browser's
 * select keeps keyboard, touch and screen-reader behaviour, drawn to match
 * Input with one product chevron instead of the platform arrow.
 */
import type { ComponentProps, ReactElement } from "react";
import { cn } from "./cn.js";

function NativeSelect({ className, ...props }: ComponentProps<"select">): ReactElement {
  return (
    <div data-slot="native-select-wrapper" className="relative w-fit has-[select:disabled]:opacity-50">
      <select
        data-slot="native-select"
        className={cn(
          "h-9 min-h-6 [@media(any-pointer:coarse)]:min-h-11 w-full min-w-0 cursor-pointer appearance-none rounded-(--radius-sm) border border-input bg-background py-1 pr-8 pl-3 ub-type-ui [@media(any-pointer:coarse)]:ub-type-body text-foreground transition-colors hover:enabled:border-ring disabled:cursor-not-allowed aria-invalid:border-destructive",
          className,
        )}
        {...props}
      />
      <svg aria-hidden="true" viewBox="0 0 24 24" className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 fill-none stroke-current stroke-2 text-muted-foreground [stroke-linecap:round] [stroke-linejoin:round]">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
}

export { NativeSelect };
