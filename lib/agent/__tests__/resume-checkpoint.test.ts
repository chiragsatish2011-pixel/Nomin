// Phase B: client-supplied resume checkpoints — validation, rehydration,
// evidence folding, and the graceful-fallback path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateClientCheckpoint,
  toPendingExecution,
  MAX_CHECKPOINT_JSON_CHARS,
} from "../resume-checkpoint";
import {
  getOrCreateSession,
  getPendingExecution,
  rehydratePendingExecution,
} from "../session-store";
import { applyTrace, emptyTaskState, resumePlan } from "../task-state";

const hoisted = vi.hoisted(() => ({ completeText: vi.fn(), complete: vi.fn() }));

vi.mock("../model-gateway", () => ({
  modelGateway: { completeText: hoisted.completeText, complete: hoisted.complete },
}));

vi.mock("../intent/classifier", () => ({
  classifyIntent: vi.fn(),
  isDefinitelyTask: vi.fn(() => false),
}));

import { runTurn } from "../orchestrator/state-machine";
import { classifyIntent } from "../intent/classifier";

const PUBLIC_PLAN = {
  summary: "Test site",
  steps: [
    { step_id: 1, description: "Read the page entry", state: "pending", tool: "read_file" },
    { step_id: 2, description: "Run the build check", state: "pending", tool: "run_command" },
  ],
};

const TRACE = [
  { step_id: 1, tool_name: "read_file", input: { path: "a.ts" }, output: "ok", status: "success", attempt: 1 },
];

const ARTIFACTS = [{ type: "file", language: "ts", content: "export {}" }];

function sessionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

describe("validateClientCheckpoint", () => {
  it("accepts the public Plan shape clients actually receive", () => {
    const checkpoint = validateClientCheckpoint({ plan: PUBLIC_PLAN, toolTrace: TRACE, artifacts: ARTIFACTS });
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.plan.plan_summary).toBe("Test site");
    expect(checkpoint?.plan.steps.map((step) => step.step_id)).toEqual([1, 2]);
    expect(checkpoint?.plan.steps[0]?.tool).toBe("read_file");
  });

  it("accepts empty trace and artifacts (fresh plan, no evidence yet)", () => {
    expect(validateClientCheckpoint({ plan: PUBLIC_PLAN, toolTrace: [], artifacts: [] })).not.toBeNull();
  });

  it("rejects malformed, oversized, and empty payloads", () => {
    expect(validateClientCheckpoint(null)).toBeNull();
    expect(validateClientCheckpoint("nope")).toBeNull();
    expect(validateClientCheckpoint({})).toBeNull();
    // Empty steps.
    expect(validateClientCheckpoint({
      plan: { summary: "x", steps: [] }, toolTrace: [], artifacts: [],
    })).toBeNull();
    // Bad trace status.
    expect(validateClientCheckpoint({
      plan: PUBLIC_PLAN,
      toolTrace: [{ step_id: 1, tool_name: "read_file", input: {}, output: "x", status: "weird", attempt: 1 }],
      artifacts: [],
    })).toBeNull();
    // Oversized total.
    expect(validateClientCheckpoint({
      plan: PUBLIC_PLAN,
      toolTrace: [],
      artifacts: [{ type: "file", content: "x".repeat(MAX_CHECKPOINT_JSON_CHARS) }],
    })).toBeNull();
  });

  it("strips server-audit fields and stale preview URLs", () => {
    const checkpoint = validateClientCheckpoint({
      plan: PUBLIC_PLAN,
      toolTrace: [{ step_id: 1, tool_name: "read_file", input: {}, output: "ok", status: "success", attempt: 1, path_used: "hosted" }],
      artifacts: [{ type: "preview", content: "x", preview_url: "https://stale.example/preview" }],
    });
    expect(checkpoint?.toolTrace[0]).not.toHaveProperty("path_used");
    expect(checkpoint?.artifacts[0]).not.toHaveProperty("preview_url");
  });
});

describe("server rehydrate round-trip", () => {
  it("restores a validated checkpoint into the session map", () => {
    const id = sessionId("rehydrate");
    getOrCreateSession(id, "execute", "trion-1.4", "workspace");
    expect(getPendingExecution(id)).toBeNull();
    const checkpoint = validateClientCheckpoint({ plan: PUBLIC_PLAN, toolTrace: TRACE, artifacts: ARTIFACTS });
    if (!checkpoint) throw new Error("test fixture must validate");
    expect(rehydratePendingExecution(id, toPendingExecution(checkpoint, "make a test website"))).toBe(true);
    expect(getPendingExecution(id)?.plan.plan_summary).toBe("Test site");
    expect(getPendingExecution(id)?.originalUserText).toBe("make a test website");
  });

  it("folds checkpoint evidence into a fresh task ledger so done steps stay done", () => {
    const checkpoint = validateClientCheckpoint({ plan: PUBLIC_PLAN, toolTrace: TRACE, artifacts: ARTIFACTS });
    if (!checkpoint) throw new Error("test fixture must validate");
    const pending = toPendingExecution(checkpoint, "make a test website");
    const taskState = emptyTaskState(pending.originalUserText);
    resumePlan(taskState, pending.plan);
    applyTrace(taskState, pending.toolTrace);
    expect(taskState.steps.find((step) => step.id === 1)?.state).toBe("done");
    expect(taskState.steps.find((step) => step.id === 2)?.state).toBe("pending");
  });
});

describe("resume fallback without any checkpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restarts as a fresh turn with a notice instead of dead-ending", async () => {
    // A greeting resolves deterministically with no model call.
    const events: unknown[] = [];
    const output = await runTurn(
      {
        sessionId: sessionId("fallback"),
        userText: "hello",
        mode: "execute",
        model: "trion-1.4",
        workspacePath: "workspace",
        snapshot: [],
        resume: true,
      },
      (event) => events.push(event),
      Date.now(),
    );
    expect(output.status).toBe("done");
    expect(events).toContainEqual({
      type: "progress",
      stage: "notice",
      message: "Continuing from your last message — prior progress couldn't be restored.",
    });
    expect(classifyIntent).not.toHaveBeenCalled();
  });
});
