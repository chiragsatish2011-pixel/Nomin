// An unreadable execution decision must never be reported as a finished step.
//
// The provider client wraps text it cannot parse into a schema-valid
// `finish` + `done: true` turn so the value can be carried out of the transport
// layer. Before `parse_error` existed, the executor could not tell that apart
// from a model that had genuinely chosen to finish — so on the last step of a
// plan, a garbled response was presented to the user as a completed build.
import { describe, expect, it, vi } from "vitest";

const { complete, completeText } = vi.hoisted(() => ({ complete: vi.fn(), completeText: vi.fn() }));
vi.mock("../model-gateway", () => ({ modelGateway: { complete, completeText } }));

import { executeSteps } from "../executor/step-runner";
import { emptyTaskState } from "../task-state";
import type { AgentTurn, NormalInput, PlanDoc, StreamEvent } from "../types";

const input: NormalInput = {
  session_id: "parse-error", workspace_path: "workspace", mode: "execute", model: "trion-1.4",
  user_message: "Read the config", conversation_history: [], attached_context: [],
  workspace_snapshot: { file_tree: ["package.json"], open_files: [] },
};

/** A step with no tool hint: the decision is entirely the model's, and a
 *  rejected one never reaches the browser execution bridge. */
const plan: PlanDoc = {
  plan_summary: "Inspect the workspace",
  steps: [{ step_id: 1, tool: null, description: "Decide how to inspect the build script" }],
};

/** Exactly what the client produces for a reply it could not parse. */
const wrapped: AgentTurn = {
  thought: "The model returned non-schema text, so Trion wrapped it into a completed response.",
  action: "finish",
  action_input: { raw_model_output: "Sure! Let me help you with that." },
  summary: "Sure! Let me help you with that.",
  done: true,
  parse_error: "The response was not a valid tool-call object.",
};

describe("an unparseable decision", () => {
  it("is retried as a decision error instead of ending the step as done", async () => {
    complete.mockReset();
    completeText.mockReset();
    complete.mockResolvedValue(wrapped);
    const events: StreamEvent[] = [];

    const outcome = await executeSteps(plan, input, (event) => events.push(event), "parse-error", emptyTaskState(input.user_message));

    // Re-asked rather than accepted on the first reply.
    expect(complete.mock.calls.length).toBeGreaterThan(1);
    // And the turn ends as a grounded failure, not as a finished plan.
    expect(outcome.failure?.stepId).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_result", step_id: 1, status: "error" }),
    );
    // The model's stray prose is never presented as the answer.
    expect(JSON.stringify(outcome.toolTrace)).not.toContain("Let me help you with that");
  });

});

describe("native tool-call replies", () => {
  it("are understood as decisions, not as unparseable text", async () => {
    const { parseAgentTurnForTest } = await import("@/lib/nim/internal-client");
    const turn = parseAgentTurnForTest(
      JSON.stringify([{ name: "write_file", arguments: '{"thought":"writing it","path":"src/App.tsx","content":"export default () => null;"}' }]),
    );
    expect(turn).toEqual({
      thought: "writing it",
      action: "write_file",
      action_input: { path: "src/App.tsx", content: "export default () => null;" },
      summary: undefined,
      done: false,
    });
  });

  it("marks a tool call naming an unknown tool as unparseable", async () => {
    const { parseAgentTurnForTest } = await import("@/lib/nim/internal-client");
    expect(parseAgentTurnForTest(JSON.stringify([{ name: "rm_rf", arguments: "{}" }])).parse_error).toBeDefined();
  });

  it("treats a finish tool call as a completed turn", async () => {
    const { parseAgentTurnForTest } = await import("@/lib/nim/internal-client");
    const turn = parseAgentTurnForTest(JSON.stringify([{ name: "finish", arguments: '{"thought":"done","summary":"Built it."}' }]));
    expect(turn.action).toBe("finish");
    expect(turn.done).toBe(true);
    expect(turn.parse_error).toBeUndefined();
  });
});

describe("executor tool schemas", () => {
  it("are not sent unless the deployment opts in", async () => {
    const { executorToolOptions } = await import("../executor/tool-schemas");
    const prior = process.env.TRION_EXECUTOR_TOOL_CALLS;
    delete process.env.TRION_EXECUTOR_TOOL_CALLS;
    expect(executorToolOptions("write_file", { isRetry: false })).toEqual({});
    process.env.TRION_EXECUTOR_TOOL_CALLS = "1";
    const enabled = executorToolOptions("write_file", { isRetry: false });
    expect(enabled.toolChoice).toBe("required");
    expect(enabled.tools?.map((t) => t.function.name)).toContain("write_file");
    if (prior === undefined) delete process.env.TRION_EXECUTOR_TOOL_CALLS;
    else process.env.TRION_EXECUTOR_TOOL_CALLS = prior;
  });

  it("offers every tool for a retry, because the planned one was already wrong", async () => {
    const { executorToolsFor } = await import("../executor/tool-schemas");
    expect(executorToolsFor("read_file", { isRetry: true }).map((t) => t.function.name)).toEqual(
      ["read_file", "search_codebase", "write_file", "run_command", "finish"],
    );
  });
});
