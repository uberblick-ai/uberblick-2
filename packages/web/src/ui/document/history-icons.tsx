import type { ReactElement } from "react";

const STROKE = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function TagIcon(): ReactElement {
  return <svg className="ub-history-tag" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" {...STROKE} strokeWidth="1.5">
    <path d="M2.5 2.5h5l6 6-5 5-6-6zM5.25 5.25h.01" />
  </svg>;
}

export function PreviousIcon(): ReactElement {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...STROKE} strokeWidth="1.7"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>;
}

export function NextIcon(): ReactElement {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...STROKE} strokeWidth="1.7"><path d="M6 3.5 10.5 8 6 12.5" /></svg>;
}

export function UpIcon(): ReactElement {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...STROKE} strokeWidth="1.7"><path d="M3.5 10 8 5.5l4.5 4.5" /></svg>;
}

export function DownIcon(): ReactElement {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...STROKE} strokeWidth="1.7"><path d="M3.5 6 8 10.5 12.5 6" /></svg>;
}

export function ClockIcon(): ReactElement {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...STROKE} strokeWidth="1.4">
    <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.2h2.2M8 5v3l2 1.3" />
  </svg>;
}
