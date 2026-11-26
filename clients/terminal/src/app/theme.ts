/** Theme — dark (default) vs day mode. The choice is persisted and applied as data-theme on <html>;
 *  globals.css repaints every surface from the swapped CSS variables. */
import { useEffect, useState } from "react";

export type Theme = "dark" | "light";
const KEY = "tina.terminal.theme";

export function getTheme(): Theme {
  try { return localStorage.getItem(KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
}

export const THEME_CHANGED_EVENT = "tina:theme-changed";

export function applyTheme(t: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem(KEY, t); } catch { /* storage unavailable */ }
  try {
    window.dispatchEvent(new CustomEvent<Theme>(THEME_CHANGED_EVENT, { detail: t }));
  } catch { /* ignore in restricted environments */ }
}

/** Reactive theme state + a toggle, kept in sync with the DOM/localStorage. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    const t = getTheme();
    setTheme(t);
    document.documentElement.setAttribute("data-theme", t);
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<Theme>).detail;
      if (next === "dark" || next === "light") setTheme(next);
    };
    window.addEventListener(THEME_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onChanged);
  }, []);
  const toggle = () => setTheme((prev) => { const next = prev === "dark" ? "light" : "dark"; applyTheme(next); return next; });
  return [theme, toggle];
}
