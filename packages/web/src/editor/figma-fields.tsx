import { useId, useState } from "react";
import type { ReactElement } from "react";
import { normalizeFigmaLink, parseFigmaHeight } from "@uberblick/schema";
import { Input } from "../ui/shadcn/input.js";
import { Button } from "../ui/shadcn/button.js";

export interface FigmaFieldValues { url: string; title: string | null; height: string | null }

export function FigmaFields({ url, title, height, onSave, onDone, focusLink = false, discardInvalid = false, saveOnBlur = true }: {
  url: string; title: string; height: string;
  onSave: (values: FigmaFieldValues) => void;
  onDone: () => void;
  focusLink?: boolean;
  discardInvalid?: boolean;
  saveOnBlur?: boolean;
}): ReactElement {
  const [link, setLink] = useState(url);
  const [name, setName] = useState(title);
  const [size, setSize] = useState(height);
  const [error, setError] = useState("");
  const fieldId = useId();
  const save = (): boolean => {
    try {
      const normalized = normalizeFigmaLink(link).url;
      const pixels = size === "" ? null : String(parseFigmaHeight(size));
      onSave({ url: normalized, title: name.replace(/[\r\n]+/g, " ") || null, height: pixels });
      setLink(normalized);
      setError("");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };
  const blur = (): void => { if (saveOnBlur) save(); };
  return (
    <form className="ub-figma-fields" noValidate onSubmit={(event) => {
      event.preventDefault();
      if (save() || discardInvalid) onDone();
    }}>
      <label htmlFor={`${fieldId}-url`}>Figma link
        <Input id={`${fieldId}-url`} value={link} type="url" aria-invalid={error !== ""} onChange={(event) => setLink(event.target.value)}
          onBlur={blur}
          autoFocus={focusLink} />
      </label>
      <label htmlFor={`${fieldId}-title`}>Title
        <Input id={`${fieldId}-title`} value={name} onChange={(event) => setName(event.target.value)} onBlur={blur} />
      </label>
      <label htmlFor={`${fieldId}-height`}>Height
        <Input id={`${fieldId}-height`} value={size} inputMode="numeric" placeholder="480" onChange={(event) => setSize(event.target.value)} onBlur={blur} />
      </label>
      {error !== "" && <p role="alert">{error}</p>}
      <Button variant="plain" size="custom" type="submit" hidden>Done</Button>
    </form>
  );
}
