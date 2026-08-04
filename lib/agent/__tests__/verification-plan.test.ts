import { describe, expect, it } from "vitest";
import { ensureVerificationStep } from "../planner/generator";

describe("verification plan completion", () => {
  it("adds an approved final check after runnable source writes", () => {
    const plan = ensureVerificationStep({
      plan_summary: "Build a counter",
      steps: [
        { step_id: 1, description: "Write src/Counter.tsx", tool: "write_file" },
      ],
    });
    expect(plan.steps.at(-1)).toMatchObject({
      tool: "run_command",
      description: expect.stringMatching(/build or development check/i),
    });
  });

  it("does not duplicate a planned post-change check", () => {
    const plan = ensureVerificationStep({
      plan_summary: "Build a counter",
      steps: [
        { step_id: 1, description: "Write src/Counter.tsx", tool: "write_file" },
        { step_id: 2, description: "Run npm build to verify the page", tool: "run_command" },
      ],
    });
    expect(plan.steps).toHaveLength(2);
  });
});
