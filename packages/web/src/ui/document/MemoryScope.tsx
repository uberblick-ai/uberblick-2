import type { ReactElement } from "react";
import type { DirectoryEntry } from "@uberblick/schema";

/** Read-only scope shared by memory rows and the open document. */
export function MemoryScope({ kind, agent, repository }: {
  kind: DirectoryEntry["kind"];
  agent: string | undefined;
  repository: string | undefined;
}): ReactElement | null {
  if (kind !== "memory") return null;
  return <span className="ub-memory-scope block min-w-0 ub-type-small font-normal text-muted-foreground [overflow-wrap:anywhere]">
    {agent === undefined ? "All agents" : `Agent: ${agent}`}
    {repository !== undefined && <> · Repository: {repository}</>}
  </span>;
}
