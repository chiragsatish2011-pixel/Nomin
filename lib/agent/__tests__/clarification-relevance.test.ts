import { describe, expect, it } from "vitest";
import { toClarificationQuestion } from "../clarification";
import { clarificationContextFor } from "../clarification-context";
import type { NormalInput } from "../types";

function input(user_message: string, file_tree: string[]): NormalInput {
  return {
    session_id: "clarification-relevance",
    workspace_path: "workspace",
    mode: "execute",
    model: "trion-1.4",
    user_message,
    conversation_history: [],
    attached_context: [],
    workspace_snapshot: { file_tree, open_files: [] },
  };
}

describe("project-relevant clarification questions", () => {
  it("does not ask the user to choose a framework the project already establishes", () => {
    const request = input("make a dashboard", ["app/page.tsx", "app/globals.css", "next.config.mjs"]);
    const question = toClarificationQuestion("Which framework should I use?", request.user_message, clarificationContextFor(request));

    expect(question).toContain("Next.js");
    expect(question).toContain("What should this dashboard help you monitor or manage?");
    expect(question).not.toContain("Which framework");
  });

  it("keeps a concrete product question rather than replacing it with generic copy", () => {
    const request = input("build a duck game", ["app/page.tsx"]);
    const question = toClarificationQuestion("Which kind of duck game should I build?\n1. Clicker\n2. Simulation", request.user_message, clarificationContextFor(request));

    expect(question).toContain("Which kind of duck game");
    expect(question).toContain("1. Clicker");
  });
});
