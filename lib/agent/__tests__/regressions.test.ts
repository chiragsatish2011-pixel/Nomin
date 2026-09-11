// Regressions for defects that were silent in code review but immediately
// visible to a user of the product. Each block names the observed symptom.

// @ts-nocheck
import { describe, it, expect } from "vitest";
import { sanitize } from "../sanitize";
import { trimHistoryForTier } from "../input";
import { parsePlanDoc } from "../planner/generator";
import { buildFinalOutput } from "../output/builder";
import { EXECUTE_SYSTEM_PROMPT, PLAN_SYSTEM_PROMPT, SYNTHESIS_SYSTEM_PROMPT, DIRECT_ANSWER_SYSTEM_PROMPT } from "../static-prompts";

describe("sanitize preserves code", () => {
  // Symptom: every file the agent wrote came out with its indentation flattened,
  // because sanitize() collapsed all whitespace runs and ran over write_file
  // content via the gateway's action_input sanitizer.
  it("does not touch indentation on lines with nothing to replace", () => {
    const code = [
      "export function add(a: number, b: number) {",
      "  if (a > b) {",
      "    return a + b;",
      "  }",
      "\treturn 0;",
      "}",
      "",
    ].join("\n");
    expect(sanitize(code)).toBe(code);
  });

  it("keeps blank lines and the trailing newline of a file", () => {
    const file = "const a = 1;\n\nconst b = 2;\n";
    expect(sanitize(file)).toBe(file);
  });

  it("keeps leading indentation on a line it DOES rewrite", () => {
    const input = "    const model = 'Nemotron';";
    expect(sanitize(input)).toBe("    const model = 'Trion';");
  });

  it("still replaces every vendor token", () => {
    expect(sanitize("Running on NVIDIA NIM")).toBe("Running on Trion");
    expect(sanitize("Model: nvidia/nemotron-3-ultra-550b-a55b")).toBe("Model: Trion");
  });

  it("preserves a fenced code block inside a message", () => {
    const message = "Created the file:\n\n```ts\nfunction go() {\n  return 1;\n}\n```\n";
    expect(sanitize(message)).toBe(message);
  });
});

describe("history stays in chronological order", () => {
  // Symptom: replies that answered a question the user had asked several turns
  // earlier. The trimmer built its result with mixed push/unshift passes, so
  // older error rows landed after newer turns.
  it("returns turns in their original order", () => {
    const history = [
      { role: "user", content: "one" },
      { role: "tool", content: "Error: boom", tool_name: "run_command" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
      { role: "tool", content: "ok", tool_name: "read_file" },
      { role: "assistant", content: "four" },
    ];
    const trimmed = trimHistoryForTier(history, "trion-2.3");
    expect(trimmed.map((t) => t.content)).toEqual(["one", "Error: boom", "two", "three", "ok", "four"]);
  });

  it("keeps order even when the budget forces a drop", () => {
    const history = [
      { role: "tool", content: `Error: ${"x".repeat(200)}`, tool_name: "run_command" },
      ...Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `turn ${i} ${"y".repeat(200)}` })),
    ];
    const trimmed = trimHistoryForTier(history, "trion-1.4");
    const indices = trimmed.map((t) => history.indexOf(t));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
});

describe("plan parsing repairs instead of failing the turn", () => {
  // Symptom: "Invalid plan structure" ended an otherwise fine request at step 2.
  it("renumbers duplicated and skipped step ids", () => {
    const plan = parsePlanDoc(
      JSON.stringify({
        plan_summary: "do the thing",
        steps: [
          { step_id: 1, description: "a", tool: "write_file" },
          { step_id: 1, description: "b", tool: "run_command" },
          { step_id: 7, description: "c", tool: null },
        ],
      })
    );
    expect(plan.steps.map((s) => s.step_id)).toEqual([1, 2, 3]);
  });

  it("drops an unknown tool rather than passing it to the executor", () => {
    const plan = parsePlanDoc(JSON.stringify({ plan_summary: "x", steps: [{ step_id: 1, description: "a", tool: "sudo_rm" }] }));
    expect(plan.steps[0].tool).toBeNull();
  });

  it("coerces a finish plan tool to a non-tool step instead of a terminator", () => {
    const plan = parsePlanDoc(JSON.stringify({ plan_summary: "x", steps: [{ step_id: 1, description: "a", tool: "finish" }] }));
    expect(plan.steps[0].tool).toBeNull();
  });

  it("recovers a plan wrapped in prose and a markdown fence", () => {
    const raw = 'Sure! Here is the plan:\n```json\n{"plan_summary":"s","steps":[{"step_id":1,"description":"d","tool":"read_file"}]}\n```';
    expect(parsePlanDoc(raw).steps).toHaveLength(1);
  });

  it("falls back to the first step when the summary is missing", () => {
    const plan = parsePlanDoc(JSON.stringify({ steps: [{ step_id: 1, description: "scaffold the app", tool: "write_file" }] }));
    expect(plan.plan_summary).toBe("scaffold the app");
  });

  it("caps a normal plan at five focused steps", () => {
    const steps = Array.from({ length: 25 }, (_, i) => ({ step_id: i + 1, description: `s${i}`, tool: null }));
    expect(parsePlanDoc(JSON.stringify({ plan_summary: "x", steps })).steps).toHaveLength(5);
  });

  it("still fails loudly when there is nothing usable at all", () => {
    expect(() => parsePlanDoc("I cannot help with that.")).toThrow();
  });
});

describe("the reported plan matches what actually ran", () => {
  // Symptom: a failed step, and every step the model skipped by finishing early,
  // were rendered with a green check because toPlan() hardcoded "done".
  const planDoc = {
    plan_summary: "build it",
    steps: [
      { step_id: 1, description: "write file", tool: "write_file" },
      { step_id: 2, description: "run tests", tool: "run_command" },
      { step_id: 3, description: "deploy", tool: "run_command" },
    ],
  };

  it("reports each step's real outcome", () => {
    const states = new Map([
      [1, "done"],
      [2, "error"],
      [3, "cancelled"],
    ]);
    const output = buildFinalOutput({ message: "m" }, planDoc, [], [], "error", states);
    expect(output.plan.steps.map((s) => s.state)).toEqual(["done", "error", "cancelled"]);
  });

  it("does not claim success for a step that never reported back", () => {
    const output = buildFinalOutput({ message: "m" }, planDoc, [], [], "done", new Map([[1, "done"], [2, "running"]]));
    expect(output.plan.steps[1].state).toBe("cancelled");
  });

  it("falls back sensibly when execution never started", () => {
    const output = buildFinalOutput({ message: "m" }, planDoc, [], [], "cancelled", null);
    expect(output.plan.steps.every((s) => s.state === "cancelled")).toBe(true);
  });
});

describe("prompts describe the sandbox that actually exists", () => {
  // Symptom: the plan prompt advertised absolute paths while the execute prompt
  // forbade them, and both referenced a project the seed no longer contains.
  it("forbids absolute paths in the planning prompt too", () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/NEVER absolute paths/);
    expect(PLAN_SYSTEM_PROMPT).not.toMatch(/relative\/or\/absolute/);
  });

  it("names the project the seed actually ships", () => {
    expect(EXECUTE_SYSTEM_PROMPT).toMatch(/projects\/web/);
    expect(EXECUTE_SYSTEM_PROMPT).not.toMatch(/trion-app/);
    expect(PLAN_SYSTEM_PROMPT).not.toMatch(/trion-app/);
  });

  it("requires Markdown output instead of forbidding it", () => {
    for (const prompt of [SYNTHESIS_SYSTEM_PROMPT, DIRECT_ANSWER_SYSTEM_PROMPT]) {
      expect(prompt).toMatch(/MARKDOWN/);
      expect(prompt).not.toMatch(/No markdown/i);
    }
  });

  it("still bans self-narration in both output prompts", () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).toMatch(/Never narrate yourself/);
    expect(DIRECT_ANSWER_SYSTEM_PROMPT).toMatch(/Never narrate yourself/);
  });

  it("tells the model a dev server is supposed to keep running", () => {
    expect(EXECUTE_SYSTEM_PROMPT).toMatch(/will NOT exit/);
    expect(EXECUTE_SYSTEM_PROMPT).toMatch(/0\.0\.0\.0/);
  });
});
