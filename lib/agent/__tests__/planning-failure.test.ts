import { describe, expect, it } from "vitest";
import { planningFailureSynthesis, answerFailureSynthesis } from "../synthesis/generator";
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

  it("points a rejected key at Connections instead of a blind retry", () => {
    const result = planningFailureSynthesis(new Error("Your API key was rejected. Check the connection in Settings."));
    expect(result.message).toMatch(/rejected its key/i);
    expect(result.next_action_hint).toMatch(/Connections/i);
  });

  it("points a missing model at Connections instead of a blind retry", () => {
    const result = planningFailureSynthesis(new Error("Trion request failed with HTTP 404: model not found."));
    expect(result.message).toMatch(/model or endpoint was not found/i);
    expect(result.next_action_hint).toMatch(/Connections/i);
  });

  it("names a provider-side failure as retryable rather than a plan bug", () => {
    const result = planningFailureSynthesis(new Error("Trion request failed with HTTP 500: boom."));
    expect(result.message).toMatch(/provider failed the request/i);
  });

  it("keeps the generic fallback for genuinely unknown plan errors", () => {
    const result = planningFailureSynthesis(new Error("The plan came back without any usable steps."));
    expect(result.message).toMatch(/could not prepare the build plan, so no project work was started/i);
  });

  it("explains a browser bridge pause after partial work", () => {
    const result = pausedTaskSynthesis([
      { step_id: 1, tool_name: "write_file", input: { path: "src/app.ts", content: "ok" }, output: "Written.", status: "success", attempt: 1 },
    ], new Error("Step 2 could not be completed: WebContainer bridge unavailable: no browser tool result arrived within 45s."));
    expect(result.message).toMatch(/browser workspace stopped responding/i);
    expect(result.next_action_hint).toMatch(/workspace tab open/i);
  });
});

describe("answerFailureSynthesis", () => {
  it("never mentions a build plan for a conversational failure", () => {
    for (const error of [
      new Error("Your API key was rejected. Check the connection in Settings."),
      new Error("Trion request failed with HTTP 404: model not found."),
      new Error("Trion request timed out."),
      new Error("Trion is temporarily at its shared model-request limit."),
      new Error("something entirely unexpected"),
    ]) {
      const result = answerFailureSynthesis(error);
      expect(result.message).not.toMatch(/build plan/i);
      expect(result.message).toMatch(/reply/i);
    }
  });

  it("routes credential and model errors to Connections", () => {
    expect(answerFailureSynthesis(new Error("Your API key was rejected.")).next_action_hint).toMatch(/Connections/i);
    expect(answerFailureSynthesis(new Error("Trion request failed with HTTP 404: Not Found")).message).toMatch(/not found/i);
  });
});
