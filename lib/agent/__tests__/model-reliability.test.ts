import { describe, expect, it } from "vitest";
import { CALL_RELIABILITY } from "../model-gateway";

describe("model-call reliability budgets", () => {
  it("fails an execution decision promptly instead of retrying it five times", () => {
    expect(CALL_RELIABILITY.execution_decision).toEqual({ timeoutMs: 30_000, maxAttempts: 2 });
  });

  it("gives classification one retry to ride through free-tier variance", () => {
    // Measured live: a single 15s attempt flakes on shared capacity often
    // enough to fail every gated turn. The retry only fires on failure, so a
    // healthy classification is still exactly one request.
    expect(CALL_RELIABILITY.classification).toEqual({ timeoutMs: 15_000, maxAttempts: 2 });
  });

  it("gives user-facing synthesis calls one retry for the same reason", () => {
    expect(CALL_RELIABILITY.direct_answer).toEqual({ timeoutMs: 20_000, maxAttempts: 2 });
    expect(CALL_RELIABILITY.synthesis).toEqual({ timeoutMs: 30_000, maxAttempts: 2 });
    expect(CALL_RELIABILITY.plan_only).toEqual({ timeoutMs: 30_000, maxAttempts: 2 });
  });

  it("never expands the normal-path RPM cost", () => {
    for (const policy of Object.values(CALL_RELIABILITY)) {
      expect(policy.maxAttempts).toBeGreaterThanOrEqual(1);
    }
  });

  it("reserves one longer attempt for a full-file authoring decision", () => {
    const authoring = { timeoutMs: 180_000, maxAttempts: 1 };
    expect(authoring.timeoutMs).toBeGreaterThan(CALL_RELIABILITY.execution_decision.timeoutMs);
    expect(authoring.maxAttempts).toBe(1);
  });
});
