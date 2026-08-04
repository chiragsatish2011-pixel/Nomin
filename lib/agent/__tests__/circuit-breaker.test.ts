import { describe, expect, it } from "vitest";
import { createCircuitBreaker } from "../../nim/circuit-breaker";

describe("provider circuit breaker", () => {
  it("opens only after five consecutive 429s, then recovers after its cooldown", () => {
    let now = 1_000;
    const breaker = createCircuitBreaker({ failureLimit: 5, openMs: 60_000, now: () => now });

    for (let i = 0; i < 4; i++) {
      expect(breaker.noteRateLimit()).toBe(false);
      expect(breaker.isOpen()).toBe(false);
    }

    expect(breaker.noteRateLimit()).toBe(true);
    expect(breaker.snapshot()).toEqual({ state: "open", consecutiveRateLimits: 0, retryAfterMs: 60_000 });

    now += 60_000;
    expect(breaker.isOpen()).toBe(false);
  });

  it("does not carry a rate-limit sequence across a non-429 outcome", () => {
    const breaker = createCircuitBreaker({ failureLimit: 5 });
    breaker.noteRateLimit();
    breaker.noteRateLimit();
    breaker.breakSequence();
    expect(breaker.snapshot().consecutiveRateLimits).toBe(0);
  });
});
