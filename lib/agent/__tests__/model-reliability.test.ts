import { describe, expect, it } from "vitest";
import { CALL_RELIABILITY } from "../model-gateway";

describe("model-call reliability budgets", () => {
  // These used to pin exact millisecond constants, which meant re-measuring the
  // provider (the thing that should drive these numbers) broke the suite while
  // changing nothing about the property under test. They now assert the
  // PROPERTIES the budgets exist to guarantee.
  //
  // Live measurement, single-key lane (2026-09-18):
  //   fast tier    (super-120b) : 11.8s / 11.9s  — consistent
  //   primary tier (ultra-550b) :  3.2s / 71.6s  — high variance
  it("bounds an execution decision without retrying it five times", () => {
    // Runs on the primary tier and authors whole files, so it must tolerate the
    // 71.6s worst case rather than aborting a healthy response and paying for a
    // second slow request to reach the same timeout.
    expect(CALL_RELIABILITY.execution_decision.timeoutMs).toBeGreaterThan(71_600);
    expect(CALL_RELIABILITY.execution_decision.maxAttempts).toBe(2);
  });

  it("gives classification one retry to ride through free-tier variance", () => {
    // The retry only fires on failure, so a healthy classification is still
    // exactly one request.
    expect(CALL_RELIABILITY.classification.maxAttempts).toBe(2);
    expect(CALL_RELIABILITY.classification.timeoutMs).toBeGreaterThanOrEqual(15_000);
  });

  it("gives user-facing synthesis calls one retry for the same reason", () => {
    for (const callType of ["direct_answer", "synthesis", "plan_only"] as const) {
      expect(CALL_RELIABILITY[callType].maxAttempts).toBe(2);
      expect(CALL_RELIABILITY[callType].timeoutMs).toBeGreaterThanOrEqual(20_000);
    }
  });

  it("sizes every planning budget above the measured fast-tier time", () => {
    // Planning is a fast-tier call (planner/generator.ts sets `fast: true`).
    for (const callType of ["plan", "plan_tools"] as const) {
      expect(CALL_RELIABILITY[callType].timeoutMs).toBeGreaterThan(11_900);
    }
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
