// Structured working memory.
//
// The property under test throughout: the state is a PROJECTION of things that
// actually happened. It can only ever record a file as written if a write_file
// entry succeeded, and the original goal survives however long the session runs
// — which is the thing a sliding transcript window cannot promise.

// @ts-nocheck
import { describe, it, expect } from "vitest";
import {
  applyPlan,
  applyTrace,
  emptyTaskState,
  pendingSteps,
  recordDecision,
  recordRefinement,
  renderTaskState,
  resolveOpenQuestions,
  recordOpenQuestion,
} from "../task-state";

const PLAN = {
  plan_summary: "build the tracker",
  steps: [
    { step_id: 1, description: "create projects/tracker/src/App.tsx", tool: "write_file" },
    { step_id: 2, description: "create projects/tracker/src/TaskItem.tsx", tool: "write_file" },
    { step_id: 3, description: "render TaskItem in App.tsx", tool: "write_file" },
  ],
};

function trace(...rows) {
  return rows.map((row, i) => ({
    step_id: row.step ?? i + 1,
    tool_name: row.tool,
    input: row.input ?? {},
    output: row.output ?? "",
    status: row.status ?? "success",
    attempt: row.attempt ?? 1,
  }));
}

describe("projection from the plan and the trace", () => {
  it("marks only steps with a successful trace entry as done", () => {
    const state = applyPlan(emptyTaskState("build a task tracker"), PLAN);
    applyTrace(state, trace({ step: 1, tool: "write_file", input: { path: "projects/tracker/src/App.tsx" } }));

    expect(state.steps.map((s) => s.state)).toEqual(["done", "pending", "pending"]);
    expect(pendingSteps(state).map((s) => s.id)).toEqual([2, 3]);
    expect(state.completedStepCount).toBe(1);
  });

  it("records a failure with its error, not as done", () => {
    const state = applyPlan(emptyTaskState("g"), PLAN);
    applyTrace(state, trace({ step: 2, tool: "write_file", status: "error", output: "disk full", attempt: 3 }));
    expect(state.steps[1].state).toBe("error");
    expect(state.steps[1].attempts).toBe(3);
    expect(state.steps[1].lastError).toContain("disk full");
  });

  it("never records a file from a FAILED write", () => {
    const state = applyPlan(emptyTaskState("g"), PLAN);
    applyTrace(state, trace({ step: 1, tool: "write_file", input: { path: "a.ts" }, status: "error" }));
    expect(state.filesTouched).toHaveLength(0);
  });

  it("upgrades a read to a written when the file is later written", () => {
    const state = applyPlan(emptyTaskState("g"), PLAN);
    applyTrace(
      state,
      trace(
        { step: 1, tool: "read_file", input: { path: "projects/web/src/App.tsx" } },
        { step: 2, tool: "write_file", input: { path: "projects/web/src/App.tsx" } }
      )
    );
    expect(state.filesTouched).toEqual([{ path: "projects/web/src/App.tsx", action: "written", stepId: 1 }]);
  });

  it("normalises ./ paths so the same file is not tracked twice", () => {
    const state = applyPlan(emptyTaskState("g"), PLAN);
    applyTrace(
      state,
      trace(
        { step: 1, tool: "write_file", input: { path: "./a.ts" } },
        { step: 2, tool: "write_file", input: { path: "a.ts" } }
      )
    );
    expect(state.filesTouched).toHaveLength(1);
  });

  it("deduplicates repeated commands", () => {
    const state = applyPlan(emptyTaskState("g"), PLAN);
    applyTrace(
      state,
      trace(
        { step: 1, tool: "run_command", input: { command: "npm install nanoid" } },
        { step: 2, tool: "run_command", input: { command: "npm install nanoid" } }
      )
    );
    expect(state.commandsRun).toHaveLength(1);
  });

  it("is idempotent — applying the same trace twice changes nothing", () => {
    const state = applyPlan(emptyTaskState("g"), PLAN);
    const rows = trace({ step: 1, tool: "write_file", input: { path: "a.ts" } });
    applyTrace(state, rows);
    const first = JSON.stringify(state);
    applyTrace(state, rows);
    expect(JSON.stringify(state)).toBe(first);
  });
});

describe("the goal outlives the session", () => {
  it("keeps the original goal through many refinements", () => {
    const state = emptyTaskState("build a small task tracker at projects/tracker");
    for (let i = 0; i < 30; i++) recordRefinement(state, `tweak number ${i}`);
    expect(state.goal).toBe("build a small task tracker at projects/tracker");
    expect(renderTaskState(state)).toContain("build a small task tracker");
    // Refinements are capped so the block cannot grow without bound.
    expect(state.refinements.length).toBeLessThanOrEqual(8);
  });

  it("promotes the answer to a clarifying question into a durable decision", () => {
    const state = emptyTaskState("make me a duck game");
    recordOpenQuestion(state, "Which kind — clicker, hunting, or platformer?");
    resolveOpenQuestions(state, "a simple clicker");

    expect(state.openQuestions).toHaveLength(0);
    const rendered = renderTaskState(state);
    expect(rendered).toContain("a simple clicker");
    expect(rendered).toContain("Which kind");
  });

  it("caps decisions so the block cannot grow without bound", () => {
    const state = emptyTaskState("g");
    for (let i = 0; i < 40; i++) recordDecision(state, `decision ${i}`);
    expect(state.decisions.length).toBeLessThanOrEqual(12);
    // And the most recent survive.
    expect(state.decisions.at(-1)).toBe("decision 39");
  });

  it("deduplicates a decision repeated on every step", () => {
    const state = emptyTaskState("g");
    recordDecision(state, "use vitest");
    recordDecision(state, "use vitest");
    expect(state.decisions).toEqual(["use vitest"]);
  });
});

describe("rendering", () => {
  it("leads with the goal and spells out what is still to do", () => {
    const state = applyPlan(emptyTaskState("build a task tracker"), PLAN);
    applyTrace(state, trace({ step: 1, tool: "write_file", input: { path: "projects/tracker/src/App.tsx" } }));
    const rendered = renderTaskState(state);

    expect(rendered.startsWith("ORIGINAL GOAL: build a task tracker")).toBe(true);
    expect(rendered).toContain("[DONE] 1.");
    expect(rendered).toContain("[STILL TO DO] 2.");
    // Enumerated and counted rather than comma-joined — see renderTaskState.
    expect(rendered).toContain("Files already written (1 total");
    expect(rendered).toContain("- projects/tracker/src/App.tsx");
  });

  it("stays small even after a long run — this block is sent on every call", () => {
    const state = emptyTaskState("build a task tracker");
    state.turnCount = 12;
    for (let i = 0; i < 60; i++) recordDecision(state, `decision ${i} ${"x".repeat(80)}`);
    for (let i = 0; i < 60; i++) state.filesTouched.push({ path: `projects/tracker/src/File${i}.tsx`, action: "written", stepId: i });
    applyPlan(state, PLAN);

    const tokens = Math.ceil(renderTaskState(state).length / 4);
    expect(tokens).toBeLessThan(1_200);
  });
});
