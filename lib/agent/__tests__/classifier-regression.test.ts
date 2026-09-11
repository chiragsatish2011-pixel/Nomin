// Data-driven intent boundary regressions. The model is deliberately made
// wrong in these cases so the deterministic contract, not a lucky completion,
// is what protects the workflow. This suite makes zero provider calls.

// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from "vitest";
import { classifyIntent } from "../intent/classifier";

vi.mock("../model-gateway", () => ({
  modelGateway: { completeText: vi.fn() },
}));

import { modelGateway } from "../model-gateway";

function input(userMessage, history = []) {
  return {
    session_id: "classifier-regression",
    workspace_path: "workspace",
    mode: "execute",
    model: "trion-1.4",
    user_message: userMessage,
    conversation_history: history,
    attached_context: [],
    workspace_snapshot: { file_tree: [], open_files: [] },
  };
}

const cases = [
  ["hi there", "direct_answer"],
  ["yo", "direct_answer"],
  ["thanks, that helped", "direct_answer"],
  ["who are you?", "direct_answer"],
  ["what can you do?", "direct_answer"],
  ["should I use tabs or spaces?", "direct_answer"],
  ["explain what a promise is", "direct_answer"],
  ["what can we build together?", "needs_clarification"],
  ["help me", "needs_clarification"],
  ["help me build something", "needs_clarification"],
  ["wt?", "needs_clarification"],
  ["what should we do next?", "needs_clarification"],
  ["can you create something?", "needs_clarification"],
  ["could you build literally anything cool?", "needs_clarification"],
  ["build a landing page", "task"],
  ["can you make a dashboard?", "task"],
  ["please fix the login bug", "task"],
  ["change the heading in App.tsx", "task"],
  ["run the tests", "task"],
  ["search for the unused import", "task"],
  ["redesign the preview panel", "task"],
  ["deploy the app", "task"],
  ["make it dark and add a button", "task"],
  ["projects/web/src/App.tsx is broken; fix it", "task"],
];

describe("intent contract across natural, abbreviated, and imperative input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Force the model to return the least useful answer; overrides/fallback
    // rules must still preserve the user-facing contract.
    modelGateway.completeText.mockResolvedValue(
      JSON.stringify({ intent: "needs_clarification", activity: "clarifying", reason: "wrong" })
    );
  });

  for (const [message, expected] of cases) {
    it(`${expected}: ${message}`, async () => {
      const result = await classifyIntent(input(message));
      expect(result.intent).toBe(expected);
    });
  }
});

describe("classification keeps an unresolved clarification in-band", () => {
  beforeEach(() => vi.clearAllMocks());

  it("treats a short answer as task context, without sending old history", async () => {
    modelGateway.completeText.mockResolvedValue(
      JSON.stringify({ intent: "needs_clarification", activity: "clarifying", reason: "wrong" })
    );
    const history = [
      { role: "user", content: "build a game" },
      { role: "assistant", content: "Which kind of game?", clarifying: true, unresolved: true },
    ];
    const result = await classifyIntent(input("a clicker", history));
    expect(result.intent).toBe("task");
    const messages = modelGateway.completeText.mock.calls[0][0];
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain("Which kind of game?");
    expect(messages[1].content).toContain("a clicker");
  });
});

describe("vague work wording never starts a phantom plan", () => {
  it("demotes an overconfident task classification when the requested object is missing", async () => {
    modelGateway.completeText.mockResolvedValue(
      JSON.stringify({ intent: "task", activity: "coding", reason: "I will build it" })
    );

    const result = await classifyIntent(input("help me build something"));

    expect(result.intent).toBe("needs_clarification");
    expect(result.activity).toBe("clarifying");
  });
});
