import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  classifyIntent: vi.fn(),
  isDefinitelyTask: vi.fn(),
  generatePlanDoc: vi.fn(),
  emitPlan: vi.fn(),
}));

vi.mock("../intent/classifier", () => ({
  classifyIntent: mocks.classifyIntent,
  isDefinitelyTask: mocks.isDefinitelyTask,
}));

vi.mock("../planner/generator", () => ({
  generatePlanDoc: mocks.generatePlanDoc,
  emitPlan: mocks.emitPlan,
}));

import { runTurn } from "../orchestrator/state-machine";

const request = {
  sessionId: "cancel-between-stages",
  userText: "build a dashboard",
  mode: "execute" as const,
  model: "trion-1.4" as const,
  workspacePath: "workspace",
  snapshot: [],
};

describe("turn cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDefinitelyTask.mockReturnValue(false);
  });

  it("returns a cancelled result without any model call when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: unknown[] = [];

    const output = await runTurn(request, (event) => events.push(event), Date.now(), controller.signal);

    expect(output.status).toBe("cancelled");
    expect(output.plan).toBeNull();
    expect(mocks.classifyIntent).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "status", status: "cancelled" });
  });

  it("does not generate a plan after cancellation while classification was in flight", async () => {
    let resolveIntent!: (value: { intent: "task"; activity: "coding"; reason: string }) => void;
    mocks.classifyIntent.mockImplementation(
      () => new Promise((resolve) => { resolveIntent = resolve; })
    );
    const controller = new AbortController();
    const events: unknown[] = [];
    const pending = runTurn(request, (event) => events.push(event), Date.now(), controller.signal);

    await vi.waitFor(() => expect(mocks.classifyIntent).toHaveBeenCalledTimes(1));
    controller.abort();
    resolveIntent({ intent: "task", activity: "coding", reason: "clear task" });

    const output = await pending;
    expect(output.status).toBe("cancelled");
    expect(mocks.generatePlanDoc).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "status", status: "cancelled" });
  });

  it("restarts as a fresh turn with a notice when a resume checkpoint is missing", async () => {
    // Client-held checkpoints (resume-checkpoint.ts) cover restarts; when
    // nothing is recoverable the turn continues fresh instead of dead-ending.
    mocks.classifyIntent.mockResolvedValue({
      intent: "needs_clarification",
      activity: "clarifying",
      reason: "What should the site help visitors do?",
    });
    const events: unknown[] = [];
    const output = await runTurn(
      { ...request, sessionId: `missing-resume-${Date.now()}`, resume: true },
      (event) => events.push(event),
      Date.now(),
    );

    expect(output.status).toBe("needs_clarification");
    expect(mocks.classifyIntent).toHaveBeenCalledTimes(1);
    expect(mocks.generatePlanDoc).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "progress",
      stage: "notice",
      message: "Continuing from your last message — prior progress couldn't be restored.",
    });
  });
});
