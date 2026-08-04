// The think-before-acting gate.
//
// Both directions matter and they cost different things. A missed ambiguity
// costs a wrong first tool call and a retry; a false positive costs a block of
// reasoning tokens on a step whose answer was already written in the step
// description. The gate is deliberately biased towards thinking, so the
// "determined" tests below are the ones that constrain it.

// @ts-nocheck
import { describe, it, expect } from "vitest";
import { canUseFastTier, decideThinking } from "../thinking";
import { emptyTaskState } from "../task-state";

const NO_STATE = { isRetry: false, state: null };

describe("thinks when the decision is genuinely open", () => {
  it("on a retry", () => {
    const decision = decideThinking({ description: "write projects/web/src/App.tsx", tool: "write_file" }, { isRetry: true, state: null });
    expect(decision).toEqual({ think: true, reason: "retry" });
  });

  it("when the plan named no tool", () => {
    expect(decideThinking({ description: "work out the right approach", tool: null }, NO_STATE).reason).toBe("no_tool_hint");
  });

  it("on diagnostic work, where the description is a symptom not an action", () => {
    for (const description of [
      "fix the syntax error in projects/web/src/broken.ts",
      "find where the auth token is validated",
      "investigate why the build fails",
    ]) {
      expect(decideThinking({ description, tool: "read_file" }, NO_STATE).think, description).toBe(true);
    }
  });

  it("when the step names more than one target", () => {
    const decision = decideThinking(
      { description: "rename the class in styles.css and update App.tsx to match", tool: "write_file" },
      NO_STATE
    );
    expect(decision.think).toBe(true);
  });

  it("on conjoined actions that one tool call cannot satisfy", () => {
    const decision = decideThinking({ description: "create the helper and use it in the app", tool: "run_command" }, NO_STATE);
    expect(decision).toEqual({ think: true, reason: "conjoined_actions" });
  });

  it("when editing a file this run has never read", () => {
    const decision = decideThinking({ description: "update projects/web/src/App.tsx via codemod", tool: "run_command" }, NO_STATE);
    expect(decision).toEqual({ think: true, reason: "blind_edit" });
  });

  it("but NOT once that file has been read", () => {
    const state = emptyTaskState("g");
    state.filesTouched.push({ path: "projects/web/src/App.tsx", action: "read", stepId: 1 });
    const decision = decideThinking(
      { description: "update projects/web/src/App.tsx via codemod", tool: "run_command" },
      { isRetry: false, state }
    );
    expect(decision.think).toBe(false);
  });
});

describe("authoring ALWAYS thinks", () => {
  // Not a correctness rule — an effort rule, and it is here because of a
  // measurement. With thinking off, a write_file step answered "finish" instead
  // of writing the file on eight of nine steps of a scaffold: emitting a whole
  // file body is the most expensive thing the model can be asked for and
  // "finish" is the cheapest, so with no deliberation it took the exit.
  it("on a create whose path the description already names", () => {
    expect(decideThinking({ description: "create projects/web/src/Counter.tsx", tool: "write_file" }, NO_STATE)).toEqual({
      think: true,
      reason: "authoring",
    });
  });

  it("even when the file has already been read", () => {
    const state = emptyTaskState("g");
    state.filesTouched.push({ path: "projects/web/src/App.tsx", action: "read", stepId: 1 });
    expect(decideThinking({ description: "update projects/web/src/App.tsx", tool: "write_file" }, { isRetry: false, state }).think).toBe(true);
  });
});

describe("skips thinking when the step already determines the action", () => {
  it("on a plain read", () => {
    expect(decideThinking({ description: "read package.json", tool: "read_file" }, NO_STATE).think).toBe(false);
  });

  it("on a named command", () => {
    expect(decideThinking({ description: "run npm install in projects/web", tool: "run_command" }, NO_STATE).think).toBe(false);
  });

  it("on a literal search", () => {
    expect(decideThinking({ description: 'search the workspace for "vite"', tool: "search_codebase" }, NO_STATE).think).toBe(false);
  });
});

describe("cheap-tier right-sizing", () => {
  const determined = { think: false, reason: "determined_by_step" };

  it("uses the cheap tier for determined non-authoring steps", () => {
    for (const tool of ["read_file", "search_codebase", "run_command"]) {
      expect(canUseFastTier({ tool }, determined), tool).toBe(true);
    }
  });

  it("never uses it for authoring file content", () => {
    // Emitting a path is formatting; emitting the body of a source file is not.
    expect(canUseFastTier({ tool: "write_file" }, determined)).toBe(false);
  });

  it("never uses it when the step is ambiguous", () => {
    expect(canUseFastTier({ tool: "read_file" }, { think: true, reason: "retry" })).toBe(false);
  });
});
