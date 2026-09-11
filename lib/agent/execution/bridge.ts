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
  /** Server-side expectation: the browser-supplied step id must match the step
   *  that emitted this execution. The pending record — never the browser — is
   *  authoritative for what this execution was. */
  expectedStepId?: number;
  expectedAction?: string;
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
 *  client posts the tool result. Rejects on timeout with a typed error.
 *  `expected` binds the execution to the step/action that emitted it so a
 *  misdelivered browser result fails fast instead of entering the trace. */
export function awaitClientExecution(
  sessionId: string,
  executionId: string,
  timeoutMs: number = CLIENT_EXECUTION_TIMEOUT_MS,
  expected?: { stepId: number; action: string }
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

    pendingExecutions.set(k, {
      resolve,
      reject,
      idleTimer,
      hardTimer,
      idleTimeoutMs: timeoutMs,
      expectedStepId: expected?.stepId,
      expectedAction: expected?.action,
    });
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

const VALID_RESULT_STATUSES = new Set(["success", "error"]);
const VALID_ARTIFACT_TYPES = new Set(["code_diff", "file", "preview"]);

/** Strict shape check for a browser-posted tool result. The server never
 *  trusts a partial payload: an `ok:true` with a missing step, a wrong status
 *  string, or a malformed artifact must fail the step loudly instead of
 *  entering the execution trace as a success. */
export function validateToolResultShape(result: unknown): { ok: true; result: ToolResult } | { ok: false; error: string } {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, error: "Tool result must be a JSON object." };
  }
  const candidate = result as Record<string, unknown>;
  if (typeof candidate.step_id !== "number" || !Number.isInteger(candidate.step_id) || candidate.step_id < 1) {
    return { ok: false, error: "Tool result step_id must be a positive integer." };
  }
  if (typeof candidate.ok !== "boolean") {
    return { ok: false, error: "Tool result ok must be a boolean." };
  }
  if (typeof candidate.status !== "string" || !VALID_RESULT_STATUSES.has(candidate.status)) {
    return { ok: false, error: 'Tool result status must be "success" or "error".' };
  }
  if ((candidate.ok && candidate.status !== "success") || (!candidate.ok && candidate.status !== "error")) {
    return { ok: false, error: "Tool result ok and status disagree." };
  }
  if (typeof candidate.output !== "string") {
    return { ok: false, error: "Tool result output must be a string." };
  }
  if (candidate.error !== undefined && typeof candidate.error !== "string") {
    return { ok: false, error: "Tool result error must be a string." };
  }
  if (candidate.artifacts !== undefined) {
    if (!Array.isArray(candidate.artifacts)) {
      return { ok: false, error: "Tool result artifacts must be an array." };
    }
    for (const artifact of candidate.artifacts) {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
        return { ok: false, error: "Tool result artifact must be an object." };
      }
      const entry = artifact as Record<string, unknown>;
      if (typeof entry.type !== "string" || !VALID_ARTIFACT_TYPES.has(entry.type)) {
        return { ok: false, error: "Tool result artifact has an unknown type." };
      }
      if (typeof entry.content !== "string") {
        return { ok: false, error: "Tool result artifact content must be a string." };
      }
    }
  }
  return { ok: true, result: candidate as unknown as ToolResult };
}

/** Fail a pending execution with a precise error and release its timers.
 *  Malformed or misdelivered results are deterministic: no retry of the same
 *  payload can fix them, so the step retries immediately with a fresh
 *  execution instead of waiting out the bridge timeout. Returns true so the
 *  route stops the client from re-posting the same payload. */
function consumeWithError(k: string, pending: PendingExecution, message: string): true {
  clearTimeout(pending.idleTimer);
  clearTimeout(pending.hardTimer);
  pendingExecutions.delete(k);
  pending.reject(new Error(message));
  return true;
}

/** Resolve a pending execution from the client's tool-result POST. Returns
 *  true when a matching pending execution was found and consumed (resolved or
 *  failed fast). Returns false only for an unknown/expired execution id. */
export function resolveClientExecution(sessionId: string, executionId: string, result: ToolResult): boolean {
  const k = key(sessionId, executionId);
  const pending = pendingExecutions.get(k);
  if (!pending) return false;

  const shaped = validateToolResultShape(result);
  if (!shaped.ok) {
    return consumeWithError(k, pending, `WebContainer returned a malformed tool result (${shaped.error}) Retry the step.`);
  }
  if (pending.expectedStepId !== undefined && shaped.result.step_id !== pending.expectedStepId) {
    return consumeWithError(
      k,
      pending,
      `WebContainer returned a result for step ${shaped.result.step_id}, but step ${pending.expectedStepId} was waiting. The stale result was discarded; retry the step.`
    );
  }

  clearTimeout(pending.idleTimer);
  clearTimeout(pending.hardTimer);
  pendingExecutions.delete(k);
  pending.resolve(shaped.result);
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
  /** Identity of the plan awaiting approval. A decision for any other plan
   *  (stale replay after a new turn opened a new gate) is rejected. */
  planHash: string | null;
  createdAt: number;
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

/** Deterministic identity for an approved plan: summary plus the ordered
 *  (step, description, tool) triples. The executor compares the emission-time
 *  plan against this hash before mutating anything — the model can never
 *  silently widen an approved plan because the gate is bound to its bytes. */
export function hashPlan(plan: { plan_summary: string; steps: Array<{ step_id: number; description: string; tool: string | null }> }): string {
  const canonical = JSON.stringify({
    s: plan.plan_summary,
    steps: plan.steps.map((s) => [s.step_id, s.description, s.tool ?? null]),
  });
  let hash = 5381;
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) + hash + canonical.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Block the turn until the client posts a decision to /api/trion/approval.
 *  This is a HARD gate: nothing executes while the promise is pending. A
 *  stale gate (no answer) resolves to "cancel" after the timeout so the turn
 *  ends cleanly instead of hanging the SSE stream forever. */
export function awaitPlanApproval(
  sessionId: string,
  opts?: { planHash?: string; timeoutMs?: number } | number
): Promise<ApprovalDecision> {
  const k = approvalKey(sessionId);
  const timeoutMs = typeof opts === "number" ? opts : (opts?.timeoutMs ?? APPROVAL_TIMEOUT_MS);
  const planHash = typeof opts === "number" ? null : (opts?.planHash ?? null);

  return new Promise<ApprovalDecision>((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(k);
      resolve("cancel");
    }, timeoutMs);

    pendingApprovals.set(k, { resolve, timer, planHash, createdAt: Date.now() });
  });
}

/** Resolve a pending approval gate from the client's approval POST. Returns
 *  true when a matching pending gate was found and resolved. A decision that
 *  names a DIFFERENT plan hash than the gate holds is rejected without
 *  consuming the gate: the legitimate answer can still arrive. Omitting the
 *  hash preserves backwards compatibility (accepted when a gate is pending). */
export function resolvePlanApproval(sessionId: string, decision: ApprovalDecision, planHash?: string): boolean {
  const k = approvalKey(sessionId);
  const pending = pendingApprovals.get(k);
  if (!pending) return false;
  if (pending.planHash !== null && planHash !== undefined && planHash !== pending.planHash) {
    return false;
  }

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
