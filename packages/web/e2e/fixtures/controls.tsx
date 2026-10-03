/** Test-only composition: Textarea has no product consumer in this pilot. */
import { createRoot } from "react-dom/client";
import { Button } from "../../src/ui/shadcn/button.js";
import { Input } from "../../src/ui/shadcn/input.js";
import { Textarea } from "../../src/ui/shadcn/textarea.js";
import "../../src/ui/styles.css";
import "../../src/ui/tailwind.css";

const root = document.getElementById("root");
if (root === null) throw new Error("no fixture root");

createRoot(root).render(
  <main style={{ padding: 16, background: "var(--card)", color: "var(--card-foreground)" }}>
    <section aria-label="Button recipes" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {(["default", "secondary", "outline"] as const).flatMap((variant) =>
        (["default", "sm", "icon"] as const).map((size) => (
          <Button key={`${variant}-${size}`} variant={variant} size={size} aria-label={`${variant} ${size}`}>
            {size === "icon" ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v12M2 8h12" stroke="currentColor" /></svg> : `${variant} ${size}`}
          </Button>
        )),
      )}
    </section>
    <section aria-label="Field recipes" style={{ display: "grid", gap: 8, marginBlock: 16 }}>
      <Input aria-label="Input" defaultValue="Field text" />
      <Textarea aria-label="Textarea" defaultValue="Field text" />
      <Input aria-label="Invalid Input" aria-invalid="true" defaultValue="Field text" />
      <Textarea aria-label="Invalid Textarea" aria-invalid="true" defaultValue="Field text" />
      <Button aria-invalid="true">Invalid Button</Button>
      <Button disabled>Disabled Button</Button>
      <Input aria-label="Disabled Input" defaultValue="Field text" disabled />
      <Textarea aria-label="Disabled Textarea" defaultValue="Field text" disabled />
    </section>
    <section aria-label="Browser focus references">
      <button type="button">Native Button</button>
      <input aria-label="Native Input" defaultValue="Field text" />
      <textarea aria-label="Native Textarea" defaultValue="Field text" />
    </section>
  </main>,
);
