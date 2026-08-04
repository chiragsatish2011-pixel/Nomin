import { describe, expect, it } from "vitest";
import { normalizeInterfaceWrites } from "../planner/generator";
import type { NormalInput, PlanDoc } from "../types";

const input: NormalInput = {
  session_id: "coalesce-plan",
  workspace_path: "workspace",
  mode: "execute",
  model: "trion-1.4",
  user_message: "Build a polished landing page",
  conversation_history: [],
  attached_context: [],
  workspace_snapshot: {
    file_tree: ["projects/web/index.html", "projects/web/src/App.tsx", "projects/web/src/styles.css"],
    open_files: [],
  },
};

describe("whole-file plan normalization", () => {
  it("routes React page markup away from index.html and coalesces repeated writes", () => {
    const plan: PlanDoc = {
      plan_summary: "Build sections",
      steps: [
        { step_id: 1, tool: "write_file", description: "Add hero markup to index.html" },
        { step_id: 2, tool: "write_file", description: "Add feature section to index.html" },
        { step_id: 3, tool: "write_file", description: "Add testimonials and CTA to index.html" },
        { step_id: 4, tool: "write_file", description: "Update projects/web/src/styles.css" },
        { step_id: 5, tool: "run_command", description: "Start the dev server" },
      ],
    };

    const normalized = normalizeInterfaceWrites(plan, input);
    expect(normalized.steps).toHaveLength(3);
    expect(normalized.steps[0]).toMatchObject({ step_id: 1, tool: "write_file" });
    expect(normalized.steps[0].description).toContain("projects/web/src/App.tsx");
    expect(normalized.steps[0].description).toContain("testimonials");
    expect(normalized.steps[1]).toMatchObject({ step_id: 2, tool: "write_file", description: "Update projects/web/src/styles.css" });
    expect(normalized.steps[2]).toMatchObject({ step_id: 3, tool: "run_command" });
  });

  it("keeps genuine index.html metadata separate", () => {
    const plan: PlanDoc = {
      plan_summary: "Update metadata",
      steps: [{ step_id: 1, tool: "write_file", description: "Update the title and meta description in projects/web/index.html" }],
    };
    expect(normalizeInterfaceWrites(plan, input).steps[0].description).toContain("index.html");
  });
});
