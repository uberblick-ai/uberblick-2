import type { ReactElement } from "react";
import type { DocumentKind, DocumentStatus } from "@uberblick/schema";

const KIND_LABELS: Record<DocumentKind, string> = {
  requirement: "Product",
  decision: "Decision",
};

/** The shared human-facing reading of lifecycle metadata. */
export function LifecycleBadge({
  kind,
  status,
}: {
  kind: DocumentKind | undefined;
  status: DocumentStatus | undefined;
}): ReactElement | null {
  if (kind === undefined) return null;
  const label = KIND_LABELS[kind];
  return (
    <span className="ub-badge ub-lifecycle-badge">
      {status === undefined ? label : `${label} · ${status}`}
    </span>
  );
}
