// Streaming Protocol — Supports both new and legacy UI event formats
// New format: status, plan, plan_update, tool_call, tool_result, result, error
// Legacy format: trace, output, result (with AgentResult), error

import type {
  AgentOutput,
  AgentTrace,
  ValidatedChatRequest,
  StreamEvent,
  ErrorOutput,
} from "./types";

// Re-export types for UI compatibility
export type {
  AgentOutput,
  AgentTrace,
  ValidatedChatRequest,
  StreamEvent,
  ErrorOutput,
};

// Legacy result format for UI compatibility
export type AgentResult = {
  sessionId: string;
  inputKind: "conversation" | "coding_task" | "tool_task";
  outputs: AgentOutput[];
  traces: AgentTrace[];
  stopReason: "completed" | "approval_required" | "max_iterations" | "error" | "cancelled" | "needs_clarification";
};

// Legacy AgentOutput discriminated union for UI compatibility
export type LegacyAgentOutput =
  | { type: "chat_reply"; content: string }
  | { type: "code_artifact"; path: string; code: string; language?: string }
  | { type: "tool_call"; action: string; input: Record<string, unknown>; result?: unknown; requiresApproval: boolean }
  | { type: "error"; code: string; message: string; retryable: boolean };

// Legacy stream event format (for UI compatibility)
export type LegacyStreamEvent =
  | { type: "trace"; trace: AgentTrace }
  | { type: "output"; output: LegacyAgentOutput }
  | { type: "result"; data: AgentResult }
  | { type: "error"; error: ErrorOutput };

// Combined event type for parsing
export type AgentStreamEvent = StreamEvent | LegacyStreamEvent;

export function parseStreamEvent(value: unknown): AgentStreamEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Received a malformed agent event.");
  }

  switch (value.type) {
    case "status":
    case "progress":
    case "plan":
    case "plan_update":
    case "tool_call":
    case "tool_result":
    case "plan_skipped":
    case "plan_approval":
    case "result":
    case "error":
    case "trace":
    case "output":
      return value as AgentStreamEvent;
    default:
      throw new Error(`Unknown event type: ${value.type}`);
  }
}

// Alias for UI compatibility
export const parseAgentStreamEvent = parseStreamEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
