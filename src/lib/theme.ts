export type Theme = "light" | "dark";

const KEY = "nomin.theme";

/**
 * Theme resolution, in priority order:
 *   1. what the user picked here before (survives a hard refresh),
 *   2. the operating system's preference,
 *   3. light.
 *
 * Storage can throw in a private window or with site data blocked, so every
 * access is guarded and the app still works with none of it available.
 */
export function readTheme(): Theme {
  const stored = safeGet();
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark() ? "dark" : "light";
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* the choice just will not persist */
  }
}

/** True once the user has made an explicit choice — the OS stops overriding. */
export function hasStoredTheme(): boolean {
  const stored = safeGet();
  return stored === "light" || stored === "dark";
}

/**
 * Follow the OS while the user has not chosen for themselves. Returns an
 * unsubscribe function.
 */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const query = matchMedia("(prefers-color-scheme: dark)");
  const handler = (event: MediaQueryListEvent) => {
    if (!hasStoredTheme()) onChange(event.matches ? "dark" : "light");
  };
  query.addEventListener("change", handler);
  return () => query.removeEventListener("change", handler);
}

function prefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

function safeGet(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
