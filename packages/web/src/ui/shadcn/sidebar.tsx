/**
 * Project-trimmed shadcn Sidebar: controlled Provider, left offcanvas panel,
 * its mobile Sheet, and its animated desktop gap. Source (MIT):
 * https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/sidebar.tsx
 *
 * The app retains its localStorage preference and paired-control focus handoff.
 * Upstream's cookie and Cmd+B shortcut would change those contracts (Cmd+B is
 * editor bold). Mobile state is separate and unsaved, as in upstream.
 * No menu primitives, icon mode, rail, tooltip, or additional dependencies.
 */
import { createContext, useContext } from "react";
import type { ComponentProps, ReactElement } from "react";
import { cn } from "./cn.js";
import { Sheet, SheetContent, SheetTitle } from "./sheet.js";

type SidebarState = {
  open: boolean;
  narrow: boolean;
  openMobile: boolean;
  onOpenMobileChange?: ((open: boolean) => void) | undefined;
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
};

const SidebarContext = createContext<SidebarState | null>(null);

export function useSidebar(): SidebarState {
  const context = useContext(SidebarContext);
  if (context === null) throw new Error("Sidebar requires SidebarProvider");
  return context;
}

export const SIDEBAR_TOGGLE_CLASSES = "absolute z-4 size-8 cursor-pointer rounded-(--radius-sm) border font-[inherit] [font-size:inherit] leading-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function SidebarProvider({
  open,
  narrow = false,
  openMobile = false,
  onOpenMobileChange,
  onCloseAutoFocus,
  className,
  children,
  ...props
}: ComponentProps<"div"> & Omit<SidebarState, "narrow" | "openMobile"> & {
  narrow?: boolean;
  openMobile?: boolean;
}): ReactElement {
  return (
    <SidebarContext.Provider
      value={{ open, narrow, openMobile, onOpenMobileChange, onCloseAutoFocus }}
    >
      <div
        data-slot="sidebar-wrapper"
        data-state={open ? "expanded" : "collapsed"}
        className={cn(
          "relative flex min-h-0 flex-1",
          // Keep scrolling content below the narrow opener; docked collapse uses an inset.
          "max-xl:[&>.ub-pane]:mt-11 max-xl:[&>.ub-document-pane]:[--pane-document-inset:1rem] xl:data-[sidebar-collapsed=true]:[&>.ub-document-pane]:[--pane-document-inset:4rem]",
          // Keep the pane's Threads control above its scrollport too.
          "[&_.ub-pane-threads-toggle]:absolute [&_.ub-pane-threads-toggle]:top-3 [&_.ub-pane-threads-toggle]:z-4 [&_.ub-pane-threads-toggle]:self-end",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function Sidebar({
  className,
  children,
  onEscapeKeyDown,
  ...props
}: ComponentProps<"aside"> & {
  onEscapeKeyDown?: ComponentProps<typeof SheetContent>["onEscapeKeyDown"];
}): ReactElement {
  const { open, narrow, openMobile, onOpenMobileChange, onCloseAutoFocus } = useSidebar();
  if (narrow) {
    return (
      <Sheet open={openMobile} onOpenChange={(shown) => onOpenMobileChange?.(shown)}>
        <SheetContent
          side="left"
          showClose={false}
          className="p-0"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => onCloseAutoFocus?.(event)}
          onEscapeKeyDown={(event) => onEscapeKeyDown?.(event)}
        >
          <SheetTitle className="sr-only">Sidebar</SheetTitle>
          <aside
            {...props}
            data-slot="sidebar-container"
            data-mobile="true"
            className={cn("relative flex min-h-0 flex-1 flex-col", className)}
          >
            {children}
          </aside>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <div
      data-slot="sidebar"
      data-state={open ? "expanded" : "collapsed"}
      data-collapsible={open ? "" : "offcanvas"}
      className="group shrink-0 text-sidebar-foreground"
    >
      <div
        data-slot="sidebar-gap"
        className="relative hidden h-full w-(--sidebar-width) bg-transparent transition-[width] duration-[180ms] ease-[ease] group-data-[collapsible=offcanvas]:w-0 motion-reduce:transition-none xl:block"
      />
      <aside
        {...props}
        data-slot="sidebar-container"
        aria-hidden={!open}
        inert={!open}
        className={cn(
          "absolute inset-y-0 left-0 z-5 flex w-(--sidebar-width) flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[left] duration-[180ms] ease-[ease] group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] group-data-[collapsible=offcanvas]:pointer-events-none group-data-[collapsible=offcanvas]:[&_.ub-sidebar-hide]:invisible motion-reduce:transition-none",
          className,
        )}
      >
        {children}
      </aside>
    </div>
  );
}
