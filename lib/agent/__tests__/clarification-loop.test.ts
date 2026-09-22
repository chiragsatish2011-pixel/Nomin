// Regression suite for the clarification loop.
//
// Observed failure this guards against:
//   user: "make me a simple duck game"      -> agent asks WHICH kind
//   user: "yes a simpl clicker"             -> agent asks "Could you clarify
//                                              what you'd like me to help
//                                              with?" AGAIN, forever.
//
// Root cause: classifyIntent received ONLY input.user_message. A reply to a
// question the agent had just asked was therefore classified from scratch, in
// isolation, where it is genuinely ambiguous. The fix pins the clarifying turn
// into classification context and suppresses the ambiguity heuristics while an
// answer is outstanding.

// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from "vitest";
import { classifyIntent } from "../intent/classifier";
import type { NormalInput, ConversationTurn } from "../types";

vi.mock("../model-gateway", () => ({
  modelGateway: { completeText: vi.fn() },
}));

import { modelGateway } from "../model-gateway";

const CLARIFYING_QUESTION =
  "What kind of duck game would you like — a clicker, a hunting game, a simulation, or a platformer?";

function input(userMessage: string, history: ConversationTurn[] = []): NormalInput {
  return {
    session_id: "s",
    workspace_path: "/w",
    mode: "execute",
    model: "trion-1.4",
    user_message: userMessage,
    conversation_history: history,
    attached_context: [],
    workspace_snapshot: { file_tree: [], open_files: [] },
  };
}

/** History ending in the clarifying question the user is now answering. */
function awaitingAnswer(): ConversationTurn[] {
  return [
    { role: "user", content: "make me a simple duck game" },
    { role: "assistant", content: CLARIFYING_QUESTION, clarifying: true },
  ];
}

function modelSays(intent: string, activity: string, reason = "r") {
  (modelGateway.completeText as any).mockResolvedValue(
    JSON.stringify({ intent, activity, reason })
  );
}

beforeEach(() => vi.clearAllMocks());

/** The message carrying THIS turn's input is always the last one sent. */
function finalUserMessage(): string {
  const sent = (modelGateway.completeText as any).mock.calls[0][0];
  return sent[sent.length - 1].content;
}

function sentMessages(): any[] {
  return (modelGateway.completeText as any).mock.calls[0][0];
}

describe("the classifier can see the question it is waiting on", () => {
  it("passes the pending clarifying question to the model", async () => {
    modelSays("task", "coding");
    await classifyIntent(input("yes a simpl clicker", awaitingAnswer()));

    const userMsg = finalUserMessage();
    expect(userMsg).toContain(CLARIFYING_QUESTION);
    expect(userMsg).toContain("yes a simpl clicker");
  });

  it("sends the raw message when no clarification is pending", async () => {
    modelSays("direct_answer", "greeting");
    await classifyIntent(
      input("explain closures in javascript", [
        { role: "user", content: "earlier thing" },
        { role: "assistant", content: "an ordinary answer" },
      ])
    );

    // No clarification framing wrapped around the input...
    expect(finalUserMessage()).toBe("explain closures in javascript");
    // Classification is intentionally current-message-only when no question
    // is pending; conversational memory belongs to the answer/synthesis call.
    const contents = sentMessages().map((m: any) => m.content);
    expect(contents).not.toContain("earlier thing");
  });

  it("keeps classification context small — it is the latency-critical call", async () => {
    modelSays("direct_answer", "greeting");
    const long: ConversationTurn[] = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn ${i} ${"x".repeat(200)}`,
    }));
    await classifyIntent(input("explain closures in javascript", long));

    const sent = sentMessages();
    const historyMessages = sent.length - 2; // minus system + final user message
    // No history is sent for an ordinary classification turn.
    expect(historyMessages).toBe(0);
  });

  it("ignores a stale clarifying turn that the user already answered", async () => {
    modelSays("direct_answer", "greeting");
    await classifyIntent(
      input("explain closures in javascript", [
        { role: "assistant", content: CLARIFYING_QUESTION, clarifying: true },
        { role: "user", content: "a clicker" },
        { role: "assistant", content: "Built it." },
      ])
    );

    // No re-framing: the question was already answered by "a clicker".
    expect(finalUserMessage()).toBe("explain closures in javascript");
  });
});

describe("answers to a clarifying question are never re-asked", () => {
  // Every one of these is a valid answer to "which kind of duck game?".
  // Classified alone, each looks short/ambiguous — which is exactly how the
  // loop used to start.
  const ANSWERS = [
    "yes a simpl clicker",
    "a clicker",
    "clicker",
    "yes",
    "the first one",
    "simple clicker please",
    "clicker game",
    "2",
    "hunting one",
    "make it a platformer",
  ];

  for (const answer of ANSWERS) {
    it(`does not loop on: "${answer}"`, async () => {
      modelSays("task", "coding");
      const result = await classifyIntent(input(answer, awaitingAnswer()));
      expect(result.intent).toBe("task");
    });
  }

  it("does not re-trigger ambiguity heuristics on a short answer", async () => {
    // "yes" is under the 4-char ambiguity floor; without the suppression this
    // was force-downgraded to needs_clarification and looped.
    modelSays("task", "coding");
    const result = await classifyIntent(input("yes", awaitingAnswer()));
    expect(result.intent).not.toBe("needs_clarification");
  });

  it.each(["what can you do?", "Who made you?", "thanks"])("lets a person interrupt an old clarification with conversation: %s", async (message) => {
    modelSays("task", "coding");
    const result = await classifyIntent(input(message, awaitingAnswer()));
    expect(result.intent).toBe("direct_answer");
  });

  it("continues after an answer to the new numbered-question format", async () => {
    modelSays("task", "coding");
    const history: ConversationTurn[] = [
      { role: "user", content: "build a duck game" },
      { role: "assistant", content: "Which kind of duck game should I build?\n1. Clicker\n2. Hunting\n3. Simulation", clarifying: true, unresolved: true },
    ];
    const result = await classifyIntent(input("2", history));
    expect(result.intent).toBe("task");
  });

  it("still loops-free when the model call fails entirely", async () => {
    (modelGateway.completeText as any).mockResolvedValue("not json at all");
    const result = await classifyIntent(input("yes a simpl clicker", awaitingAnswer()));
    expect(result.intent).toBe("task");
  });

  it("the same short reply IS ambiguous with no question pending", async () => {
    // Guards the fix from over-reaching: suppression must be scoped to the
    // clarification case only.
    modelSays("needs_clarification", "clarifying", "What would you like to build?");
    const result = await classifyIntent(input("yes"));
    expect(result.intent).toBe("needs_clarification");
  });
});
