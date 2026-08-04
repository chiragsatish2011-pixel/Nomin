import { describe, expect, it } from "vitest";
import { actionAllowedForStep } from "../executor/step-runner";

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
