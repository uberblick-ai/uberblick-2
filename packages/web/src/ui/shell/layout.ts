import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useStoredFlag } from "../hooks.js";

/** Sidebar preference, persisted per browser. */
const SIDEBAR_COLLAPSED_KEY = "uberblick.sidebar.collapsed";
/** Exact complement of Tailwind xl, including fractional CSS widths. */
const NARROW_LAYOUT_QUERY = "(width < 80rem)";

export interface ShellLayout {
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  hideSidebar: RefObject<HTMLButtonElement | null>;
  restoreSidebar: RefObject<HTMLButtonElement | null>;
  narrowLayout: boolean;
  closeSidebarDrawer(): void;
  collapsed: boolean;
  setCollapsed(next: boolean): void;
  restoreSidebarFocus(event: Event): void;
  sidebarHidden: boolean;
  sidebarName: string;
  sidebarToggleLabel: string;
  sidebarCloseLabel: string;
}

/**
 * The sidebar and the threads rail share one narrow layout. `beforeChange`
 * runs on every reading, before React switches the layout branches.
 */
function useNarrowLayout(beforeChange: (narrow: boolean) => void): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_LAYOUT_QUERY).matches ?? false);
  const notify = useEffectEvent(beforeChange);
  useEffect(() => {
    const query = window.matchMedia?.(NARROW_LAYOUT_QUERY);
    if (query === undefined) return;
    const update = (): void => {
      notify(query.matches);
      setNarrow(query.matches);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function useShellLayout(settings: boolean): ShellLayout {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const hideSidebar = useRef<HTMLButtonElement | null>(null);
  const restoreSidebar = useRef<HTMLButtonElement | null>(null);
  const focusAfterNarrowing = useRef(false);
  const narrowLayout = useNarrowLayout((narrow) => {
    // Capture focus before switching branches unmounts the docked sidebar.
    focusAfterNarrowing.current = narrow && hideSidebar.current
      ?.closest('[data-slot="sidebar-container"]')
      ?.contains(document.activeElement) === true;
    setSidebarOpen(false);
  });
  useEffect(() => {
    if (!narrowLayout || !focusAfterNarrowing.current) return;
    focusAfterNarrowing.current = false;
    restoreSidebar.current?.focus();
  }, [narrowLayout]);
  const closeSidebarDrawer = useCallback(() => setSidebarOpen(false), []);
  const [collapsed, setCollapsed] = useStoredFlag(SIDEBAR_COLLAPSED_KEY, false);
  const previousCollapsed = useRef(collapsed);

  // A collapse makes its initiating control inert. Transfer focus to its
  // visible counterpart after portal focus scopes retire; initial stored
  // preference must not steal focus.
  useEffect(() => {
    if (previousCollapsed.current === collapsed) return;
    previousCollapsed.current = collapsed;
    if (!narrowLayout) (collapsed ? restoreSidebar : hideSidebar).current?.focus();
  }, [collapsed, narrowLayout]);
  const restoreSidebarFocus = useCallback((event: Event) => {
    event.preventDefault();
    (restoreSidebar.current ?? hideSidebar.current)?.focus();
  }, []);
  const sidebarHidden = narrowLayout ? !sidebarOpen : collapsed;
  const sidebarName = settings ? "sidebar" : "document list";
  const sidebarToggleLabel = `${sidebarHidden ? "Show" : "Hide"} ${sidebarName}`;
  const sidebarCloseLabel = narrowLayout ? `Close ${sidebarName}` : sidebarToggleLabel;

  return {
    sidebarOpen, setSidebarOpen, hideSidebar, restoreSidebar, narrowLayout,
    closeSidebarDrawer, collapsed, setCollapsed, restoreSidebarFocus,
    sidebarHidden, sidebarName, sidebarToggleLabel, sidebarCloseLabel,
  };
}
