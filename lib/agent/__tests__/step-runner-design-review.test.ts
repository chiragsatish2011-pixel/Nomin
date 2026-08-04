import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  completeText: vi.fn(),
  runTool: vi.fn(),
  shouldRunDesignReview: vi.fn(),
  runDesignCritic: vi.fn(),
  proposeDesignRevision: vi.fn(),
}));

vi.mock("../model-gateway", () => ({ modelGateway: { complete: mocks.complete, completeText: mocks.completeText } }));
vi.mock("../tool-runner", () => ({ runTool: mocks.runTool }));
vi.mock("../quality-chain", () => ({
  shouldRunDesignReview: mocks.shouldRunDesignReview,
  runDesignCritic: mocks.runDesignCritic,
  proposeDesignRevision: mocks.proposeDesignRevision,
}));

import { executeSteps } from "../executor/step-runner";
import { emptyTaskState } from "../task-state";

const input = {
  session_id: "design-review-run", workspace_path: "workspace", mode: "execute" as const, model: "trion-1.4" as const,
  user_message: "Build a marketing website", conversation_history: [], attached_context: [],
  workspace_snapshot: { file_tree: [], open_files: [] },
};
const plan = {
  plan_summary: "Build a site",
  steps: [
    { step_id: 1, description: "Write src/Hero.tsx", tool: "write_file" },
    { step_id: 2, description: "Write src/App.tsx", tool: "write_file" },
    { step_id: 3, description: "Run npm run build", tool: "run_command" },
  ],
};

describe("UI reviewer execution boundary", () => {
  it("starts a planned workspace read from the browser snapshot without waiting for a model decision", async () => {
    mocks.complete.mockReset();
    mocks.completeText.mockReset();
    mocks.runTool.mockReset();
    mocks.runTool.mockResolvedValue({ ok: true, output: JSON.stringify({ path: "projects/web/src/App.tsx", content: "export default function App() {}" }) });

    const outcome = await executeSteps(
      { plan_summary: "Inspect", steps: [{ step_id: 1, description: "Check the existing page layout", tool: "read_file" }] },
      { ...input, workspace_snapshot: { file_tree: ["projects/web/src/App.tsx"], open_files: [] } },
      () => {},
      "deterministic-inspection",
      emptyTaskState(input.user_message)
    );

    expect(outcome.failure).toBeUndefined();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.runTool).toHaveBeenCalledWith(
      expect.objectContaining({ action: "read_file", action_input: { path: "projects/web/src/App.tsx" } }),
      expect.any(Object)
    );
  });

  it("runs the known sandbox verification command without spending another model request", async () => {
    mocks.complete.mockReset();
    mocks.completeText.mockReset();
    mocks.runTool.mockReset();
    mocks.runTool.mockResolvedValue({ ok: true, output: "preview started" });

    const outcome = await executeSteps(
      { plan_summary: "Verify", steps: [{ step_id: 1, description: "Start the development server to verify the page", tool: "run_command" }] },
      input,
      () => {},
      "known-verification",
      emptyTaskState(input.user_message)
    );

    expect(outcome.failure).toBeUndefined();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.runTool).toHaveBeenCalledWith(
      expect.objectContaining({ action: "run_command", action_input: { command: "npm run dev", cwd: "projects/web" } }),
      expect.any(Object)
    );
  });

  it("rewrites only the final approved UI file and re-checks it once", async () => {
    mocks.complete.mockReset();
    mocks.completeText.mockReset();
    mocks.runTool.mockReset();
    mocks.shouldRunDesignReview.mockReturnValue(true);
    mocks.runDesignCritic.mockResolvedValueOnce({ verdict: "revise", violations: ["Generic purple gradient."], revision_brief: "Use the product palette." })
      .mockResolvedValueOnce({ verdict: "pass", violations: [], revision_brief: "" });
    mocks.proposeDesignRevision.mockResolvedValue({
      thought: "Replace the generic treatment.", action: "write_file", done: false,
      action_input: { path: "src/App.tsx", content: "export default function App(){ return <main className='nomin'>Field guide</main> }" },
    });
    mocks.completeText
      .mockResolvedValueOnce("export function Hero(){ return <section aria-label='Hero'>Field guide</section> }")
      .mockResolvedValueOnce("export default function App(){return <main className='purple-gradient'/>}");
    mocks.runTool.mockImplementation(async (turn: { action: string }) => ({ ok: true, output: `${turn.action} ok` }));

    const outcome = await executeSteps(plan, input, () => {}, "design-review-run", emptyTaskState(input.user_message));

    expect(outcome.failure).toBeUndefined();
    expect(mocks.proposeDesignRevision).toHaveBeenCalledTimes(1);
    expect(mocks.runDesignCritic).toHaveBeenCalledTimes(2);
    expect(mocks.runDesignCritic.mock.calls[0][0]).toMatchObject({
      sourcePath: "src/App.tsx",
      source: expect.stringContaining("=== src/Hero.tsx ==="),
    });
    expect(mocks.runDesignCritic.mock.calls[1][0]).toMatchObject({ recheck: true, previousViolations: ["Generic purple gradient."] });
    const writes = mocks.runTool.mock.calls.filter(([turn]) => turn.action === "write_file").map(([turn]) => turn.action_input.path);
    expect(writes).toEqual(["src/Hero.tsx", "src/App.tsx", "src/App.tsx"]);
    expect(outcome.toolTrace.filter((entry) => entry.tool_name === "write_file" && entry.status === "success")).toHaveLength(3);
  });
});
