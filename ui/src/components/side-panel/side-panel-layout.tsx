import { createContext, useCallback, useContext, useEffect, useState } from "react";

const WIDE_MARGINS_STORAGE_KEY = "paperclip:side-panel-wide-margins";

/**
 * Layout state the maximized side-panel host shares with its hosted content.
 * Hosted content that renders a centered reading column (documents, skills)
 * registers itself as a wide-margins target so the host only offers the
 * margins toggle when it has an effect, and reads `wideMargins` to drop the
 * column cap while maximized.
 */
export interface SidePanelLayoutValue {
  maximized: boolean;
  /** True only while maximized with the "wide margins" preference on. */
  wideMargins: boolean;
  registerWideMarginsTarget: () => () => void;
}

const SidePanelLayoutContext = createContext<SidePanelLayoutValue>({
  maximized: false,
  wideMargins: false,
  registerWideMarginsTarget: () => () => {},
});

export const SidePanelLayoutProvider = SidePanelLayoutContext.Provider;

export function useSidePanelLayout(): SidePanelLayoutValue {
  return useContext(SidePanelLayoutContext);
}

/** Registers the caller as a wide-margins target while `active` is true. */
export function useWideMarginsTarget(active: boolean): boolean {
  const { wideMargins, registerWideMarginsTarget } = useSidePanelLayout();
  useEffect(() => (active ? registerWideMarginsTarget() : undefined), [active, registerWideMarginsTarget]);
  return active && wideMargins;
}

/** Counts mounted wide-margins targets for the host. */
export function useWideMarginsTargetCount(): [number, () => () => void] {
  const [count, setCount] = useState(0);
  const register = useCallback(() => {
    setCount((current) => current + 1);
    return () => setCount((current) => current - 1);
  }, []);
  return [count, register];
}

export function readWideMarginsPreference(): boolean {
  try {
    return localStorage.getItem(WIDE_MARGINS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeWideMarginsPreference(wide: boolean) {
  try {
    localStorage.setItem(WIDE_MARGINS_STORAGE_KEY, String(wide));
  } catch {
    // Ignore storage failures.
  }
}
