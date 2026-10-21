import { useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../shadcn/tooltip.js";

/** Keep the longest trailing folder suffix that fits; only oversized basenames lose letters. */
export function shortenCodePath(path: string, width: number, measure: (text: string) => number): string {
  if (measure(path) <= width) return path;
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    const suffix = `…/${path.slice(slash + 1)}`;
    if (measure(suffix) <= width) return suffix;
  }
  const slash = path.lastIndexOf("/");
  const prefix = slash === -1 ? "" : "…/";
  const filename = Array.from(path.slice(slash + 1));
  while (filename.length > 0 && measure(`${prefix}${filename.join("")}…`) > width) filename.pop();
  return `${prefix}${filename.join("")}…`;
}

function CodeCheckPath({ path, focusAfterExpansion = false }: {
  path: string;
  focusAfterExpansion?: boolean;
}): ReactElement {
  const row = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(path);
  useLayoutEffect(() => {
    const element = row.current;
    if (element === null) return;
    let active = true;
    const updatePath = (): void => {
      const width = element.getBoundingClientRect().width;
      if (!active || width === 0) return;
      const context = document.createElement("canvas").getContext("2d");
      if (context === null) return;
      const style = getComputedStyle(element);
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const spacing = Number.parseFloat(style.letterSpacing) || 0;
      setShown(shortenCodePath(path, width, (text) => context.measureText(text).width + Math.max(0, Array.from(text).length - 1) * spacing));
    };
    updatePath();
    const observer = new ResizeObserver(updatePath);
    observer.observe(element);
    void document.fonts?.ready.then(updatePath);
    document.fonts?.addEventListener("loadingdone", updatePath);
    return () => {
      active = false;
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", updatePath);
    };
  }, [path]);
  useLayoutEffect(() => {
    if (focusAfterExpansion) row.current?.focus();
  }, [focusAfterExpansion]);
  const shortened = shown !== path;
  return <Tooltip>
    <TooltipTrigger asChild>
      <span ref={row} className="ub-code-check-path block min-w-0 flex-1 overflow-hidden whitespace-nowrap"
        tabIndex={shortened || focusAfterExpansion ? 0 : undefined}>
        <span className="sr-only">{path}</span>
        <span className="ub-code-check-path-text" aria-hidden="true">{shown}</span>
      </span>
    </TooltipTrigger>
    {shortened && <TooltipContent>{path}</TooltipContent>}
  </Tooltip>;
}

export function CodeCheckPaths({ paths }: { paths: readonly string[] }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  return <TooltipProvider>
    {expanded ? <div className="flex min-w-0 flex-col">
      {paths.map((path, index) => <CodeCheckPath key={path} path={path} focusAfterExpansion={index === 0} />)}
    </div> : <div className="flex min-w-0 items-center gap-2">
      <CodeCheckPath path={paths[0] ?? ""} />
      {paths.length > 1 && <button type="button"
        className="min-h-6 shrink-0 cursor-pointer whitespace-nowrap border-0 bg-transparent p-0 font-sans text-foreground underline [@media(any-pointer:coarse)]:min-h-11"
        onClick={() => setExpanded(true)}>+{paths.length - 1} more</button>}
    </div>}
  </TooltipProvider>;
}
