import type { ReactElement } from "react";

export function DocumentTitle({ value, readOnly, onChange }: {
  value: string; readOnly: boolean; onChange: (value: string) => void;
}): ReactElement {
  return <input
    className="ub-title"
    aria-label="Document title"
    value={value}
    placeholder="Untitled"
    // Keep the name selectable and copyable when writes are unavailable.
    readOnly={readOnly}
    onChange={(event) => onChange(event.target.value)}
  />;
}
