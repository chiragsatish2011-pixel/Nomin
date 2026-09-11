import { describe, expect, it } from "vitest";
import { CALL_RELIABILITY } from "../model-gateway";

describe("model-call reliability budgets", () => {
  it("fails an execution decision promptly instead of retrying it five times", () => {
    expect(CALL_RELIABILITY.execution_decision).toEqual({ timeoutMs: 30_000, maxAttempts: 2 });
  });

  it("keeps classification to one low-latency attempt", () => {
    expect(CALL_RELIABILITY.classification).toEqual({ timeoutMs: 15_000, maxAttempts: 1 });
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
