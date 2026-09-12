import { describe, expect, it, beforeEach, vi } from "vitest";
import { generatePlanDoc, parsePlanDoc, PlanParseError } from "../planner/generator";
import { modelGateway } from "../model-gateway";
import { planningFailureSynthesis, synthesizeResult } from "../synthesis/generator";
import type { NormalInput } from "../types";

vi.mock("../model-gateway", () => {
  const mockCompleteText = vi.fn();
  return {
    modelGateway: { completeText: mockCompleteText },
  };
});

const gateway = modelGateway.completeText as unknown as ReturnType<typeof vi.fn>;

function testInput(): NormalInput {
  return {
    session_id: "plan-parse-test",
    workspace_path: "workspace",
    mode: "execute",
    model: "trion-1.4",
    user_message: "make a test website",
    conversation_history: [],
    attached_context: [],
    workspace_snapshot: { file_tree: [], open_files: [] },
  };
}

const PROSE = "Sure! Here is my plan: I will build a website with a hero and features. Let me know!";
const GOOD = JSON.stringify({
  plan_summary: "Test site",
  steps: [
    { step_id: 1, description: "Write the page entry in projects/web/src/App.tsx", tool: "write_file" },
    { step_id: 2, description: "Run the project build check", tool: "run_command" },
  ],
});

describe("parsePlanDoc failure stages", () => {
  it("labels prose-with-no-JSON as no_json_pairs", () => {
    try {
      parsePlanDoc(PROSE);
      expect.unreachable("prose must not parse");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanParseError);
      expect((error as PlanParseError).stage).toBe("no_json_pairs");
    }
  });

  it("labels valid JSON with all-empty descriptions as empty_descriptions", () => {
    const raw = JSON.stringify({
      plan_summary: "x",
      steps: [{ step_id: 1, description: "", tool: "write_file" }],
    });
    try {
      parsePlanDoc(raw);
      expect.unreachable("empty descriptions must not parse");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanParseError);
      expect((error as PlanParseError).stage).toBe("empty_descriptions");
    }
  });

  it("keeps the legacy message substring so the generic fallback still matches", () => {
    try {
      parsePlanDoc(PROSE);
      expect.unreachable("prose must not parse");
    } catch (error) {
      expect((error as Error).message).toMatch(/without any usable steps/i);
    }
  });

  it("still salvages a truncated array with one complete pair", () => {
    const plan = parsePlanDoc(
      '{"plan_summary":"Test site","steps":[{"description":"Write page entry","tool":"write_file"},',
    );
    expect(plan.steps.length).toBe(1);
  });
});

describe("generatePlanDoc repair retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("repairs a prose reply on the second attempt through the same gateway path", async () => {
    gateway.mockResolvedValueOnce(PROSE).mockResolvedValueOnce(GOOD);
    const plan = await generatePlanDoc(testInput());
    expect(plan.steps.length).toBe(2);
    expect(gateway).toHaveBeenCalledTimes(2);
    // Same gateway options both attempts: queue, limiter, breaker, budget.
    expect(gateway.mock.calls[0][1]).toEqual(gateway.mock.calls[1][1]);
    // Repair re-ask appends a JSON-only instruction to the original messages.
    expect(gateway.mock.calls[1][0].length).toBe(gateway.mock.calls[0][0].length + 1);
    expect(String(gateway.mock.calls[1][0].at(-1).content)).toMatch(/ONLY the JSON/);
  });

  it("is bounded: two unparseable replies reject after exactly 2 calls", async () => {
    gateway.mockResolvedValue(PROSE);
    await expect(generatePlanDoc(testInput())).rejects.toBeInstanceOf(PlanParseError);
    expect(gateway).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-parse errors", async () => {
    gateway.mockRejectedValueOnce(new Error("Trion request timed out."));
    await expect(generatePlanDoc(testInput())).rejects.toThrow(/timed out/);
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it("notifies the retry hook so progress reads as active, not stalled", async () => {
    gateway.mockResolvedValueOnce(PROSE).mockResolvedValueOnce(GOOD);
    const onParseRetry = vi.fn();
    await generatePlanDoc(testInput(), { onParseRetry });
    expect(onParseRetry).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the first attempt parses", async () => {
    gateway.mockResolvedValueOnce(GOOD);
    const onParseRetry = vi.fn();
    await generatePlanDoc(testInput(), { onParseRetry });
    expect(onParseRetry).not.toHaveBeenCalled();
  });
});

describe("synthesis routing for previously-generic transport errors", () => {
  it("routes hyphenated rate-limiting to the busy message", () => {
    expect(
      planningFailureSynthesis(new Error("Your provider is rate-limiting this connection.")).message,
    ).toMatch(/temporarily busy/);
  });

  it("routes bridge step timeouts to the timeout message", () => {
    expect(
      planningFailureSynthesis(new Error("Trion could not complete this step in time.")).message,
    ).toMatch(/did not respond in time/);
  });

  it("routes empty responses and output limits to the provider message", () => {
    expect(
      planningFailureSynthesis(new Error("Trion returned an empty response.")).message,
    ).toMatch(/provider failed the request/);
    expect(
      planningFailureSynthesis(new Error("Trion response reached its output limit.")).message,
    ).toMatch(/provider failed the request/);
  });
});

describe("synthesis retry visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("notifies when the fast synthesis degenerates and the fallback runs", async () => {
    gateway
      .mockResolvedValueOnce("....")
      .mockResolvedValueOnce(JSON.stringify({ message: "All done.", next_action_hint: null }));
    const onSynthesisRetry = vi.fn();
    const doc = await synthesizeResult(testInput(), [], parsePlanDoc(GOOD), undefined, "", null, {
      onSynthesisRetry,
    });
    expect(doc.message).toBe("All done.");
    expect(onSynthesisRetry).toHaveBeenCalledTimes(1);
  });
});
