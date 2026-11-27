import type { ReactElement } from "react";
import type { DocumentKind } from "@uberblick/schema";

/** The shared human-facing reading of lifecycle metadata. */
export function LifecycleBadge({
  kind,
}: {
  kind: DocumentKind | undefined;
}): ReactElement | null {
  if (kind !== "decision") return null;
  return (
    <span className="ub-badge ub-lifecycle-badge">
      Decision
    </span>
  );
}
