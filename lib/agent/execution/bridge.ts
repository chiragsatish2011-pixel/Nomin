// Execution Bridge — Server ↔ Client WebContainer tool execution.
//
// The agent loop runs on the server, but ALL filesystem/command execution
// happens inside a WebContainer sandbox owned by the client browser. When a
// tool must run, the server:
//   1. emits a tool_call event carrying a unique execution_id,
//   2. registers a pending promise keyed by `${sessionId}:${executionId}`,
//   3. blocks the step-runner until the client posts the ToolResult back to
//      /api/trion/tool-result (or the timeout fires).
//
// The same module hosts the plan-approval gate (Step 1.5): after the plan
// streams, the orchestrator blocks on awaitPlanApproval() until the client
// posts a decision to /api/trion/approval. The gate is a HARD pause — Step 3
// cannot begin before the user approves.
//
// There is deliberately NO local fallback: if the client executor never
// answers, the promise rejects with a typed error that flows through the
// normal Step 3 retry/decision loop. A silently-degraded local execution
// would mask the real failure mode, so it does not exist here.

import type { ToolResult } from "../types";

/** A missing browser bridge should fail fast instead of holding an SSE request
 * for three minutes and then spending two model retries on an impossible
 * recovery. Normal WebContainer boot/install is prewarmed on the client; 45s
 * still leaves room for a cold start while making the failure actionable. */
export const CLIENT_EXECUTION_TIMEOUT_MS = Number(process.env.TRION_CLIENT_EXECUTION_TIMEOUT_MS ?? 45_000);
/** An active browser tool may be installing or building. Heartbeats extend the
 * idle timer, but never beyond this absolute ceiling. */
export const CLIENT_EXECUTION_MAX_MS = Math.max(
  CLIENT_EXECUTION_TIMEOUT_MS,
  Number(process.env.TRION_CLIENT_EXECUTION_MAX_MS ?? 180_000)
);

type PendingExecution = {
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
  idleTimer: ReturnType<typeof setTimeout>;
  hardTimer: ReturnType<typeof setTimeout>;
  idleTimeoutMs: number;
};

// API route modules can be evaluated as separate bundles in Next development
// mode: `/api/trion/chat` creates the pending promise while
// `/api/trion/tool-result` resolves it. A plain module-level Map therefore
// makes a real browser result look like an unknown execution id, even though
// both routes are in the same Node process. Pin the registry to globalThis,
// exactly as we do for sessions, ledgers, and the rate governor.
const executionStore = globalThis as typeof globalThis & {
  __trionPendingExecutions?: Map<string, PendingExecution>;
};
const pendingExecutions: Map<string, PendingExecution> =
  (executionStore.__trionPendingExecutions ??= new Map<string, PendingExecution>());

function key(sessionId: string, executionId: string): string {
  return `${sessionId}:${executionId}`;
}

/** Register a pending execution and return the promise that resolves when the
 *  client posts the tool result. Rejects on timeout with a typed error. */
export function awaitClientExecution(
  sessionId: string,
  executionId: string,
  timeoutMs: number = CLIENT_EXECUTION_TIMEOUT_MS
): Promise<ToolResult> {
  const k = key(sessionId, executionId);

  return new Promise<ToolResult>((resolve, reject) => {
    const rejectForIdle = () => {
      const pending = pendingExecutions.get(k);
      if (!pending) return;
      clearTimeout(pending.hardTimer);
      pendingExecutions.delete(k);
      pending.reject(new Error(`WebContainer bridge unavailable: no browser tool result arrived within ${Math.round(timeoutMs / 1000)}s. Keep the Trion workspace tab open and retry.`));
    };
    const idleTimer = setTimeout(rejectForIdle, timeoutMs);
    const hardTimer = setTimeout(() => {
      const pending = pendingExecutions.get(k);
      if (!pending) return;
      clearTimeout(pending.idleTimer);
      pendingExecutions.delete(k);
      pending.reject(new Error(`WebContainer operation exceeded ${Math.round(CLIENT_EXECUTION_MAX_MS / 1000)}s. Retry to continue from the saved workspace state.`));
    }, CLIENT_EXECUTION_MAX_MS);

    pendingExecutions.set(k, { resolve, reject, idleTimer, hardTimer, idleTimeoutMs: timeoutMs });
  });
}

/** Refresh the idle deadline while the browser is demonstrably still running
 * the emitted tool. This is a heartbeat, not a result: the server still waits
 * for the real typed ToolResult before moving to the next step. */
export function touchClientExecution(sessionId: string, executionId: string): boolean {
  const pending = pendingExecutions.get(key(sessionId, executionId));
  if (!pending) return false;
  clearTimeout(pending.idleTimer);
  pending.idleTimer = setTimeout(() => {
    const current = pendingExecutions.get(key(sessionId, executionId));
    if (!current) return;
    clearTimeout(current.hardTimer);
    pendingExecutions.delete(key(sessionId, executionId));
    current.reject(new Error(`WebContainer bridge unavailable: no browser tool result arrived within ${Math.round(current.idleTimeoutMs / 1000)}s. Keep the Trion workspace tab open and retry.`));
  }, pending.idleTimeoutMs);
  return true;
}

/** Resolve a pending execution from the client's tool-result POST. Returns
 *  true when a matching pending execution was found and resolved. */
export function resolveClientExecution(sessionId: string, executionId: string, result: ToolResult): boolean {
  const k = key(sessionId, executionId);
  const pending = pendingExecutions.get(k);
  if (!pending) return false;

  clearTimeout(pending.idleTimer);
  clearTimeout(pending.hardTimer);
  pendingExecutions.delete(k);
  pending.resolve(result);
  return true;
}

/** Reject a pending execution (used by request cancellation). */
export function rejectClientExecution(sessionId: string, executionId: string, error: Error): boolean {
  const k = key(sessionId, executionId);
  const pending = pendingExecutions.get(k);
  if (!pending) return false;

  clearTimeout(pending.idleTimer);
  clearTimeout(pending.hardTimer);
  pendingExecutions.delete(k);
  pending.reject(error);
  return true;
}

/** Abort every pending execution for a session (client disconnected). */
export function abortSessionExecutions(sessionId: string): void {
  for (const [k, pending] of pendingExecutions.entries()) {
    if (!k.startsWith(`${sessionId}:`)) continue;
    clearTimeout(pending.idleTimer);
    clearTimeout(pending.hardTimer);
    pendingExecutions.delete(k);
    pending.reject(new Error("Client disconnected before the WebContainer tool result arrived."));
  }
}

// -- Plan approval gate (Step 1.5) ------------------------------------------

export type ApprovalDecision = "approve" | "cancel";

const APPROVAL_TIMEOUT_MS = 600_000;

type PendingApproval = {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
};

// Approval is the same cross-route rendezvous as tool results, so it needs the
// same process-wide identity in development and production route bundles.
const approvalStore = globalThis as typeof globalThis & {
  __trionPendingApprovals?: Map<string, PendingApproval>;
};
const pendingApprovals: Map<string, PendingApproval> =
  (approvalStore.__trionPendingApprovals ??= new Map<string, PendingApproval>());

/** Read-only operational signal for the local health endpoint. It lets the UI
 * and diagnostics distinguish an approval wait from a stuck model or browser
 * operation without exposing any session content. */
export function getPendingApprovalCount(): number {
  return pendingApprovals.size;
}

/** Internal health telemetry: a pending browser execution means the model
 * turn is waiting for the originating tab, not waiting on a provider call. */
export function getPendingExecutionCount(): number {
  return pendingExecutions.size;
}

/** Block the turn until the client posts a decision to /api/trion/approval.
 *  This is a HARD gate: nothing executes while the promise is pending. A
 *  stale gate (no answer) resolves to "cancel" after the timeout so the turn
 *  ends cleanly instead of hanging the SSE stream forever. */
export function awaitPlanApproval(sessionId: string, timeoutMs: number = APPROVAL_TIMEOUT_MS): Promise<ApprovalDecision> {
  const k = approvalKey(sessionId);

  return new Promise<ApprovalDecision>((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(k);
      resolve("cancel");
    }, timeoutMs);

    pendingApprovals.set(k, { resolve, timer });
  });
}

/** Resolve a pending approval gate from the client's approval POST. Returns
 *  true when a matching pending gate was found and resolved. */
export function resolvePlanApproval(sessionId: string, decision: ApprovalDecision): boolean {
  const k = approvalKey(sessionId);
  const pending = pendingApprovals.get(k);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingApprovals.delete(k);
  pending.resolve(decision);
  return true;
}

/** Close a pending approval gate without the user answering (used when the
 *  client disconnects or the turn is stopped). Resolves to "cancel" so the
 *  orchestrator ends the turn cleanly rather than crashing the stream. */
export function closePlanApproval(sessionId: string): boolean {
  const k = approvalKey(sessionId);
  const pending = pendingApprovals.get(k);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingApprovals.delete(k);
  pending.resolve("cancel");
  return true;
}

function approvalKey(sessionId: string): string {
  return `${sessionId}:approval`;
}
