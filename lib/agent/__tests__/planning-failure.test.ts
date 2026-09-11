import { describe, expect, it } from "vitest";
import { planningFailureSynthesis } from "../synthesis/generator";
import { pausedTaskSynthesis } from "../synthesis/generator";

describe("planningFailureSynthesis", () => {
  it("points an unconfigured installation to Connections", () => {
    const result = planningFailureSynthesis(new Error("Trion 1.4 is not configured in this environment."));
    expect(result.message).toMatch(/no model connection is configured/i);
    expect(result.next_action_hint).toMatch(/Settings/i);
  });

  it("keeps timeout recovery actionable", () => {
    const result = planningFailureSynthesis(new Error("Trion request timed out."));
    expect(result.message).toMatch(/did not respond in time/i);
    expect(result.next_action_hint).toMatch(/Retry once/i);
  });

  it("explains a browser bridge pause after partial work", () => {
    const result = pausedTaskSynthesis([
      { step_id: 1, tool_name: "write_file", input: { path: "src/app.ts", content: "ok" }, output: "Written.", status: "success", attempt: 1 },
    ], new Error("Step 2 could not be completed: WebContainer bridge unavailable: no browser tool result arrived within 45s."));
    expect(result.message).toMatch(/browser workspace stopped responding/i);
    expect(result.next_action_hint).toMatch(/workspace tab open/i);
  });
});
