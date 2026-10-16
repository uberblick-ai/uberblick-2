/** Trimmed shadcn Collapsible; the public Radix primitive owns interaction. */
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import type { ComponentProps, ReactElement } from "react";

function Collapsible(props: ComponentProps<typeof CollapsiblePrimitive.Root>): ReactElement {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger(props: ComponentProps<typeof CollapsiblePrimitive.Trigger>): ReactElement {
  return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent(props: ComponentProps<typeof CollapsiblePrimitive.Content>): ReactElement {
  return <CollapsiblePrimitive.Content data-slot="collapsible-content" {...props} />;
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
