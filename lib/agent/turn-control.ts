// Process-local ownership of active turn cancellation.
//
// Browser disconnect and explicit user cancellation are different: a refresh
// may allow text-only work to finish and be saved, while the Stop button must
// always terminate the active turn. Keeping the controllers in one global map
// makes that distinction enforceable across hot-reloaded route modules.

import { AsyncLocalStorage } from "node:async_hooks";

const store = globalThis as typeof globalThis & {
  __trionActiveTurns?: Map<string, AbortController>;
};

/**
 * The active turn's cancellation signal, made ambient for the whole request.
 *
 * Stop used to be threaded by hand into the few places that remembered to ask
 * for it, which meant most model calls — classification, planning, synthesis and
 * every review role — could not be cancelled at all. Pressing Stop left them
 * running to completion and only took effect at the next checkpoint between
 * stages.
 *
 * Making it ambient (the same way the BYOK provider already is) means the model
 * client can honour cancellation for EVERY call without any call site opting in,
 * so a call added later cannot silently be uncancellable. Callers may still pass
 * an explicit signal; it takes precedence.
 */
const turnSignalContext = new AsyncLocalStorage<AbortSignal>();

export function withTurnSignal<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  return signal ? turnSignalContext.run(signal, run) : run();
}

export function currentTurnSignal(): AbortSignal | undefined {
  return turnSignalContext.getStore();
}

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

