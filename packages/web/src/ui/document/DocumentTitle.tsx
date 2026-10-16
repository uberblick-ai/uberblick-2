import type { ReactElement } from "react";

export function DocumentTitle({ value, readOnly, onChange }: {
  value: string; readOnly: boolean; onChange: (value: string) => void;
}): ReactElement {
  return <textarea
    className="ub-title"
    aria-label="Document title"
    value={value}
    placeholder="Untitled"
    rows={1}
    // Keep the name selectable and copyable when writes are unavailable.
    readOnly={readOnly}
    onKeyDown={(event) => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
    }}
    onChange={(event) => onChange(event.target.value.replace(/[\r\n]/g, ""))}
  />;
}
