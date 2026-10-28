import type { CodeCheck } from "@uberblick/schema";
import { Button } from "../shadcn/button.js";
import { PopoverTrigger } from "../shadcn/popover.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../shadcn/tooltip.js";
import { useTimestampClock } from "../timestamps.js";
import { staleCodeCheckAgeDays } from "./code-check-age.js";

export function CodeCheckTrigger({ codeChecks }: { codeChecks: readonly CodeCheck[] }) {
  const clock = useTimestampClock();
  const now = Math.max(clock, Date.now());
  const staleAges = codeChecks.flatMap((check) => {
    const days = staleCodeCheckAgeDays(check.checked_at, now);
    return days === null ? [] : [days];
  });
  const label = staleAges.length === 0 ? "Code check" : `Code check · code check ${Math.max(...staleAges)} days old`;
  return <TooltipProvider><Tooltip>
    <TooltipTrigger asChild><PopoverTrigger asChild>
      <Button variant="plain" size="custom" type="button"
        className="ub-status-code-check inline-flex size-6 flex-none items-center justify-center rounded-(--radius-sm) border-0 bg-transparent p-0 text-(--muted-foreground) hover:bg-(--card-accent) focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 [@media(any-pointer:coarse)]:min-w-11"
        aria-label={label} title={label}>
        <span className="ub-sync-code-mark" aria-hidden="true">{"</>"}</span>
      </Button>
    </PopoverTrigger></TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip></TooltipProvider>;
}
