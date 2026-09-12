// Task 5: hard per-turn call ceiling — counter, choke point, and message.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTurnBudget,
  takeBudgetSlot,
  TURN_CALL_LIMIT,
  TurnBudgetExceeded,
} from "../turn-budget";
import { budgetExceededSynthesis } from "../synthesis/generator";

const gatewayMocks = vi.hoisted(() => ({
  queuedCompletion: vi.fn(),
  queuedTextCompletion: vi.fn(),
}));

vi.mock("@/lib/nim/internal-client", () => ({
  queuedCompletion: gatewayMocks.queuedCompletion,
  queuedTextCompletion: gatewayMocks.queuedTextCompletion,
}));

import { modelGateway } from "../model-gateway";

describe("takeBudgetSlot", () => {
  it("counts calls and tallies per call type", () => {
    const budget = createTurnBudget(20);
    takeBudgetSlot(budget, "classification");
    takeBudgetSlot(budget, "plan");
    takeBudgetSlot(budget, "plan");
    expect(budget.used).toBe(3);
    expect(budget.byCallType).toEqual({ classification: 1, plan: 2 });
  });

  it("allows exactly limit calls, then throws with the breakdown", () => {
    const budget = createTurnBudget(2);
    takeBudgetSlot(budget, "plan");
    takeBudgetSlot(budget, "plan");
    try {
      takeBudgetSlot(budget, "synthesis");
      expect.unreachable("must throw at the ceiling");
    } catch (error) {
      expect(error).toBeInstanceOf(TurnBudgetExceeded);
      expect((error as TurnBudgetExceeded).total).toBe(2);
      expect((error as TurnBudgetExceeded).byCallType).toEqual({ plan: 2 });
    }
    // The refused call is not counted.
    expect(budget.used).toBe(2);
  });

  it("is unenforced without a budget (bench/offline contexts)", () => {
    for (let i = 0; i < 100; i++) takeBudgetSlot(undefined, "plan");
  });

  it("defaults to a 20-call ceiling (~2x the 8-11 healthy average)", () => {
    expect(TURN_CALL_LIMIT).toBe(20);
    expect(createTurnBudget().limit).toBe(20);
  });
});

describe("gateway choke point", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gatewayMocks.queuedCompletion.mockResolvedValue({
      thought: "t",
      action: "read_file",
      action_input: { path: "a.ts" },
      done: false,
    });
    gatewayMocks.queuedTextCompletion.mockResolvedValue("hello");
  });

  it("refuses the over-limit call before anything is enqueued (zero RPM)", async () => {
    const budget = createTurnBudget(1);
    await modelGateway.completeText([{ role: "user", content: "hi" }], {
      tier: "trion-1.4",
      callType: "classification",
      budget,
    });
    await expect(
      modelGateway.completeText([{ role: "user", content: "hi" }], {
        tier: "trion-1.4",
        callType: "classification",
        budget,
      }),
    ).rejects.toBeInstanceOf(TurnBudgetExceeded);
    expect(gatewayMocks.queuedTextCompletion).toHaveBeenCalledTimes(1);
  });

  it("counts complete() and completeText() against the same allowance", async () => {
    const budget = createTurnBudget(2);
    await modelGateway.complete(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "go" },
      ],
      { tier: "trion-1.4", callType: "execution_decision", budget },
    );
    await modelGateway.completeText([{ role: "user", content: "hi" }], {
      tier: "trion-1.4",
      callType: "synthesis",
      budget,
    });
    expect(budget.used).toBe(2);
    expect(budget.byCallType).toEqual({ execution_decision: 1, synthesis: 1 });
  });
});

describe("budgetExceededSynthesis", () => {
  it("uses the approved calm copy with a checkpoint continuation", () => {
    const budget = createTurnBudget();
    budget.used = 20;
    budget.byCallType = { execution_decision: 14, synthesis: 6 };
    const doc = budgetExceededSynthesis();
    expect(doc.message).toMatch(/stopped to stay within its shared budget/);
    expect(doc.message).toMatch(/retry to continue from the saved checkpoint/);
    expect(doc.next_action_hint).toMatch(/saved checkpoint/);
  });
});
