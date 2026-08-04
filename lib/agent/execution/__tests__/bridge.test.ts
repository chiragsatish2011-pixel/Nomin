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

describe("cross-route module identity", () => {
  it("resolves a browser result from a separately evaluated route bundle", async () => {
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
