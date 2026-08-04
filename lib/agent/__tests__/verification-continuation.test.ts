import { describe, expect, it } from "vitest";
import { prepareVerificationContinuation } from "../orchestrator/state-machine";
import { emptyTaskState, applyPlan } from "../task-state";

describe("verification continuation", () => {
  it("keeps completed work and reopens only a missing final check for retry", () => {
    const plan = {
      plan_summary: "Build a counter",
      steps: [
        { step_id: 1, description: "Write the component", tool: "write_file" },
        { step_id: 2, description: "Wire it into the app", tool: "write_file" },
      ],
    };
    const state = applyPlan(emptyTaskState("Build a counter"), plan);
    state.steps[0].state = "done";
    state.steps[1].state = "done";

    const continued = prepareVerificationContinuation(plan, state);

    expect(continued.steps).toHaveLength(3);
    expect(continued.steps[2]).toMatchObject({ description: "Verify the finished project", tool: "run_command" });
    expect(state.steps.map((step) => step.state)).toEqual(["done", "done", "pending"]);
  });

  it("does not duplicate the verification step on repeated retries", () => {
    const plan = { plan_summary: "Build", steps: [{ step_id: 1, description: "Write", tool: "write_file" }] };
    const state = applyPlan(emptyTaskState("Build"), plan);
    state.steps[0].state = "done";
    const once = prepareVerificationContinuation(plan, state);
    state.steps.find((step) => step.description === "Verify the finished project")!.state = "done";
    const twice = prepareVerificationContinuation(once, state);

    expect(twice.steps.filter((step) => step.description === "Verify the finished project")).toHaveLength(1);
    expect(state.steps.at(-1)?.state).toBe("pending");
  });
});
