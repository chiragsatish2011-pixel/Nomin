// Does the task state still carry the whole session at turn 10?
//
// The 11-turn long-horizon benchmark failed two of its four recall probes:
// "which files have you changed" omitted a file written six turns earlier, and
// "did anything fail earlier" answered "No failures occurred" when a command
// had failed twice on turn 3. Both are questions the state object is supposed
// to be able to answer without the model reconstructing anything.
//
// This replays that exact session shape against the state module alone — no
// model, no network — so the two failures can be attributed. One of them is the
// module's fault and one of them is not, and the difference decides the fix.

import { describe, expect, it } from "vitest";
import {
  applyPlan,
  applyTrace,
  emptyTaskState,
  renderTaskState,
  type TaskState,
} from "../task-state";
import type { PlanDoc, ToolTraceEntry } from "../types";

function plan(steps: Array<{ id: number; description: string; tool: string }>): PlanDoc {
  return {
    summary: "plan",
    steps: steps.map((s) => ({
      step_id: s.id,
      description: s.description,
      tool: s.tool,
      requires_approval: false,
    })),
  } as unknown as PlanDoc;
}

function trace(
  rows: Array<{ step: number; tool: string; status: "success" | "error"; input?: Record<string, unknown>; output?: string; attempt?: number }>
): ToolTraceEntry[] {
  return rows.map((r) => ({
    step_id: r.step,
    tool_name: r.tool,
    attempt: r.attempt ?? 1,
    status: r.status,
    input: r.input ?? {},
    output: r.output ?? "",
  })) as unknown as ToolTraceEntry[];
}

/** The benchmark session, compressed to the turns that matter for recall. */
function runSession(): TaskState {
  const state = emptyTaskState(
    "build a small task tracker app at projects/tracker with an index.html, a src/main.tsx entry, and a src/App.tsx that lists tasks"
  );
  state.turnCount = 1;

  // Turn 1 — the build.
  applyPlan(state, plan([{ id: 1, description: "write App.tsx", tool: "write_file" }]));
  applyTrace(state, trace([{ step: 1, tool: "write_file", status: "success", input: { path: "projects/tracker/src/App.tsx" } }]));

  // Turn 3 — the forced failure: nanoid install fails on both retries.
  state.turnCount = 3;
  applyPlan(state, plan([{ id: 1, description: "install nanoid", tool: "run_command" }]));
  applyTrace(
    state,
    trace([
      { step: 1, tool: "run_command", status: "error", attempt: 2, input: { command: "npm install nanoid" }, output: "E404 Not Found" },
      { step: 1, tool: "run_command", status: "error", attempt: 3, input: { command: "npm install nanoid" }, output: "E404 Not Found" },
    ])
  );

  // Turn 4 — TaskItem.tsx, the file the probe later failed to recall.
  state.turnCount = 4;
  applyPlan(state, plan([{ id: 1, description: "add TaskItem.tsx", tool: "write_file" }]));
  applyTrace(state, trace([{ step: 1, tool: "write_file", status: "success", input: { path: "projects/tracker/src/TaskItem.tsx" } }]));

  // Turn 9 — Filter.tsx, the most recent work before the probes.
  state.turnCount = 9;
  applyPlan(state, plan([{ id: 1, description: "add Filter.tsx", tool: "write_file" }]));
  applyTrace(state, trace([{ step: 1, tool: "write_file", status: "success", input: { path: "projects/tracker/src/Filter.tsx" } }]));

  return state;
}

describe("long-horizon state retention", () => {
  it("still carries every file written, including one from six turns back", () => {
    const rendered = renderTaskState(runSession());

    // This is the probe that failed. If these all pass, the state HAD the
    // answer and the failure is the model ignoring it, not the state losing it.
    expect(rendered).toContain("projects/tracker/src/App.tsx");
    expect(rendered).toContain("projects/tracker/src/TaskItem.tsx");
    expect(rendered).toContain("projects/tracker/src/Filter.tsx");
  });

  it("still carries the original goal at turn 9", () => {
    expect(renderTaskState(runSession())).toContain("ORIGINAL GOAL: build a small task tracker app");
  });

  it("still reports the turn-3 command failure once later turns have replanned", () => {
    const rendered = renderTaskState(runSession());

    // The probe answered "No failures occurred earlier in this session."
    //
    // Match on the SUBSTANCE, not the word "failed" — renderTaskState always
    // emits a "Step ledger: N done, M failed" header, so /failed/ passes even
    // when the count is zero and nothing is remembered. That false pass is the
    // whole reason this assertion is written against the command text.
    expect(rendered).toMatch(/nanoid/i);
  });
});
