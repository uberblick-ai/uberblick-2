/**
 * Project-trimmed shadcn Sidebar: controlled Provider, left offcanvas panel,
 * its mobile Sheet, animated desktop gap, header/content/footer and menu.
 * Source (MIT; public/LICENSE-shadcn.txt):
 * https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/sidebar.tsx
 *
 * The app retains its localStorage preference and paired-control focus handoff.
 * Upstream's cookie and Cmd+B shortcut would change those contracts (Cmd+B is
 * editor bold). Mobile state is separate and unsaved, as in upstream.
 * No icon mode, rail, tooltip, Slot, variant helper or additional dependencies.
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
          "max-xl:[&>.ub-pane]:mt-11 max-xl:[&>.ub-document-pane]:[--pane-document-inset:1rem] max-xl:[&>.ub-document-pane]:[--document-rail-gap:1rem] xl:data-[sidebar-collapsed=true]:[&>.ub-document-pane]:[--pane-document-inset:4rem]",
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

export function SidebarHeader({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="sidebar-header" data-sidebar="header" className={cn("flex min-w-0 shrink-0 flex-col gap-2 p-2", className)} {...props} />;
}

export function SidebarContent({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="sidebar-content" data-sidebar="content" className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden", className)} {...props} />;
}

export function SidebarFooter({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="sidebar-footer" data-sidebar="footer" className={cn("flex min-w-0 shrink-0 flex-col gap-2 p-2", className)} {...props} />;
}

export function SidebarMenu({ className, ...props }: ComponentProps<"ul">): ReactElement {
  return <ul data-slot="sidebar-menu" data-sidebar="menu" className={cn("m-0 flex w-full min-w-0 list-none flex-col gap-1 p-0", className)} {...props} />;
}

export function SidebarMenuItem({ className, ...props }: ComponentProps<"li">): ReactElement {
  return <li data-slot="sidebar-menu-item" data-sidebar="menu-item" className={cn("group/menu-item relative min-w-0", className)} {...props} />;
}

/** Native-button default recipe; DropdownMenuTrigger supplies composition. */
export function SidebarMenuButton({ className, ...props }: ComponentProps<"button">): ReactElement {
  return (
    <button
      type="button"
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      className={cn(
        "peer/menu-button flex min-h-8 w-full min-w-0 items-center gap-2 rounded-(--radius-sm) p-2 text-left text-sm cursor-pointer [@media(any-pointer:coarse)]:min-h-11",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring disabled:pointer-events-none disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}
