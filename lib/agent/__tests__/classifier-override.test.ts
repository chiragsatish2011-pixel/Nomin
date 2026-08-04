// Regression suite for the recurring "conversational input becomes a fake task" bug.
//
// The failure mode this guards against: the classifier model correctly returns
// direct_answer, but a post-hoc keyword override in classifyIntent upgrades it to
// "task" because the sentence happens to contain a word like "write", "show" or
// "list". A task intent produces a plan, an execution trace, and (for write/command
// steps) an approval gate — all for input that should have short-circuited at Step 1.
//
// Every case below asserts on the FINAL intent returned by classifyIntent, with the
// model's own answer mocked, so a regression in the override logic fails here.

// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from "vitest";
import { classifyIntent } from "../intent/classifier";
import type { NormalInput } from "../types";

vi.mock("../model-gateway", () => ({
  modelGateway: { completeText: vi.fn() },
}));

import { modelGateway } from "../model-gateway";

function input(userMessage: string): NormalInput {
  return {
    session_id: "test-session",
    workspace_path: "/test",
    mode: "execute",
    model: "trion-1.4",
    user_message: userMessage,
    conversation_history: [],
    attached_context: [],
    workspace_snapshot: { file_tree: [], open_files: [] },
  };
}

function modelSays(intent: string, activity: string, reason = "r") {
  (modelGateway.completeText as any).mockResolvedValue(
    JSON.stringify({ intent, activity, reason })
  );
}

beforeEach(() => vi.clearAllMocks());

// Conversational/informational phrasings that each contain an incidental word from
// TASK_SIGNAL_WORDS. None of them asks the agent to touch the workspace.
const CONVERSATIONAL_WITH_TASK_WORDS: string[] = [
  "can you explain how to write a for loop in python?",
  "what's the best way to write clean code?",
  "hi! can you show me what you can do?",
  "do you have a list of your features?",
  "what does refactor actually mean?",
  "why do people run tests before merging?",
  "is it better to build a monolith or microservices?",
  "what's the difference between find and grep?",
  "how do you read a stack trace?",
  "thanks, that helped me find the issue",
  "who are you and what can you make?",
  "what makes a good test suite?",
  "can you tell me about the create keyword in sql?",
  "explain what a deploy pipeline is",
  "in general, how should i search a large codebase?",
];

describe("conversational input must stay direct_answer despite task keywords", () => {
  for (const text of CONVERSATIONAL_WITH_TASK_WORDS) {
    it(`keeps direct_answer for: "${text}"`, async () => {
      modelSays("direct_answer", "answering");
      const result = await classifyIntent(input(text));
      expect(result.intent).toBe("direct_answer");
    });
  }

  it("never assigns a conversational turn an execution activity", async () => {
    modelSays("direct_answer", "answering");
    const result = await classifyIntent(input("how do i write a good commit message?"));
    expect(result.intent).toBe("direct_answer");
    expect(["coding", "searching", "debugging", "deploying"]).not.toContain(result.activity);
  });
});

// The override exists to catch a model that under-classifies a real request.
// These must still come back as "task" so the fix does not swing too far.
const REAL_TASKS: string[] = [
  "write a function that reverses a string in src/utils.ts",
  "list all files in the workspace root",
  "fix the failing test in auth.spec.ts",
  "create a new file called notes.md",
  "run the build",
  "search the codebase for TODO comments",
  "add a dark mode toggle to the settings page",
  "delete the unused helper in lib/old.ts",
];

describe("genuine work requests are still classified as task", () => {
  for (const text of REAL_TASKS) {
    it(`keeps task for: "${text}"`, async () => {
      modelSays("task", "coding");
      const result = await classifyIntent(input(text));
      expect(result.intent).toBe("task");
    });
  }

  it("upgrades an under-classified imperative request to task", async () => {
    // Model wrongly says direct_answer for a clear imperative file request.
    modelSays("direct_answer", "answering");
    const result = await classifyIntent(input("create a file called todo.md with a checklist"));
    expect(result.intent).toBe("task");
  });
});

describe("ambiguous input still asks for clarification", () => {
  const AMBIGUOUS = ["wt canwe together do?", "what can we do?", "what should i do?"];
  for (const text of AMBIGUOUS) {
    it(`keeps needs_clarification for: "${text}"`, async () => {
      modelSays("needs_clarification", "clarifying", "What would you like to build?");
      const result = await classifyIntent(input(text));
      expect(result.intent).toBe("needs_clarification");
    });
  }
});

// ---------------------------------------------------------------------------
// The MIRROR-IMAGE failure, and the one the override table had no rule for.
//
// Observed live before this guard existed: "should i use tabs or spaces?" was
// answered with "Could you clarify which style guide or project conventions
// you'd like to follow for indentation?". The user asked a complete question and
// got homework back.
//
// None of these match AMBIGUOUS_PATTERNS, so no heuristic was firing — the model
// itself returned needs_clarification and nothing demoted it. Every case below
// mocks the model saying needs_clarification, which is the actual failure, so a
// regression cannot hide behind a model that happens to answer correctly.
// ---------------------------------------------------------------------------
const ANSWERABLE_QUESTIONS: string[] = [
  "should i use tabs or spaces?",
  "is typescript better than javascript",
  "what's the difference between let and const?",
  "how does garbage collection work?",
  "why is my bundle size so large in general?",
  "when should i use a monorepo?",
  "which is faster, a map or an object?",
  "can you explain closures?",
  "do you know what tree shaking is?",
  "does react re-render on every state change?",
  "would you recommend redux or context?",
  "who invented the git rebase workflow?",
  "what is the point of a lockfile?",
  "how do people usually structure a react project?",
  "is functional programming worth learning?",
  "explain the difference between http and https",
  "tell me about database indexing",
  "what are the tradeoffs of server side rendering?",
  "could you describe how oauth works?",
  "why do teams use feature flags?",
];

describe("an answerable question is never bounced back as a clarification", () => {
  for (const text of ANSWERABLE_QUESTIONS) {
    it(`demotes needs_clarification to direct_answer for: "${text}"`, async () => {
      modelSays("needs_clarification", "clarifying", "Could you clarify what you'd like to know?");
      const result = await classifyIntent(input(text));
      expect(result.intent).toBe("direct_answer");
    });
  }

  it("produces no plan-bearing activity for a demoted question", async () => {
    modelSays("needs_clarification", "clarifying", "Could you clarify?");
    const result = await classifyIntent(input("should i use tabs or spaces?"));
    expect(result.intent).toBe("direct_answer");
    expect(["coding", "searching", "debugging", "deploying"]).not.toContain(result.activity);
  });

  it("still clarifies when the question is genuinely vague", async () => {
    // "what should i do?" IS ambiguous — the demotion must not swing too far.
    modelSays("needs_clarification", "clarifying", "What would you like to build?");
    expect((await classifyIntent(input("what should i do?"))).intent).toBe("needs_clarification");
    expect((await classifyIntent(input("what can we do?"))).intent).toBe("needs_clarification");
  });

  it("does not demote a work request phrased as a question", async () => {
    modelSays("needs_clarification", "clarifying", "Could you clarify?");
    expect((await classifyIntent(input("can you create a file called notes.md?"))).intent).toBe("task");
    expect((await classifyIntent(input("could you fix the failing test?"))).intent).toBe("task");
  });

  it("leaves a question naming a concrete file for the model to route", async () => {
    // "what does App.tsx do?" may legitimately need a read_file, so the
    // heuristic declines to override rather than guessing.
    modelSays("needs_clarification", "clarifying", "Which App.tsx do you mean?");
    const result = await classifyIntent(input("what does App.tsx do?"));
    expect(result.intent).toBe("needs_clarification");
  });

  it("keeps the demotion off while a clarification is outstanding", async () => {
    // Mid-loop, the model sees the question + the reply and is the authority.
    modelSays("needs_clarification", "clarifying", "Still unclear — which framework?");
    const withPending: NormalInput = {
      ...input("what about vue?"),
      conversation_history: [
        { role: "assistant", content: "Which framework should I use?", clarifying: true, unresolved: true },
      ],
    };
    const result = await classifyIntent(withPending);
    expect(result.intent).toBe("needs_clarification");
  });
});
