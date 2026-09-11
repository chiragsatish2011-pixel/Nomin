import { describe, expect, it, vi } from "vitest";
import {
  awaitClientExecution,
  resolveClientExecution,
  rejectClientExecution,
  touchClientExecution,
  abortSessionExecutions,
  awaitPlanApproval,
  resolvePlanApproval,
  closePlanApproval,
  validateToolResultShape,
} from "../bridge";

describe("execution bridge — WebContainer tool results", () => {
  it("blocks until the client posts a result, then resolves it", async () => {
    const pending = awaitClientExecution("session-a", "exec-1", 5_000);

    const result = { step_id: 1, ok: true, status: "success" as const, output: "hello" };
    const resolved = resolveClientExecution("session-a", "exec-1", result);

    expect(resolved).toBe(true);
    await expect(pending).resolves.toEqual(result);
  });

  it("resolving twice is a no-op on the second call", async () => {
    const pending = awaitClientExecution("session-b", "exec-1", 5_000);

    resolveClientExecution("session-b", "exec-1", { step_id: 1, ok: true, status: "success", output: "one" });
    expect(resolveClientExecution("session-b", "exec-1", { step_id: 1, ok: true, status: "success", output: "two" })).toBe(false);

    await expect(pending).resolves.toMatchObject({ output: "one" });
  });

  it("rejects pending executions when the session is aborted", async () => {
    const pending = awaitClientExecution("session-c", "exec-1", 5_000);
    rejectClientExecution("session-c", "exec-1", new Error("aborted"));

    await expect(pending).rejects.toThrow("aborted");
  });

  it("fails fast with an actionable browser message when no tab answers", async () => {
    const pending = awaitClientExecution("session-timeout", "exec-1", 20);
    await expect(pending).rejects.toThrow(/WebContainer bridge unavailable/);
    await expect(pending).rejects.toThrow(/Keep the Trion workspace tab open/);
  });

  it("keeps an active browser operation alive until its real result arrives", async () => {
    const pending = awaitClientExecution("session-heartbeat", "exec-1", 100);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(touchClientExecution("session-heartbeat", "exec-1")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolveClientExecution("session-heartbeat", "exec-1", { step_id: 1, ok: true, status: "success", output: "finished" })).toBe(true);
    await expect(pending).resolves.toMatchObject({ output: "finished" });
  });

  it("abortSessionExecutions rejects every pending execution of a session", async () => {
    const one = awaitClientExecution("session-d", "exec-1", 5_000);
    const two = awaitClientExecution("session-d", "exec-2", 5_000);
    const other = awaitClientExecution("session-e", "exec-1", 5_000);

    abortSessionExecutions("session-d");

    await expect(one).rejects.toThrow("Client disconnected");
    await expect(two).rejects.toThrow("Client disconnected");
    // Other sessions are untouched — they still resolve normally.
    resolveClientExecution("session-e", "exec-1", { step_id: 1, ok: true, status: "success", output: "untouched" });
    await expect(other).resolves.toMatchObject({ output: "untouched" });
  });
});

describe("plan approval gate (Step 1.5)", () => {
  it("is a HARD block: the promise stays pending until a decision is posted", async () => {
    const resolver = vi.fn();
    const gate = awaitPlanApproval("session-gate-1", 5_000).then(resolver);

    // Give any accidental early resolution a chance to surface — the gate
    // must NOT resolve before a decision arrives.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolver).not.toHaveBeenCalled();

    expect(resolvePlanApproval("session-gate-1", "approve")).toBe(true);
    await gate;
    expect(resolver).toHaveBeenCalledWith("approve");
  });

  it("cancel releases the gate and lets the turn end cleanly", async () => {
    const gate = awaitPlanApproval("session-gate-2", 5_000);
    expect(resolvePlanApproval("session-gate-2", "cancel")).toBe(true);
    await expect(gate).resolves.toBe("cancel");
  });

  it("resolving a gate that does not exist is a no-op", () => {
    expect(resolvePlanApproval("session-gate-3", "approve")).toBe(false);
    expect(closePlanApproval("session-gate-3")).toBe(false);
  });

  it("a stale gate (no answer) times out into cancel instead of hanging forever", async () => {
    const gate = awaitPlanApproval("session-gate-4", 40);
    await expect(gate).resolves.toBe("cancel");
  });

  it("closePlanApproval releases a pending gate as cancel (disconnect path)", async () => {
    const gate = awaitPlanApproval("session-gate-5", 5_000);
    expect(closePlanApproval("session-gate-5")).toBe(true);
    await expect(gate).resolves.toBe("cancel");
  });
});

describe("cross-route module identity", () => {  it("resolves a browser result from a separately evaluated route bundle", async () => {
    const original = await import("../bridge");
    const pending = original.awaitClientExecution("session-cross-route", "exec-1", 5_000);

    // This reproduces Next's dev-route behaviour: chat and tool-result can
    // receive independently evaluated copies of this module. The shared
    // registry must still make the execution id visible to both.
    vi.resetModules();
    const resolver = await import("../bridge");
    expect(resolver.resolveClientExecution("session-cross-route", "exec-1", {
      step_id: 1,
      ok: true,
      status: "success",
      output: "returned by the browser",
    })).toBe(true);

    await expect(pending).resolves.toMatchObject({ output: "returned by the browser" });
  });
});

describe("tool result shape and step binding", () => {
  it("fails fast on a malformed payload instead of poisoning the trace", async () => {
    const pending = awaitClientExecution("session-shape", "exec-1", 5_000, { stepId: 2, action: "read_file" });
    const consumed = resolveClientExecution("session-shape", "exec-1", { step_id: 2, ok: true } as never);
    expect(consumed).toBe(true);
    await expect(pending).rejects.toThrow(/malformed tool result/);
  });

  it("rejects ok/status disagreement", () => {
    expect(validateToolResultShape({ step_id: 1, ok: true, status: "error", output: "" }).ok).toBe(false);
    expect(validateToolResultShape({ step_id: 1, ok: false, status: "success", output: "" }).ok).toBe(false);
    expect(validateToolResultShape({ step_id: 1, ok: true, status: "success", output: "x" }).ok).toBe(true);
  });

  it("rejects malformed artifacts", () => {
    expect(
      validateToolResultShape({ step_id: 1, ok: true, status: "success", output: "x", artifacts: [{ type: "exe", content: "y" }] }).ok
    ).toBe(false);
  });

  it("discards a result for the wrong step and fails that step fast", async () => {
    const pending = awaitClientExecution("session-step", "exec-1", 5_000, { stepId: 3, action: "write_file" });
    const consumed = resolveClientExecution("session-step", "exec-1", { step_id: 4, ok: true, status: "success", output: "stale" });
    expect(consumed).toBe(true);
    await expect(pending).rejects.toThrow(/for step 4, but step 3 was waiting/);
  });

  it("accepts a result whose step matches the binding", async () => {
    const pending = awaitClientExecution("session-step-ok", "exec-1", 5_000, { stepId: 3, action: "write_file" });
    expect(resolveClientExecution("session-step-ok", "exec-1", { step_id: 3, ok: true, status: "success", output: "good" })).toBe(true);
    await expect(pending).resolves.toMatchObject({ output: "good" });
  });

  it("still accepts results for unbound executions (backwards compatible)", async () => {
    const pending = awaitClientExecution("session-unbound", "exec-1", 5_000);
    expect(resolveClientExecution("session-unbound", "exec-1", { step_id: 9, ok: true, status: "success", output: "ok" })).toBe(true);
    await expect(pending).resolves.toMatchObject({ output: "ok" });
  });
});

describe("plan approval binding", () => {
  const planA = { plan_summary: "build a", steps: [{ step_id: 1, description: "write a", tool: "write_file" as const }] };
  const planB = { plan_summary: "build b", steps: [{ step_id: 1, description: "write b", tool: "write_file" as const }] };

  it("hashes a plan deterministically", async () => {
    const { hashPlan } = await import("../bridge");
    expect(hashPlan(planA)).toBe(hashPlan(planA));
    expect(hashPlan(planA)).not.toBe(hashPlan(planB));
    expect(hashPlan(planA)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("rejects a decision for a superseded plan without consuming the gate", async () => {
    const gate = awaitPlanApproval("session-appr", { planHash: "aaaa1111", timeoutMs: 5_000 });
    expect(resolvePlanApproval("session-appr", "approve", "bbbb2222")).toBe(false);
    // The legitimate answer still releases the gate.
    expect(resolvePlanApproval("session-appr", "approve", "aaaa1111")).toBe(true);
    await expect(gate).resolves.toBe("approve");
  });

  it("accepts a decision without a hash (backwards compatible client)", async () => {
    const gate = awaitPlanApproval("session-appr-compat", { planHash: "aaaa1111", timeoutMs: 5_000 });
    expect(resolvePlanApproval("session-appr-compat", "approve")).toBe(true);
    await expect(gate).resolves.toBe("approve");
  });

  it("a duplicate decision after resolution is a no-op", async () => {
    const gate = awaitPlanApproval("session-appr-dup", { planHash: "aaaa1111", timeoutMs: 5_000 });
    expect(resolvePlanApproval("session-appr-dup", "approve", "aaaa1111")).toBe(true);
    expect(resolvePlanApproval("session-appr-dup", "approve", "aaaa1111")).toBe(false);
    await expect(gate).resolves.toBe("approve");
  });
});
