import { describe, expect, it, vi } from "vitest";
import type { NormalInput, PlanDoc, ToolTraceEntry } from "../types";
import { evaluateVerification } from "../verification";

const mocks = vi.hoisted(() => ({ completeText: vi.fn() }));
vi.mock("../model-gateway", () => ({ modelGateway: { completeText: mocks.completeText } }));
import { synthesizeResult } from "../synthesis/generator";

function entry(tool_name: string, status: "success" | "error", input: Record<string, unknown>): ToolTraceEntry {
  return { step_id: 1, tool_name, status, input, output: "result", attempt: 1 };
}

describe("evaluateVerification", () => {
  it("requires proof after a runnable source write", () => {
    expect(evaluateVerification([entry("write_file", "success", { path: "src/Counter.tsx" })])).toMatchObject({
      required: true,
      status: "not_run",
    });
  });

  it("does not require a build for prose-only work", () => {
    expect(evaluateVerification([entry("write_file", "success", { path: "README.md" })])).toMatchObject({
      required: false,
      status: "not_needed",
    });
  });

  it("accepts a successful relevant check after the final source write", () => {
    expect(evaluateVerification([
      entry("write_file", "success", { path: "src/Counter.tsx" }),
      entry("run_command", "success", { command: "npm run build" }),
    ])).toMatchObject({ required: true, status: "passed", command: "npm run build" });
  });

  it("does not let an earlier build verify a later edit", () => {
    expect(evaluateVerification([
      entry("write_file", "success", { path: "src/Counter.tsx" }),
      entry("run_command", "success", { command: "npm run build" }),
      entry("write_file", "success", { path: "src/App.tsx" }),
    ])).toMatchObject({ required: true, status: "not_run" });
  });

  it("records a failed verification command as failed evidence", () => {
    expect(evaluateVerification([
      entry("write_file", "success", { path: "src/Counter.tsx" }),
      entry("run_command", "error", { command: "npm test" }),
    ])).toMatchObject({ required: true, status: "failed", command: "npm test" });
  });
});

describe("verification completion gate", () => {
  it("uses a factual response without a synthesis request when runnable code is unchecked", async () => {
    mocks.completeText.mockReset();
    const trace = [entry("write_file", "success", { path: "src/Counter.tsx" })];
    const plan: PlanDoc = { plan_summary: "Add a counter", steps: [{ step_id: 1, description: "Write Counter", tool: "write_file" }] };
    const input: NormalInput = {
      session_id: "test", workspace_path: "workspace", mode: "execute", model: "trion-1.4",
      user_message: "Create a counter", conversation_history: [], attached_context: [],
      workspace_snapshot: { file_tree: [], open_files: [] },
    };

    const result = await synthesizeResult(input, trace, plan, undefined, undefined, evaluateVerification(trace));

    expect(mocks.completeText).not.toHaveBeenCalled();
    expect(result.message).toContain("still needs to run the final project check");
    expect(result.message).not.toContain("src/Counter.tsx");
  });
});
