import { describe, expect, it } from "vitest";
import { actionAllowedForStep, isValidAgentTurn } from "../executor/step-runner";

describe("approved-step action contract", () => {
  it("prevents a write step from widening into a command", () => {
    expect(actionAllowedForStep("write_file", "write_file")).toBe(true);
    expect(actionAllowedForStep("write_file", "run_command")).toBe(false);
    expect(actionAllowedForStep("write_file", "read_file")).toBe(false);
  });

  it("keeps safe inspection flexible without allowing mutation", () => {
    expect(actionAllowedForStep("read_file", "search_codebase")).toBe(true);
    expect(actionAllowedForStep("search_codebase", "read_file")).toBe(true);
    expect(actionAllowedForStep("read_file", "write_file")).toBe(false);
  });

  it("allows finish only for an explicitly non-tool step", () => {
    expect(actionAllowedForStep(null, "write_file")).toBe(false);
    expect(actionAllowedForStep(null, "finish")).toBe(true);
    expect(actionAllowedForStep("write_file", "finish")).toBe(false);
    expect(actionAllowedForStep("run_command", "finish")).toBe(false);
  });
});

describe("agent turn schema", () => {
  const base = { thought: "t", action: "read_file", action_input: { path: "a.ts" }, done: false } as const;

  it("requires a non-empty summary when the turn claims to be done", () => {
    expect(isValidAgentTurn({ ...base, action: "finish", done: true, summary: "Wrote a.ts" })).toBe(true);
    expect(isValidAgentTurn({ ...base, action: "finish", done: true })).toBe(false);
    expect(isValidAgentTurn({ ...base, action: "finish", done: true, summary: "  " })).toBe(false);
  });

  it("does not require a summary for non-terminal turns", () => {
    expect(isValidAgentTurn({ ...base })).toBe(true);
  });
});
