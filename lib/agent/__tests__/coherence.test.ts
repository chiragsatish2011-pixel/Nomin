// Does the decision agree with the trace?
//
// The headline case, and the reason this module exists: on the baseline run of
// the 11-case coding suite, four of the five failures were a finish/done:true
// emitted while approved plan steps had never been attempted. In one, the turn
// read a file, finished, and the summary described a component that no
// write_file had ever created. A premature finish is a perfectly well-formed
// tool call, so schema validation cannot see it — only the trace can.
//
// The false-positive tests matter as much as the true positives: a spurious
// correction costs a round trip, which is the cost this is meant to remove.

// @ts-nocheck
import { describe, it, expect } from "vitest";
import { checkCoherence, knownFilesFromTrace } from "../executor/coherence";

const NO_FILES = { read: new Set(), written: new Set(), snapshot: [] };

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

function turn(overrides) {
  return { thought: "", action: "read_file", action_input: {}, done: false, ...overrides };
}

describe("finishing with approved work still pending", () => {
  const pending = [
    { id: 3, description: "update projects/web/src/App.tsx to render Counter", tool: "write_file" },
    { id: 4, description: "start the dev server", tool: "run_command" },
  ];

  it("blocks a finish when planned steps have no trace entry at all", () => {
    const problem = checkCoherence(
      turn({ action: "finish", done: true, thought: "The component is created." }),
      trace({ step: 1, tool: "read_file" }, { step: 2, tool: "write_file" }),
      { pending, ...NO_FILES }
    );
    expect(problem?.kind).toBe("finishes_with_work_pending");
    // The correction has to name the steps — "you are not finished" alone gave
    // the model nothing to act on.
    expect(problem.correction).toContain("step 3");
    expect(problem.correction).toContain("render Counter");
    expect(problem.correction).toContain("step 4");
  });

  it("allows a finish when nothing is pending", () => {
    const problem = checkCoherence(
      turn({ action: "finish", done: true }),
      trace({ step: 1, tool: "write_file" }),
      { pending: [], ...NO_FILES }
    );
    expect(problem).toBeNull();
  });

  it("allows a finish when the pending steps were at least attempted", () => {
    // The step ran and errored; that is a judgement call the model is entitled
    // to make, and it is caught by the failure check below instead.
    const problem = checkCoherence(
      turn({ action: "finish", done: true }),
      trace({ step: 3, tool: "write_file", status: "error", output: "boom" }, { step: 1, tool: "write_file" }),
      { pending: [{ id: 3, description: "x", tool: "write_file" }], ...NO_FILES }
    );
    expect(problem?.kind).not.toBe("finishes_with_work_pending");
  });

  it("does not fire on a non-finish action", () => {
    expect(
      checkCoherence(turn({ action: "write_file", action_input: { path: "a.ts", content: "x" } }), trace(), {
        pending,
        ...NO_FILES,
      })
    ).toBeNull();
  });

  it("does not fire on finish with done:false", () => {
    expect(checkCoherence(turn({ action: "finish", done: false }), trace(), { pending, ...NO_FILES })).toBeNull();
  });
});

describe("finishing on top of a failure", () => {
  it("blocks it and quotes the failure", () => {
    const problem = checkCoherence(
      turn({ action: "finish", done: true }),
      trace({ step: 1, tool: "run_command", status: "error", output: "Command exited with code 127." }),
      { pending: [], ...NO_FILES }
    );
    expect(problem?.kind).toBe("finishes_over_failure");
    expect(problem.correction).toContain("code 127");
  });

  it("allows a finish when the failure was recovered from", () => {
    const problem = checkCoherence(
      turn({ action: "finish", done: true }),
      trace(
        { step: 1, tool: "run_command", status: "error", output: "boom", attempt: 1 },
        { step: 1, tool: "run_command", status: "success", output: "ok", attempt: 2 }
      ),
      { pending: [], ...NO_FILES }
    );
    expect(problem).toBeNull();
  });
});

describe("reasoning from an assumed result", () => {
  it("catches a past-tense success claim with nothing successful in the trace", () => {
    const problem = checkCoherence(
      turn({ thought: "Since we already created the component, I only need to wire it up." }),
      trace(),
      { pending: [], ...NO_FILES }
    );
    expect(problem?.kind).toBe("claims_unrun_success");
  });

  it("names the failures when there are some", () => {
    const problem = checkCoherence(
      turn({ thought: "The package has been installed, so I can import it." }),
      trace({ step: 1, tool: "run_command", status: "error", output: "not found" }),
      { pending: [], ...NO_FILES }
    );
    expect(problem?.kind).toBe("claims_unrun_success");
    expect(problem.correction).toContain("run_command");
  });

  it("stays quiet once something HAS succeeded", () => {
    expect(
      checkCoherence(turn({ thought: "We already created the file, now wire it up." }), trace({ step: 1, tool: "write_file" }), {
        pending: [],
        ...NO_FILES,
      })
    ).toBeNull();
  });
});

describe("citing a file it never read", () => {
  it("catches a contents claim about an unread path", () => {
    const problem = checkCoherence(
      turn({ thought: "projects/web/src/App.tsx already imports the helper, so no change is needed." }),
      trace({ step: 1, tool: "search_codebase" }),
      { pending: [], read: new Set(), written: new Set(), snapshot: ["projects/web/src/App.tsx"] }
    );
    expect(problem?.kind).toBe("cites_unread_file");
    expect(problem.correction).toContain("read_file");
  });

  it("says so plainly when the path is not even in the workspace", () => {
    const problem = checkCoherence(
      turn({ thought: "src/hooks/useTasks.ts contains the fetch logic." }),
      trace({ step: 1, tool: "search_codebase" }),
      { pending: [], read: new Set(), written: new Set(), snapshot: ["package.json"] }
    );
    expect(problem?.kind).toBe("cites_unread_file");
    expect(problem.correction).toContain("not in the workspace snapshot");
  });

  it("allows a claim about a file this turn read", () => {
    expect(
      checkCoherence(
        turn({ thought: "projects/web/src/App.tsx already imports React." }),
        trace({ step: 1, tool: "read_file", input: { path: "projects/web/src/App.tsx" } }),
        { pending: [], read: new Set(["projects/web/src/App.tsx"]), written: new Set(), snapshot: [] }
      )
    ).toBeNull();
  });

  it("allows a claim about a file this turn wrote", () => {
    expect(
      checkCoherence(
        turn({ thought: "Counter.tsx already exports the component." }),
        trace({ step: 1, tool: "write_file", input: { path: "projects/web/src/Counter.tsx" } }),
        { pending: [], read: new Set(), written: new Set(["projects/web/src/Counter.tsx"]), snapshot: [] }
      )
    ).toBeNull();
  });

  it("does not fire on reasoning that merely mentions a path", () => {
    // No contents claim — just naming the target of the write.
    expect(
      checkCoherence(turn({ thought: "Writing projects/web/src/Counter.tsx now." }), trace({ step: 1, tool: "read_file" }), {
        pending: [],
        read: new Set(),
        written: new Set(),
        snapshot: [],
      })
    ).toBeNull();
  });
});

describe("knownFilesFromTrace", () => {
  it("collects only successful reads and writes", () => {
    const known = knownFilesFromTrace(
      trace(
        { step: 1, tool: "read_file", input: { path: "./a.ts" } },
        { step: 2, tool: "write_file", input: { path: "b.ts" } },
        { step: 3, tool: "write_file", input: { path: "c.ts" }, status: "error" }
      )
    );
    expect([...known.read]).toEqual(["a.ts"]);
    expect([...known.written]).toEqual(["b.ts"]);
  });
});
