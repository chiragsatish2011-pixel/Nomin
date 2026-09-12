// Task 4: plan generation through tool_choice — same 5 payload shapes as the
// parsePlanDoc matrix (now as tool-call envelopes), plus the screenshot
// scenario ("test" follow-up) driven end to end through the real orchestrator.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractPlanPayload, generatePlanDoc, parsePlanDoc } from "../planner/generator";
import type { NormalInput } from "../types";

const gatewayMocks = vi.hoisted(() => ({
  completeText: vi.fn(),
  complete: vi.fn(),
  classifyIntent: vi.fn(),
  isDefinitelyTask: vi.fn(),
}));

vi.mock("../model-gateway", () => ({
  modelGateway: { completeText: gatewayMocks.completeText, complete: gatewayMocks.complete },
}));

vi.mock("../intent/classifier", () => ({
  classifyIntent: gatewayMocks.classifyIntent,
  isDefinitelyTask: gatewayMocks.isDefinitelyTask,
}));

import { runTurn } from "../orchestrator/state-machine";
import { providerFallbackOrder, shouldRouteToGemini } from "@/lib/nim/internal-client";

const gateway = gatewayMocks.completeText;

function testInput(userMessage = "make a test website"): NormalInput {
  return {
    session_id: "plan-tools-test",
    workspace_path: "workspace",
    mode: "execute",
    model: "trion-1.4",
    user_message: userMessage,
    conversation_history: [],
    attached_context: [],
    workspace_snapshot: { file_tree: [], open_files: [] },
  };
}

const GOOD_ARGS = JSON.stringify({
  plan_summary: "Test site",
  steps: [
    { step_id: 1, description: "Write page entry in projects/web/src/App.tsx", tool: "write_file" },
    { step_id: 2, description: "Run build check", tool: "run_command" },
  ],
});
const envelope = (args: string) => JSON.stringify([{ name: "emit_plan", arguments: args }]);
const PROSE = "Sure! Here is my plan: I will build a website with a hero and features. Let me know!";

describe("extractPlanPayload tool-call equivalents of the 5 shapes", () => {
  it("valid tool_calls envelope unwraps to the arguments payload", () => {
    expect(parsePlanDoc(extractPlanPayload(envelope(GOOD_ARGS))).steps.length).toBe(2);
  });

  it("truncated envelope degrades to legacy salvage (same as before)", () => {
    const cut = envelope(GOOD_ARGS).slice(0, -40);
    expect(parsePlanDoc(extractPlanPayload(cut)).steps.length).toBeGreaterThan(0);
  });

  it("pure prose passes through and still throws (same as before)", () => {
    expect(() => parsePlanDoc(extractPlanPayload(PROSE))).toThrow(/without any usable steps/);
  });

  it("empty-description args still throw empty_descriptions (same as before)", () => {
    const args = JSON.stringify({ plan_summary: "x", steps: [{ step_id: 1, description: "", tool: "write_file" }] });
    expect(() => parsePlanDoc(extractPlanPayload(envelope(args)))).toThrow(/without any usable steps/);
  });

  it("bogus tool in args still coerces and parses (same as before)", () => {
    const args = JSON.stringify({ plan_summary: "x", steps: [{ step_id: 1, description: "Do something", tool: "bogus_tool" }] });
    expect(parsePlanDoc(extractPlanPayload(envelope(args))).steps.length).toBe(1);
  });

  it("wrong-function envelope falls back to the raw text", () => {
    expect(extractPlanPayload(JSON.stringify([{ name: "other_fn", arguments: "{}" }])))
      .toContain("other_fn");
  });
});

describe("generatePlanDoc sends tool_choice on the hosted lane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses callType plan_tools with the emit_plan function forced", async () => {
    gateway.mockResolvedValueOnce(envelope(GOOD_ARGS));
    const plan = await generatePlanDoc(testInput());
    expect(plan.steps.length).toBe(2);
    const opts = gateway.mock.calls[0][1];
    expect(opts.callType).toBe("plan_tools");
    expect(opts.tools[0].function.name).toBe("emit_plan");
    expect(opts.toolChoice).toEqual({ type: "function", function: { name: "emit_plan" } });
  });

  it("keeps the repair retry when tool arguments are garbage", async () => {
    gateway.mockResolvedValueOnce(envelope("not json at all {{{")).mockResolvedValueOnce(envelope(GOOD_ARGS));
    const plan = await generatePlanDoc(testInput());
    expect(plan.steps.length).toBe(2);
    expect(gateway).toHaveBeenCalledTimes(2);
  });
});

describe("plan_tools routing stays on the hosted function-calling lane", () => {
  const both = { GEMINI_API_KEY_1: "g1", TRION_API_KEY: "h1" } as Record<string, string | undefined>;
  it("never routes to Gemini even when Gemini keys exist", () => {
    expect(shouldRouteToGemini({ label: "plan_tools" }, both)).toBe(false);
    // Control: the legacy plan label still prefers Gemini when configured.
    expect(shouldRouteToGemini({ label: "plan" }, both)).toBe(true);
  });

  it("has no fallback hop away from hosted", () => {
    expect(providerFallbackOrder("plan_tools", both)).toEqual(["hosted"]);
  });
});

describe("screenshot repro: vague 'test' follow-up completes planning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gatewayMocks.isDefinitelyTask.mockReturnValue(true);
    gatewayMocks.classifyIntent.mockResolvedValue({ intent: "task", activity: "coding", reason: "clear task" });
  });

  it("plans successfully through tool_choice where prompted JSON produced prose", async () => {
    gateway
      .mockResolvedValueOnce(envelope(GOOD_ARGS))
      .mockResolvedValue(JSON.stringify({ message: "Plan ready.", next_action_hint: null }));
    const events: unknown[] = [];
    const output = await runTurn(
      {
        sessionId: `screenshot-test-${Date.now()}`,
        userText: "test",
        mode: "plan",
        model: "trion-1.4",
        workspacePath: "workspace",
        snapshot: [],
      },
      (event) => events.push(event),
      Date.now(),
    );
    expect(output.message).not.toMatch(/could not prepare the build plan/i);
    expect(output.status).toBe("done");
    expect(output.plan).not.toBeNull();
    expect(output.message).toBe("Plan ready.");
    expect(events).toContainEqual(expect.objectContaining({ type: "plan" }));
    expect(gateway.mock.calls[0][1].callType).toBe("plan_tools");
  });
});
