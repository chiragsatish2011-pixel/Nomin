import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyIntent } from "../intent/classifier";
import type { NormalInput } from "../types";

vi.mock("../model-gateway", () => ({
  modelGateway: { completeText: vi.fn() },
}));

import { modelGateway } from "../model-gateway";

function input(userMessage: string, fileTree: string[]): NormalInput {
  return {
    session_id: "context-first",
    workspace_path: "workspace",
    mode: "execute",
    model: "trion-1.4",
    user_message: userMessage,
    conversation_history: [],
    attached_context: [],
    workspace_snapshot: { file_tree: fileTree, open_files: [] },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("context-first clarification", () => {
  it("uses an established auth pattern instead of asking again", async () => {
    (modelGateway.completeText as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ intent: "needs_clarification", activity: "clarifying", reason: "Which auth library should I use?" }),
    );

    const result = await classifyIntent(input("add authentication to the profile area", [
      "app/page.tsx",
      "app/api/auth/[...nextauth]/route.ts",
      "lib/auth.ts",
    ]));

    expect(result.intent).toBe("task");
    expect(result.assumption).toBe("I’ll extend the authentication pattern already used in app/api/auth/[...nextauth]/route.ts.");
    const modelMessage = (modelGateway.completeText as ReturnType<typeof vi.fn>).mock.calls[0][0][1].content;
    expect(modelMessage).toContain("Authentication-related files already exist");
  });

  it("does not invent a workspace assumption for a genuine creative choice", async () => {
    (modelGateway.completeText as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ intent: "needs_clarification", activity: "clarifying", reason: "Which kind of duck game should I build?\n1. Clicker\n2. Hunting\n3. Simulation" }),
    );

    const result = await classifyIntent(input("build a duck game", ["app/page.tsx", "app/globals.css"]));
    expect(result.intent).toBe("needs_clarification");
    expect(result.assumption).toBeUndefined();
  });

  it("does not let an overconfident model skip the user-owned game decision", async () => {
    (modelGateway.completeText as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ intent: "task", activity: "coding", reason: "I will build a game." }),
    );

    const result = await classifyIntent(input("build a duck game", ["app/page.tsx", "app/globals.css"]));
    expect(result.intent).toBe("needs_clarification");
    expect(result.activity).toBe("clarifying");
  });
});
