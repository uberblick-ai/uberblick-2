/** Trimmed shadcn Tabs; the public Radix primitive owns interaction. */
import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentProps, ReactElement } from "react";

function Tabs(props: ComponentProps<typeof TabsPrimitive.Root>): ReactElement {
  return <TabsPrimitive.Root data-slot="tabs" {...props} />;
}

function TabsList(props: ComponentProps<typeof TabsPrimitive.List>): ReactElement {
  return <TabsPrimitive.List data-slot="tabs-list" {...props} />;
}

function TabsTrigger(props: ComponentProps<typeof TabsPrimitive.Trigger>): ReactElement {
  return <TabsPrimitive.Trigger data-slot="tabs-trigger" {...props} />;
}

function TabsContent(props: ComponentProps<typeof TabsPrimitive.Content>): ReactElement {
  return <TabsPrimitive.Content data-slot="tabs-content" {...props} />;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
