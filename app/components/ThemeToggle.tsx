"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

export type Theme = "dark" | "light";

/** The <html data-theme> attribute is the single source of truth — the head
 *  script sets it before first paint, so React reads it rather than owning it.
 *  Subscribing to it (instead of mirroring it into state from an effect) keeps
 *  the button correct on the very first frame and avoids a cascading render. */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const syncSavedTheme = (event: StorageEvent) => {
    if (event.key !== "nomin-theme") return;
    document.documentElement.setAttribute("data-theme", event.newValue === "dark" ? "dark" : "light");
  };
  window.addEventListener("storage", syncSavedTheme);
  return () => {
    observer.disconnect();
    window.removeEventListener("storage", syncSavedTheme);
  };
}

function getTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  // Light is the first-ever default; explicit choice persists across routes.
  const theme = useSyncExternalStore<Theme>(subscribe, getTheme, () => "light");

  // A full document navigation hydrates the server's light-default attribute.
  // Re-apply the same persisted choice after hydration so React can never
  // overwrite the pre-paint bootstrap with its static fallback.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("nomin-theme");
      document.documentElement.setAttribute("data-theme", saved === "dark" ? "dark" : "light");
    } catch { /* the pre-paint value remains authoritative */ }
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("nomin-theme", next); } catch { /* current page still updates */ }
  }

  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      className={compact ? "themeToggle compact" : "themeToggle"}
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
    >
      {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      {compact ? null : <span>{theme === "dark" ? "Light" : "Dark"}</span>}
    </button>
  );
}
