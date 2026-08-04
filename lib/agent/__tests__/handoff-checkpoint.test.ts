import { describe, expect, it } from "vitest";
import { applyPlan, applyTrace, emptyTaskState, renderHandoffCheckpoint } from "../task-state";

describe("model handoff checkpoint", () => {
  it("passes only durable, trace-grounded work to the next model call", () => {
    const state = emptyTaskState("Build a settings page");
    applyPlan(state, {
      plan_summary: "Build settings",
      steps: [
        { step_id: 1, description: "Update app/page.tsx", tool: "write_file" },
        { step_id: 2, description: "Run the build", tool: "run_command" },
      ],
    });
    applyTrace(state, [
      {
        step_id: 1,
        tool_name: "write_file",
        input: { path: "app/page.tsx", content: "private source must not appear" },
        output: "written",
        status: "success",
        attempt: 1,
      },
    ]);

    const checkpoint = renderHandoffCheckpoint(state);
    expect(checkpoint).toContain("MODEL HANDOFF CHECKPOINT");
    expect(checkpoint).toContain("Goal: Build a settings page");
    expect(checkpoint).toContain("Files written: app/page.tsx");
    expect(checkpoint).toContain("[DONE] 1. Update app/page.tsx");
    expect(checkpoint).toContain("[TODO] 2. Run the build");
    expect(checkpoint).not.toContain("private source must not appear");
  });

  it("remains bounded even after a long task", () => {
    const state = emptyTaskState("x".repeat(900));
    state.decisions = Array.from({ length: 12 }, (_, index) => `Decision ${index}: ${"d".repeat(140)}`);
    state.filesTouched = Array.from({ length: 30 }, (_, index) => ({ path: `src/file-${index}.ts`, action: "written" as const, stepId: index }));
    state.steps = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, description: "s".repeat(400), tool: "write_file", state: "pending" as const, attempts: 0 }));
    expect(renderHandoffCheckpoint(state).length).toBeLessThanOrEqual(4_000);
  });
});
