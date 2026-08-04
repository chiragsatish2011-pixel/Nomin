import { describe, expect, it } from "vitest";
import { getOrCreateSession, getPendingExecution, setPendingExecution } from "../session-store";
import type { PlanDoc } from "../types";

const plan: PlanDoc = {
  plan_summary: "Create the requested component.",
  steps: [{ step_id: 1, description: "Write the component", tool: "write_file" }],
};

describe("execution checkpoint", () => {
  it("keeps confirmed evidence with the plan for an exact retry", () => {
    const id = `checkpoint-${Date.now()}-${Math.random()}`;
    getOrCreateSession(id, "execute", "trion-1.4", "workspace");
    setPendingExecution(id, {
      plan,
      originalUserText: "Create a counter",
      toolTrace: [{
        step_id: 1,
        tool_name: "write_file",
        input: { path: "src/Counter.tsx" },
        output: "written",
        status: "success",
        attempt: 1,
      }],
      artifacts: [{ type: "file", language: "tsx", content: "export default function Counter() {}" }],
    });

    expect(getPendingExecution(id)).toMatchObject({
      originalUserText: "Create a counter",
      toolTrace: [{ tool_name: "write_file", status: "success" }],
      artifacts: [{ type: "file", language: "tsx" }],
    });
  });
});
