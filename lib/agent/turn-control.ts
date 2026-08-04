// Process-local ownership of active turn cancellation.
//
// Browser disconnect and explicit user cancellation are different: a refresh
// may allow text-only work to finish and be saved, while the Stop button must
// always terminate the active turn. Keeping the controllers in one global map
// makes that distinction enforceable across hot-reloaded route modules.

const store = globalThis as typeof globalThis & {
  __trionActiveTurns?: Map<string, AbortController>;
};

const activeTurns = (store.__trionActiveTurns ??= new Map<string, AbortController>());

export function registerActiveTurn(sessionId: string, controller: AbortController) {
  activeTurns.get(sessionId)?.abort();
  activeTurns.set(sessionId, controller);
}

export function unregisterActiveTurn(sessionId: string, controller: AbortController) {
  if (activeTurns.get(sessionId) === controller) activeTurns.delete(sessionId);
}

export function cancelActiveTurn(sessionId: string): boolean {
  const controller = activeTurns.get(sessionId);
  if (!controller) return false;
  controller.abort();
  activeTurns.delete(sessionId);
  return true;
}

