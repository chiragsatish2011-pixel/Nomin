// Regression suite for "empty search result treated as a dead end".
//
// Observed failure: on a fresh workspace, "make me a simple duck game" ran
// search_codebase, matched nothing, and the agent gave up with "there are no
// files to work from and I couldn't continue building the duck clicker game."
//
// Root cause was in code, not just prompting: verifyToolResult() converted an
// empty search/read into a hard tool FAILURE, which burned both retries and
// then threw StepFailedError. An empty result is a fact about the workspace and
// on a build-from-scratch request it is the expected one.

// @ts-nocheck
import { describe, it, expect } from "vitest";
import { annotateEmptyResult } from "../executor/step-runner";
import { EXECUTE_SYSTEM_PROMPT } from "../static-prompts";
import { trimHistoryForTier } from "../input";

describe("empty tool results are annotated, not treated as errors", () => {
  it("tells the model an empty search is expected when scaffolding", () => {
    const out = annotateEmptyResult("search_codebase", JSON.stringify({ results: [] }));
    expect(out).toMatch(/not an error/i);
    expect(out).toMatch(/proceed to scaffold/i);
    // The raw payload must survive so the model still sees the real result.
    expect(out).toContain('"results":[]');
  });

  it("leaves a non-empty search result untouched", () => {
    const raw = JSON.stringify({ results: [{ path: "src/a.ts", line: 1 }] });
    expect(annotateEmptyResult("search_codebase", raw)).toBe(raw);
  });

  it("explains an empty file rather than calling it a failure", () => {
    const out = annotateEmptyResult("read_file", JSON.stringify({ content: "" }));
    expect(out).toMatch(/not an error/i);
  });

  it("leaves a populated file untouched", () => {
    const raw = JSON.stringify({ content: "console.log(1)" });
    expect(annotateEmptyResult("read_file", raw)).toBe(raw);
  });

  it("passes through malformed output unchanged", () => {
    expect(annotateEmptyResult("search_codebase", "<<not json>>")).toBe("<<not json>>");
  });

  it("does not annotate tools where emptiness has no meaning", () => {
    const raw = JSON.stringify({ results: [] });
    expect(annotateEmptyResult("run_command", raw)).toBe(raw);
  });
});

describe("the execute prompt conditions on task intent, not on emptiness", () => {
  it("instructs the model to build rather than stop", () => {
    expect(EXECUTE_SYSTEM_PROMPT).toMatch(/EMPTY RESULTS ARE NOT FAILURES/);
    expect(EXECUTE_SYSTEM_PROMPT).toMatch(/no files to work from/i);
  });

  it("still allows surfacing a genuine mismatch when editing existing code", () => {
    expect(EXECUTE_SYSTEM_PROMPT).toMatch(/EDIT \/ FIX/);
    expect(EXECUTE_SYSTEM_PROMPT).toMatch(/genuine mismatch/i);
  });
});

describe("history trimming pins the clarifying question", () => {
  it("keeps a trailing clarifying turn even when the budget is exhausted", () => {
    const filler = Array.from({ length: 400 }, (_, i) => ({
      role: "user" as const,
      content: `filler turn ${i} `.repeat(40),
    }));
    const history = [
      ...filler,
      { role: "assistant" as const, content: "Which kind of duck game?", clarifying: true },
    ];

    const trimmed = trimHistoryForTier(history, "trion-1.4");
    expect(trimmed[trimmed.length - 1].content).toBe("Which kind of duck game?");
    expect(trimmed[trimmed.length - 1].clarifying).toBe(true);
  });

  it("does not pin an ordinary trailing assistant turn", () => {
    const history = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "ordinary reply" },
    ];
    const trimmed = trimHistoryForTier(history, "trion-1.4");
    // Fits the budget anyway; the point is it is not specially pinned/duplicated.
    expect(trimmed.filter((t) => t.content === "ordinary reply")).toHaveLength(1);
  });
});
