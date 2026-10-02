/**
 * Project-trimmed shadcn Sidebar: controlled Provider, left offcanvas panel,
 * and its animated desktop gap. Source (MIT):
 * https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/sidebar.tsx
 *
 * The app retains its localStorage preference and paired-control focus handoff.
 * Upstream's cookie and Cmd+B shortcut would change those contracts (Cmd+B is
 * editor bold). Its independent mobile Sheet state is omitted in this spike:
 * the same controlled state continues to present a nonmodal mobile overlay.
 * No menu primitives, icon mode, rail, tooltip, or additional dependencies.
 */
import { createContext, useContext } from "react";
import type { ComponentProps, ReactElement } from "react";
import { cn } from "./cn.js";

const SidebarContext = createContext<{ open: boolean } | null>(null);

export function SidebarProvider({
  open,
  className,
  children,
  ...props
}: ComponentProps<"div"> & { open: boolean }): ReactElement {
  return (
    <SidebarContext.Provider value={{ open }}>
      <div
        data-slot="sidebar-wrapper"
        data-state={open ? "expanded" : "collapsed"}
        className={cn("relative flex min-h-0 flex-1", className)}
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
  ...props
}: ComponentProps<"aside">): ReactElement {
  const context = useContext(SidebarContext);
  if (context === null) throw new Error("Sidebar requires SidebarProvider");
  const { open } = context;
  return (
    <div
      data-slot="sidebar"
      data-state={open ? "expanded" : "collapsed"}
      data-collapsible={open ? "" : "offcanvas"}
      className="group shrink-0 text-sidebar-foreground"
    >
      <div
        data-slot="sidebar-gap"
        className="relative hidden h-full w-(--sidebar-width) bg-transparent transition-[width] duration-[180ms] ease-[ease] group-data-[collapsible=offcanvas]:w-0 motion-reduce:transition-none md:block"
      />
      <aside
        {...props}
        data-slot="sidebar-container"
        aria-hidden={!open}
        inert={!open}
        className={cn(
          "absolute inset-y-0 left-0 z-5 flex w-[min(var(--sidebar-width),85vw)] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-[8px_0_24px_rgb(0_0_0/0.18)] transition-[left] duration-[180ms] ease-[ease] group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] group-data-[collapsible=offcanvas]:shadow-none group-data-[collapsible=offcanvas]:pointer-events-none group-data-[collapsible=offcanvas]:[&_.ub-sidebar-hide]:invisible motion-reduce:transition-none md:w-(--sidebar-width) md:shadow-none",
          className,
        )}
      >
        {children}
      </aside>
    </div>
  );
}
