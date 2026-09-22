// Skip TypeScript check for this test file - vitest globals are only available at runtime
// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from "vitest";
import { classifyIntent } from "../intent/classifier";
import type { NormalInput } from "../types";

vi.mock("../model-gateway", () => {
  const mockCompleteText = vi.fn();
  return {
    modelGateway: { completeText: mockCompleteText },
  };
});

import { modelGateway } from "../model-gateway";

function createMockInput(userMessage: string): NormalInput {
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

function mockClassifierResponse(intent: string, activity: string, reason: string) {
  (modelGateway.completeText as any).mockResolvedValue(
    JSON.stringify({ intent, activity, reason })
  );
}

describe("classifyIntent - comprehensive classification tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- DIRECT ANSWER CASES ---
  describe("direct_answer: greetings", () => {
    it("classifies 'hi' as direct_answer", async () => {
      mockClassifierResponse("direct_answer", "greeting", "greeting");
      const result = await classifyIntent(createMockInput("hi"));
      expect(result.intent).toBe("direct_answer");
      expect(result.activity).toBe("greeting");
    });

    it("classifies 'hello' as direct_answer", async () => {
      mockClassifierResponse("direct_answer", "greeting", "greeting");
      const result = await classifyIntent(createMockInput("hello"));
      expect(result.intent).toBe("direct_answer");
    });

    it("classifies 'hey there' as direct_answer", async () => {
      mockClassifierResponse("direct_answer", "greeting", "greeting");
      const result = await classifyIntent(createMockInput("hey there"));
      expect(result.intent).toBe("direct_answer");
    });
  });

  describe("direct_answer: identity questions", () => {
    it("classifies 'wt are u?' as direct_answer", async () => {
      mockClassifierResponse("direct_answer", "answering", "identity question");
      const result = await classifyIntent(createMockInput("wt are u?"));
      expect(result.intent).toBe("direct_answer");
      expect(result.activity).toBe("answering");
    });

    it("classifies 'who are you?' as direct_answer", async () => {
      mockClassifierResponse("direct_answer", "answering", "identity question");
      const result = await classifyIntent(createMockInput("who are you?"));
      expect(result.intent).toBe("direct_answer");
    });

    it("classifies 'what are you?' as direct_answer", async () => {
      mockClassifierResponse("direct_answer", "answering", "identity question");
      const result = await classifyIntent(createMockInput("what are you?"));
      expect(result.intent).toBe("direct_answer");
    });

    it("classifies 'what can u do?' as direct_answer", async () => {
      mockClassifierResponse("direct_answer", "answering", "capability question");
      const result = await classifyIntent(createMockInput("what can u do?"));
      expect(result.intent).toBe("direct_answer");
    });
  });

  describe("direct_answer: thanks/gratitude", () => {
    it("classifies 'thanks' as direct_answer", async () => {
      mockClassifierResponse("direct_answer", "thanking", "gratitude");
      const result = await classifyIntent(createMockInput("thanks"));
      expect(result.intent).toBe("direct_answer");
      expect(result.activity).toBe("thanking");
    });

    it("classifies 'thank you' as direct_answer", async () => {
      mockClassifierResponse("direct_answer", "thanking", "gratitude");
      const result = await classifyIntent(createMockInput("thank you"));
      expect(result.intent).toBe("direct_answer");
    });
  });

  describe("direct_answer: simple Q&A", () => {
    it("classifies 'how are you?' as direct_answer", async () => {
      mockClassifierResponse("direct_answer", "answering", "simple question");
      const result = await classifyIntent(createMockInput("how are you?"));
      expect(result.intent).toBe("direct_answer");
    });

    it("classifies 'what is the weather?' as direct_answer", async () => {
      mockClassifierResponse("direct_answer", "answering", "general knowledge");
      const result = await classifyIntent(createMockInput("what is the weather?"));
      expect(result.intent).toBe("direct_answer");
    });
  });

  // --- NEEDS_CLARIFICATION CASES ---
  describe("needs_clarification: vague/ambiguous inputs", () => {
    it("classifies 'wt canwe together do?' as needs_clarification", async () => {
      mockClassifierResponse("needs_clarification", "clarifying", "ambiguous input");
      const result = await classifyIntent(createMockInput("wt canwe together do?"));
      expect(result.intent).toBe("needs_clarification");
      expect(result.activity).toBe("clarifying");
    });

    it("classifies 'what can we do?' as needs_clarification", async () => {
      mockClassifierResponse("needs_clarification", "clarifying", "vague intent");
      const result = await classifyIntent(createMockInput("what can we do?"));
      expect(result.intent).toBe("needs_clarification");
    });

    it("classifies 'help me' as needs_clarification", async () => {
      mockClassifierResponse("needs_clarification", "clarifying", "no context");
      const result = await classifyIntent(createMockInput("help me"));
      expect(result.intent).toBe("needs_clarification");
    });

    it("classifies 'what should i do?' as needs_clarification", async () => {
      mockClassifierResponse("needs_clarification", "clarifying", "no context");
      const result = await classifyIntent(createMockInput("what should i do?"));
      expect(result.intent).toBe("needs_clarification");
    });

    it("classifies 'wt?' as needs_clarification", async () => {
      mockClassifierResponse("needs_clarification", "clarifying", "garbled");
      const result = await classifyIntent(createMockInput("wt?"));
      expect(result.intent).toBe("needs_clarification");
    });

    it("classifies 'wt can u do' as needs_clarification", async () => {
      mockClassifierResponse("needs_clarification", "clarifying", "ambiguous");
      const result = await classifyIntent(createMockInput("wt can u do"));
      expect(result.intent).toBe("needs_clarification");
    });
  });

  // --- TASK CASES ---
  describe("task: concrete actionable requests", () => {
    it("classifies 'create a hello.txt file' as task", async () => {
      mockClassifierResponse("task", "coding", "file creation");
      const result = await classifyIntent(createMockInput("create a hello.txt file"));
      expect(result.intent).toBe("task");
      expect(result.activity).toBe("coding");
    });

    it("classifies 'list all files in workspace root' as task", async () => {
      mockClassifierResponse("task", "searching", "file listing");
      const result = await classifyIntent(createMockInput("list all files in workspace root"));
      expect(result.intent).toBe("task");
    });

    it("classifies 'run the tests' as task", async () => {
      mockClassifierResponse("task", "testing", "test execution");
      const result = await classifyIntent(createMockInput("run the tests"));
      expect(result.intent).toBe("task");
      expect(result.activity).toBe("testing");
    });

    it("classifies 'debug the login issue' as task", async () => {
      mockClassifierResponse("task", "debugging", "bug fixing");
      const result = await classifyIntent(createMockInput("debug the login issue"));
      expect(result.intent).toBe("task");
      expect(result.activity).toBe("debugging");
    });

    it("classifies 'refactor the user service' as task", async () => {
      mockClassifierResponse("task", "refactoring", "code improvement");
      const result = await classifyIntent(createMockInput("refactor the user service"));
      expect(result.intent).toBe("task");
      expect(result.activity).toBe("refactoring");
    });

    it("classifies 'deploy to production' as task", async () => {
      mockClassifierResponse("task", "deploying", "deployment");
      const result = await classifyIntent(createMockInput("deploy to production"));
      expect(result.intent).toBe("task");
      expect(result.activity).toBe("deploying");
    });
  });

  // --- DETERMINISTIC FAST PATH (no model call at all) ---
  describe("closed conversational classes skip the classification call", () => {
    it.each([
      ["hi"],
      ["hello there"],
      ["thanks!"],
      ["who are you"],
      ["what can you do"],
    ])("answers %s without asking the model", async (message) => {
      (modelGateway.completeText as vi.Mock).mockRejectedValue(new Error("the model must not be called"));
      const result = await classifyIntent(createMockInput(message));
      expect(result.intent).toBe("direct_answer");
      expect(modelGateway.completeText).not.toHaveBeenCalled();
    });

    it("still asks the model when a greeting carries a real request", async () => {
      mockClassifierResponse("task", "coding", "work");
      const result = await classifyIntent(createMockInput("hi, can you create a login page for me"));
      expect(result.intent).toBe("task");
      expect(modelGateway.completeText).toHaveBeenCalled();
    });

    it("still asks the model for anything outside the closed classes", async () => {
      mockClassifierResponse("direct_answer", "explaining", "question");
      await classifyIntent(createMockInput("why is my vite build slow"));
      expect(modelGateway.completeText).toHaveBeenCalled();
    });
  });

  // --- FALLBACK HEURISTIC TESTS (when model fails) ---
  describe("fallback heuristic when model response is invalid", () => {
    it("falls back to direct_answer for an answerable question when model returns garbage", async () => {
      // NOT "hi": a bare greeting never reaches the model at all now (see the
      // fast-path tests below), so it cannot exercise the fallback.
      (modelGateway.completeText as vi.Mock).mockResolvedValue("not json at all");
      const result = await classifyIntent(createMockInput("explain closures in javascript"));
      expect(result.intent).toBe("direct_answer");
      expect(result.reason).toBe("Fallback heuristic");
    });

    it("falls back to needs_clarification for 'wt?' when model returns garbage", async () => {
      (modelGateway.completeText as vi.Mock).mockResolvedValue("not json at all");
      const result = await classifyIntent(createMockInput("wt?"));
      expect(result.intent).toBe("needs_clarification");
      expect(result.reason).toBe("Fallback heuristic");
    });

    it("falls back to task for 'create a file' when model returns garbage", async () => {
      (modelGateway.completeText as vi.Mock).mockResolvedValue("not json at all");
      const result = await classifyIntent(createMockInput("create a file"));
      expect(result.intent).toBe("task");
      expect(result.reason).toBe("Fallback heuristic");
    });

    it("falls back to task for 'debug the bug' when model returns garbage", async () => {
      (modelGateway.completeText as vi.Mock).mockResolvedValue("not json at all");
      const result = await classifyIntent(createMockInput("debug the bug"));
      expect(result.intent).toBe("task");
      expect(result.reason).toBe("Fallback heuristic");
    });
  });

  // --- TASK SIGNAL OVERRIDE TESTS ---
  describe("task signal words override conversational classification", () => {
    it("classifies 'can you fix this bug?' as task despite 'can you'", async () => {
      mockClassifierResponse("direct_answer", "answering", "question");
      // But TASK_SIGNAL_WORDS should override
      const result = await classifyIntent(createMockInput("can you fix this bug?"));
      expect(result.intent).toBe("task");
    });

    it("classifies 'can you create a file?' as task", async () => {
      mockClassifierResponse("direct_answer", "answering", "question");
      const result = await classifyIntent(createMockInput("can you create a file?"));
      expect(result.intent).toBe("task");
    });
  });
});

describe("classifyIntent - heuristic activity selection", () => {
  it("returns 'clarifying' for needs_clarification intent", async () => {
    mockClassifierResponse("needs_clarification", "clarifying", "ambiguous");
    const result = await classifyIntent(createMockInput("wt canwe do?"));
    expect(result.activity).toBe("clarifying");
  });

  it("returns 'answering' for identity questions", async () => {
    mockClassifierResponse("direct_answer", "answering", "identity");
    const result = await classifyIntent(createMockInput("who are you?"));
    expect(result.activity).toBe("answering");
  });

  it("returns 'greeting' for hi/hello", async () => {
    mockClassifierResponse("direct_answer", "greeting", "greeting");
    const result = await classifyIntent(createMockInput("hello"));
    expect(result.activity).toBe("greeting");
  });

  it("returns 'thanking' for thanks", async () => {
    mockClassifierResponse("direct_answer", "thanking", "gratitude");
    const result = await classifyIntent(createMockInput("thanks"));
    expect(result.activity).toBe("thanking");
  });
});

describe("classifyIntent - provider outage fallback", () => {
  it("routes a capability question to direct_answer when the model call fails", async () => {
    (modelGateway.completeText as any).mockRejectedValueOnce(new Error("Trion request timed out."));
    const result = await classifyIntent(createMockInput("wt can you do?"));
    expect(result.intent).toBe("direct_answer");
  });

  it("routes clear work to task when the model call fails", async () => {
    (modelGateway.completeText as any).mockRejectedValueOnce(new Error("Trion request failed with HTTP 500."));
    const result = await classifyIntent(createMockInput("create a file named x.txt"));
    expect(result.intent).toBe("task");
  });
});