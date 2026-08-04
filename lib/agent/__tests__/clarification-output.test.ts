import { describe, expect, it } from "vitest";
import { buildClarificationOutput, toClarificationQuestion } from "../clarification";

describe("toClarificationQuestion", () => {
  it("keeps a concise user-facing question", () => {
    expect(toClarificationQuestion("Which framework should I use?")).toBe("Which framework should I use?");
  });

  it("rejects classifier self-narration", () => {
    expect(toClarificationQuestion("The user wants to build something but provides no details. I need to clarify what they want to build."))
      .toContain("What outcome should I help you create?");
  });

  it("rejects a non-question even when it contains clarification language", () => {
    expect(toClarificationQuestion("I need to clarify the missing details"))
      .toContain("What outcome should I help you create?");
  });

  it("turns a vague game clarification into one specific numbered decision", () => {
    expect(toClarificationQuestion("Could you clarify?", "build a duck game"))
      .toBe("Which kind of duck game should I build?\n1. Clicker\n2. Hunting\n3. Simulation\n4. Platformer");
  });

  it("keeps clarification output as plain text with no plan, trace, or artifacts", () => {
    const output = buildClarificationOutput("Which kind of duck game should I build?\n1. Clicker\n2. Simulation");
    expect(output.status).toBe("needs_clarification");
    expect(output.plan).toBeNull();
    expect(output.tool_trace).toEqual([]);
    expect(output.artifacts).toEqual([]);
  });
});
