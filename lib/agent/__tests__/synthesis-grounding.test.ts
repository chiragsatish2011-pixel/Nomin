// The summary may only claim work the trace shows.
//
// Observed on a benchmark turn whose ENTIRE trace was one read_file: the summary
// read "Created `projects/web/src/Counter.tsx` … Updated `projects/web/src/App.tsx`
// … Started dev server." Confident, specific, and false — the worst output this
// system can produce, because the user has no way to tell. The system prompt
// already forbade it. Instructions do not fix this; comparing the claim to the
// trace does.

// @ts-nocheck
import { describe, it, expect, vi } from "vitest";
const { completeText } = vi.hoisted(() => ({ completeText: vi.fn() }));
vi.mock("../model-gateway", () => ({ modelGateway: { completeText } }));
import { pausedTaskSynthesis, synthesizeResult, ungroundedFileClaims } from "../synthesis/generator";

function trace(...rows) {
  return rows.map((row, i) => ({
    step_id: row.step ?? i + 1,
    tool_name: row.tool,
    input: row.input ?? {},
    output: row.output ?? "",
    status: row.status ?? "success",
    attempt: 1,
  }));
}

const READ_ONLY = trace({ step: 1, tool: "read_file", input: { path: "projects/web/src/App.tsx" } });

describe("catches invented file claims", () => {
  it("flags the real observed failure", () => {
    const message =
      "# Counter Component Created\n- Created `projects/web/src/Counter.tsx` with a button.\n" +
      "- Updated `projects/web/src/App.tsx` to import and render the Counter component.";
    expect(ungroundedFileClaims(message, READ_ONLY).sort()).toEqual([
      "projects/web/src/App.tsx",
      "projects/web/src/Counter.tsx",
    ]);
  });

  it("flags a claim when the write FAILED", () => {
    const failed = trace({ step: 1, tool: "write_file", input: { path: "a.ts" }, status: "error" });
    expect(ungroundedFileClaims("Created `a.ts`.", failed)).toEqual(["a.ts"]);
  });

  it("sees through markdown emphasis", () => {
    expect(ungroundedFileClaims("Added **src/Widget.tsx** to the app.", READ_ONLY)).toEqual(["src/Widget.tsx"]);
  });
});

describe("does not cry wolf", () => {
  const WROTE = trace(
    { step: 1, tool: "write_file", input: { path: "projects/web/src/Counter.tsx" } },
    { step: 2, tool: "write_file", input: { path: "projects/web/src/App.tsx" } }
  );

  it("accepts a claim backed by a successful write", () => {
    expect(ungroundedFileClaims("Created `projects/web/src/Counter.tsx` and updated `projects/web/src/App.tsx`.", WROTE)).toEqual([]);
  });

  it("accepts a bare filename that matches a written path", () => {
    // "updated App.tsx" about projects/web/src/App.tsx is true, not invented.
    expect(ungroundedFileClaims("Updated App.tsx to render Counter.tsx.", WROTE)).toEqual([]);
  });

  it("accepts a ./ prefixed claim", () => {
    expect(ungroundedFileClaims("Created ./projects/web/src/Counter.tsx.", WROTE)).toEqual([]);
  });

  it("ignores a file merely MENTIONED without a write claim", () => {
    expect(ungroundedFileClaims("`package.json` defines the workspaces, so nothing was changed.", READ_ONLY)).toEqual([]);
  });

  it("ignores an honest report that nothing was written", () => {
    const message = "No `README.md` was created. The plan's remaining steps did not run.";
    expect(ungroundedFileClaims(message, READ_ONLY)).toEqual([]);
  });

  it("ignores a verb and a path in separate sentences", () => {
    // "Created the component." then a new sentence naming a file is not a claim
    // about that file — the clause boundary is load-bearing.
    expect(ungroundedFileClaims("Created the component. See `docs/guide.md` for background.", READ_ONLY)).toEqual([]);
  });
});

describe("execution-decision failure recovery", () => {
  it("returns a professional recovery message without spending a second model request", async () => {
    completeText.mockReset();
    const plan = {
      plan_summary: "Create a counter",
      steps: [{ step_id: 1, description: "Write src/Counter.tsx", tool: "write_file" as const }],
    };
    const input = {
      session_id: "failure-summary", workspace_path: "workspace", mode: "execute" as const, model: "trion-1.4" as const,
      user_message: "Create a counter", conversation_history: [], attached_context: [],
      workspace_snapshot: { file_tree: [], open_files: [] },
    };
    const result = await synthesizeResult(
      input,
      trace({ step: 1, tool: "model_decision", status: "error", output: "Trion request timed out." }),
      plan,
      new Error("Step 1 could not be completed: Trion request timed out.")
    );

    expect(result.message).toContain("could not start the next saved build step");
    expect(result.message).not.toContain("src/Counter.tsx");
    expect(result.message).not.toContain("step 1");
    expect(result.next_action_hint).toContain("instead of starting over");
    expect(completeText).not.toHaveBeenCalled();
  });

  it("never exposes planned file names, step numbers, or raw tool receipts for any paused task", () => {
    const output = pausedTaskSynthesis(
      trace(
        { step: 1, tool: "write_file", input: { path: "projects/web/src/App.tsx" }, status: "success" },
        { step: 2, tool: "run_command", input: { command: "npm run dev" }, status: "error", output: "sandbox timeout" },
      ),
      new Error("Step 2 could not be completed: sandbox timeout")
    );

    expect(output.message).toContain("paused after confirmed work was completed");
    expect(output.message).toMatch(/next unfinished step/i);
    expect(output.message).not.toMatch(/App\.tsx|npm run dev|step 2|sandbox timeout|nothing was changed/i);
  });
});
