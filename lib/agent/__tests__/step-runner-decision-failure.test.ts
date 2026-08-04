import { describe, expect, it, vi } from "vitest";

const { complete, completeText } = vi.hoisted(() => ({ complete: vi.fn(), completeText: vi.fn() }));
vi.mock("../model-gateway", () => ({ modelGateway: { complete, completeText } }));

import { executeSteps } from "../executor/step-runner";
import { emptyTaskState } from "../task-state";
import type { NormalInput, PlanDoc, StreamEvent } from "../types";

const input: NormalInput = {
  session_id: "decision-failure", workspace_path: "workspace", mode: "execute", model: "trion-1.4",
  user_message: "Build a landing page", conversation_history: [], attached_context: [],
  workspace_snapshot: { file_tree: ["src/App.tsx"], open_files: [] },
};

const plan: PlanDoc = {
  plan_summary: "Write the page",
  steps: [{ step_id: 1, tool: "write_file", description: "Write src/App.tsx" }],
};

const stylesheetPlan: PlanDoc = {
  plan_summary: "Style the page",
  steps: [{ step_id: 1, tool: "write_file", description: "Write src/App.css stylesheet" }],
};

describe("step runner decision failure", () => {
  it("retries a transient decision failure before returning a grounded failure", async () => {
    complete.mockReset();
    completeText.mockReset();
    completeText.mockRejectedValue(new Error("Trion request timed out."));
    const events: StreamEvent[] = [];

    const priorMode = process.env.TRION_EXHAUSTIVE_BUILD_TEST;
    process.env.TRION_EXHAUSTIVE_BUILD_TEST = "1";
    const outcome = await executeSteps(plan, input, (event) => events.push(event), "decision-failure", emptyTaskState(input.user_message));
    if (priorMode === undefined) delete process.env.TRION_EXHAUSTIVE_BUILD_TEST;
    else process.env.TRION_EXHAUSTIVE_BUILD_TEST = priorMode;

    expect(completeText).toHaveBeenCalledTimes(3);
    expect(completeText).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ maxTokens: 3_200, thinking: false, reliability: { timeoutMs: 180_000, maxAttempts: 1 } })
    );
    expect(completeText.mock.calls[0][0][0]).toEqual(expect.objectContaining({
      role: "system",
      content: expect.stringContaining("RAW FILE CONTENT ONLY"),
    }));
    expect(outcome.failure).toEqual({ stepId: 1, error: "Trion request timed out." });
    expect(outcome.toolTrace).toHaveLength(3);
    expect(outcome.toolTrace).toEqual(expect.arrayContaining([
      expect.objectContaining({ step_id: 1, tool_name: "model_decision", status: "error", output: "Trion request timed out.", attempt: 1 }),
      expect.objectContaining({ step_id: 1, tool_name: "model_decision", status: "error", output: "Trion request timed out.", attempt: 3 }),
    ]));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", step_id: 1, status: "error" }));
  });

  it("gives a complete stylesheet the same single bounded authoring window", async () => {
    complete.mockReset();
    completeText.mockReset();
    completeText.mockRejectedValue(new Error("Trion request timed out."));

    await executeSteps(stylesheetPlan, input, () => {}, "stylesheet-decision", emptyTaskState(input.user_message));

    expect(completeText).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ maxTokens: 1_400, thinking: false, allowTruncated: true, reliability: { timeoutMs: 180_000, maxAttempts: 1 } })
    );
  });

  it("does not spend repeated authoring calls on a deterministic output ceiling", async () => {
    completeText.mockReset();
    completeText.mockRejectedValue(new Error("Trion response reached its output limit before the file was complete."));

    const outcome = await executeSteps(plan, input, () => {}, "output-limit", emptyTaskState(input.user_message));

    expect(completeText).toHaveBeenCalledTimes(1);
    expect(outcome.failure?.error).toContain("output limit");
    expect(outcome.toolTrace).toHaveLength(1);
  });

  it("checkpoints immediately when the building allowance is exhausted", async () => {
    completeText.mockReset();
    completeText.mockRejectedValue(new Error("Your included building allowance is currently exhausted. Connect your own model to continue now, or wait for the allowance to reset."));

    const outcome = await executeSteps(plan, input, () => {}, "allowance-limit", emptyTaskState(input.user_message));

    expect(completeText).toHaveBeenCalledTimes(1);
    expect(outcome.failure).toEqual(expect.objectContaining({
      stepId: 1,
      error: expect.stringContaining("included building allowance"),
    }));
    expect(outcome.toolTrace).toHaveLength(1);
  });
});
