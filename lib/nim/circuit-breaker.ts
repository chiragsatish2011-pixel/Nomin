/**
 * Provider circuit breaker for a shared API budget.
 *
 * It opens only after consecutive rate-limit responses, not after arbitrary
 * task failures. A malformed prompt, a timeout, and a 429 are different
 * recovery problems; combining them made the old breaker hard to reason about
 * and could reject unrelated healthy work.
 */
export type CircuitBreakerOptions = {
  failureLimit?: number;
  openMs?: number;
  now?: () => number;
};

export function createCircuitBreaker(options: CircuitBreakerOptions = {}) {
  const failureLimit = options.failureLimit ?? 5;
  const openMs = options.openMs ?? 60_000;
  const now = options.now ?? Date.now;
  let consecutiveRateLimits = 0;
  let openUntil = 0;

  function isOpen() {
    return now() < openUntil;
  }

  function noteRateLimit() {
    consecutiveRateLimits += 1;
    if (consecutiveRateLimits >= failureLimit) {
      openUntil = now() + openMs;
      consecutiveRateLimits = 0;
      return true;
    }
    return false;
  }

  /** Any non-429 response breaks a consecutive-429 sequence. */
  function breakSequence() {
    consecutiveRateLimits = 0;
  }

  function reset() {
    consecutiveRateLimits = 0;
    openUntil = 0;
  }

  function snapshot() {
    return {
      state: isOpen() ? "open" as const : "closed" as const,
      consecutiveRateLimits,
      retryAfterMs: Math.max(0, openUntil - now()),
    };
  }

  return { isOpen, noteRateLimit, breakSequence, reset, snapshot };
}
