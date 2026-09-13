import { describe, it, expect } from "vitest";
import { createRateGovernor, estimateCallTokens } from "../../nim/rate-governor";
import { retryDelayMs, isProviderRateLimited, isRetryable, defaultDispatchIntervalMs } from "../../nim/internal-client";

/** A governor driven by a clock the test moves by hand, so none of this waits. */
function harness(overrides: Parameters<typeof createRateGovernor>[0] = {}) {
  let clock = 1_000_000;
  const governor = createRateGovernor({ now: () => clock, ...overrides });
  return {
    governor,
    advance: (ms: number) => {
      clock += ms;
    },
    at: () => clock,
  };
}

describe("rate governor — request rate", () => {
  it("uses a small pacing margin below a 40-RPM shared ceiling", () => {
    expect(defaultDispatchIntervalMs(40)).toBe(1_600);
    // 1.6s means 37.5 request starts/minute: protective without reducing the
    // available shared budget to the 20 RPM a 3-second gap would impose.
    expect(60_000 / defaultDispatchIntervalMs(40)).toBeLessThan(40);
    expect(defaultDispatchIntervalMs(0)).toBe(0);
  });

  it("admits up to the ceiling without delay, then makes the next call wait", () => {
    const { governor } = harness({ rpm: 3 });

    for (let i = 0; i < 3; i++) {
      expect(governor.waitMs(0)).toBe(0);
      governor.charge(0);
    }

    // Fourth call in the same window has to wait for the first to age out.
    expect(governor.waitMs(0)).toBe(60_000);
  });

  it("frees a slot exactly when the oldest request leaves the 60s window", () => {
    const { governor, advance } = harness({ rpm: 2 });

    governor.charge(0);
    advance(10_000);
    governor.charge(0);

    // The oldest was 10s ago, so 50s remain on it.
    expect(governor.waitMs(0)).toBe(50_000);

    advance(50_000);
    expect(governor.waitMs(0)).toBe(0);
  });

  it("treats rpm=0 as ungoverned", () => {
    const { governor } = harness({ rpm: 0 });
    for (let i = 0; i < 100; i++) governor.charge(0);
    expect(governor.waitMs(0)).toBe(0);
  });
});

describe("rate governor — token rate", () => {
  it("delays a call that would exceed the token window", () => {
    const { governor, advance } = harness({ rpm: 0, tpm: 1000 });

    governor.charge(600);
    advance(5_000);

    // 600 used, 500 more would be 1100 > 1000.
    expect(governor.waitMs(500)).toBe(55_000);
    // 400 more fits exactly at the limit.
    expect(governor.waitMs(400)).toBe(0);
  });

  it("admits a single call larger than the whole window rather than deadlocking", () => {
    const { governor } = harness({ rpm: 0, tpm: 1000 });
    // No amount of waiting makes a 5000-token call fit a 1000-token window.
    // Blocking forever would make large legitimate requests impossible.
    expect(governor.waitMs(5000)).toBe(0);
  });

  it("settles the pessimistic estimate down to what was actually billed", () => {
    const { governor } = harness({ rpm: 0, tpm: 1000 });

    // Estimated 800 (prompt + the full max_tokens ceiling)…
    governor.charge(800);
    expect(governor.waitMs(300)).toBeGreaterThan(0);

    // …but the provider billed 200. The window should reflect reality.
    governor.settle(800, 200);
    expect(governor.waitMs(300)).toBe(0);
    expect(governor.snapshot().tokensInWindow).toBe(200);
  });

  it("settles overlapping requests against their own charge, not the last dispatched one", () => {
    const { governor } = harness({ rpm: 0, tpm: 5_000 });

    const earlier = governor.charge(1_000);
    const later = governor.charge(2_000);

    // The earlier request completes after the later request was dispatched.
    governor.settle(1_000, 100, earlier);
    expect(governor.snapshot().tokensInWindow).toBe(2_100);

    governor.settle(2_000, 200, later);
    expect(governor.snapshot().tokensInWindow).toBe(300);
  });
});

describe("rate governor — AIMD adaptation", () => {
  it("halves the effective ceiling on a rate-limit hit", () => {
    const { governor } = harness({ rpm: 40 });
    expect(governor.snapshot().effectiveRpm).toBe(40);

    governor.penalize();
    expect(governor.snapshot().effectiveRpm).toBe(20);

    governor.penalize();
    expect(governor.snapshot().effectiveRpm).toBe(10);
  });

  it("never adapts below the floor", () => {
    const { governor } = harness({ rpm: 40, minRpm: 4 });
    for (let i = 0; i < 20; i++) governor.penalize();
    expect(governor.snapshot().effectiveRpm).toBe(4);
  });

  it("claws throughput back one request per quiet minute, up to the configured ceiling", () => {
    const { governor, advance } = harness({ rpm: 10 });

    governor.penalize();
    expect(governor.snapshot().effectiveRpm).toBe(5);

    advance(60_000);
    expect(governor.snapshot().effectiveRpm).toBe(6);

    advance(180_000);
    expect(governor.snapshot().effectiveRpm).toBe(9);

    advance(600_000);
    expect(governor.snapshot().effectiveRpm).toBe(10);
  });

  it("applies the reduced ceiling to admission, not just the readout", () => {
    const { governor } = harness({ rpm: 8 });
    governor.penalize(); // ceiling now 4

    for (let i = 0; i < 4; i++) {
      expect(governor.waitMs(0)).toBe(0);
      governor.charge(0);
    }
    expect(governor.waitMs(0)).toBeGreaterThan(0);
  });
});

describe("estimateCallTokens", () => {
  it("budgets for the completion ceiling, not just the prompt", () => {
    const messages = [{ content: "x".repeat(400) }];
    // 400 chars ≈ 100 prompt tokens, plus the 500 the model is allowed to emit.
    expect(estimateCallTokens(messages, 500)).toBe(600);
  });
});

describe("retry delay", () => {
  it("prefers retry-after-ms over everything else", () => {
    expect(retryDelayMs(1, { headers: { "retry-after-ms": "1500" } })).toBe(1500);
  });

  it("reads retry-after as seconds", () => {
    expect(retryDelayMs(1, { headers: { "retry-after": "12" } })).toBe(12_000);
  });

  it("reads retry-after as an HTTP date", () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const delay = retryDelayMs(1, { headers: { "retry-after": future } });
    expect(delay).toBeGreaterThan(40_000);
    expect(delay).toBeLessThanOrEqual(46_000);
  });

  it("does NOT cap a server-specified delay at the guess ceiling", () => {
    // Capping this is how a client retries back into a limit that has not reset,
    // spending a request to be told the same thing again.
    expect(retryDelayMs(1, { headers: { "retry-after": "120" } })).toBe(120_000);
  });

  it("falls back to exponential backoff when the response says nothing", () => {
    expect(retryDelayMs(1)).toBeGreaterThanOrEqual(1000);
    expect(retryDelayMs(1)).toBeLessThan(1250);
    expect(retryDelayMs(2)).toBeGreaterThanOrEqual(2000);
    expect(retryDelayMs(2)).toBeLessThan(2250);
    expect(retryDelayMs(3)).toBeGreaterThanOrEqual(4000);
    expect(retryDelayMs(3)).toBeLessThan(4250);
  });

  it("caps only the guess at 30s", () => {
    expect(retryDelayMs(10)).toBe(30_000);
  });
});

describe("retryability", () => {
  function apiError(status: number | undefined, body = "") {
    const error = new Error(`HTTP ${status}`) as Error & { status?: number; body?: string };
    error.status = status;
    error.body = body;
    return error;
  }

  it("retries 429 and 5xx", () => {
    expect(isRetryable(apiError(429))).toBe(true);
    expect(isRetryable(apiError(500))).toBe(true);
    expect(isRetryable(apiError(503))).toBe(true);
  });

  it("does not retry ordinary 4xx", () => {
    expect(isRetryable(apiError(400))).toBe(false);
    expect(isRetryable(apiError(401))).toBe(false);
    expect(isRetryable(apiError(404))).toBe(false);
  });

  it("never retries a context-overflow failure, even behind a retryable status", () => {
    // Five attempts produce five identical failures and spend five requests
    // against the ceiling for a result that was available immediately.
    expect(isRetryable(apiError(400, "This model's maximum context length is 128000 tokens"))).toBe(false);
    expect(isRetryable(apiError(429, "context_length_exceeded"))).toBe(false);
    expect(isRetryable(apiError(500, "too many tokens in prompt"))).toBe(false);
  });

  it("detects a rate limit reported in the body without a status code", () => {
    expect(isRetryable(apiError(undefined, "Rate limit reached for model"))).toBe(true);
    expect(isRetryable(apiError(undefined, "Too Many Requests"))).toBe(true);
    expect(isRetryable(apiError(undefined, "rate increased too quickly"))).toBe(true);
  });

  it("recognises the provider's 503 ResourceExhausted quota envelope as a shared rate limit", () => {
    expect(isProviderRateLimited(apiError(503, "ResourceExhausted: Worker local total request limit reached (33/32)"))).toBe(true);
    expect(isProviderRateLimited(apiError(503, "temporary upstream maintenance"))).toBe(false);
  });

  it("retries transport failures that carry no status at all", () => {
    expect(isRetryable(new Error("Trion request timed out."))).toBe(true);
  });
});
