import { useEffect, useId, useState } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { Input } from "../ui/shadcn/input.js";
import { CHART_MIN_HEIGHT, CHART_MAX_HEIGHT } from "./chart-data.js";

function HeightField({ height, save }: { height: number | undefined; save: (height: number | undefined) => void }): ReactElement {
  const [value, setValue] = useState(height === undefined ? "" : String(height));
  const [error, setError] = useState("");
  const id = useId();
  useEffect(() => { setValue(height === undefined ? "" : String(height)); setError(""); }, [height]);
  const submit = (): void => {
    const pixels = Number(value);
    if (value !== "" && (!/^\d+$/.test(value) || !Number.isInteger(pixels) || pixels < CHART_MIN_HEIGHT || pixels > CHART_MAX_HEIGHT)) {
      setError(`Height must be a whole number of pixels from ${CHART_MIN_HEIGHT} to ${CHART_MAX_HEIGHT}`);
      return;
    }
    setError("");
    save(value === "" ? undefined : pixels);
  };
  return <form noValidate onSubmit={event => { event.preventDefault(); submit(); }}>
    <label htmlFor={id}>Height
      <Input id={id} value={value} inputMode="numeric" aria-invalid={error !== ""} aria-describedby={error === "" ? undefined : `${id}-error`}
        onChange={event => setValue(event.target.value)} onBlur={submit} />
    </label>
    {error !== "" && <p id={`${id}-error`} role="alert">{error}</p>}
  </form>;
}

export function chartHeightField(save: (height: number | undefined) => void): {
  element: HTMLDivElement; update: (height: number | undefined) => void; destroy: () => void;
} {
  const element = document.createElement("div");
  element.className = "ub-chart-height-fields";
  element.contentEditable = "false";
  const root = createRoot(element);
  return {
    element,
    update: height => root.render(<HeightField height={height} save={save} />),
    destroy: () => root.unmount(),
  };
}
