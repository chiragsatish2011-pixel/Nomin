import { describe, expect, it } from "vitest";
import type { NormalInput, PlanDoc } from "../types";
import { isInterfaceBuildRequest, stageExhaustiveInterfacePlan } from "../exhaustive-build-test";

const input: NormalInput = {
  session_id: "test", workspace_path: "workspace", mode: "execute", model: "trion-1.4",
  user_message: "Build a marketing landing page for a studio", conversation_history: [], attached_context: [],
  workspace_snapshot: { file_tree: ["projects/web/src/App.tsx"], open_files: [] },
};

describe("exhaustive interface build test", () => {
  it("recognizes interface tasks but does not broaden ordinary coding tasks", () => {
    expect(isInterfaceBuildRequest(input.user_message)).toBe(true);
    expect(isInterfaceBuildRequest("fix the parser in lib/token.ts")).toBe(false);
  });

  it("makes inspect, implementation, polish, and verification explicit and ordered", () => {
    const loose: PlanDoc = {
      plan_summary: "Create the landing page",
      steps: [{ step_id: 1, description: "Create the landing page in projects/web/src/App.tsx", tool: "write_file" }],
    };
    const staged = stageExhaustiveInterfacePlan(loose, input);
    expect(staged.steps.map((step) => step.step_id)).toEqual([1, 2, 3, 4]);
    expect(staged.steps[0].tool).toBe("read_file");
    expect(staged.steps[1].tool).toBe("write_file");
    expect(staged.steps[2].description).toMatch(/polish/i);
    expect(staged.steps[3].tool).toBe("run_command");
  });

  it("leaves non-interface tasks untouched", () => {
    const plan: PlanDoc = { plan_summary: "Fix parser", steps: [{ step_id: 1, description: "Fix lib/token.ts", tool: "write_file" }] };
    expect(stageExhaustiveInterfacePlan(plan, { ...input, user_message: "fix the parser" })).toEqual(plan);
  });
});
