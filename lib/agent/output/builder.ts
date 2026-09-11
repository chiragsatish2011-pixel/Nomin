// STEP 5: Final Output Contract Validation
// Builds and validates the single AgentOutput object

import type { AgentOutput, SynthesisDoc, PlanDoc, ToolTraceEntry, Artifact, Plan, VerificationSummary } from "../types";
import { sanitize, sanitizeArtifact, assertNoLeaksInOutput } from "../sanitize";

export function buildFinalOutput(
  synthesis: SynthesisDoc,
  plan: PlanDoc | null,
  toolTrace: ToolTraceEntry[],
  artifacts: Artifact[],
  status: "done" | "error" | "cancelled" | "needs_clarification",
  /** Real outcome per step, from the executor. Omitted for turns that never
   *  reached execution (plan mode, cancelled at the gate). */
  stepStates?: Map<number, Plan["steps"][number]["state"]> | null,
  verification?: VerificationSummary | null
): AgentOutput {
  // Provider routing is an internal audit detail. Keep it available to the
  // server-side synthesis/checkpoint pipeline, but remove it before the public
  // AgentOutput is serialized to the browser.
  const publicToolTrace = toolTrace.map((entry) => {
    const publicEntry = { ...entry };
    delete publicEntry.path_used;
    return publicEntry;
  });
  const output: AgentOutput = {
    message: sanitize(synthesis.message),
    status,
    plan: plan ? toPlan(plan, status, stepStates) : null,
    tool_trace: publicToolTrace, // Already sanitized in step-runner
    artifacts: artifacts.map(sanitizeArtifact),
    verification: verification ?? null,
    next_action_hint: synthesis.next_action_hint ? sanitize(synthesis.next_action_hint) : null,
  };

  // Validate against contract
  validateAgentOutput(output);

  // Final leak check on model-authored prose. Code bodies (write_file trace
  // inputs, artifact contents) are exempt by design — see assertNoLeaksInOutput.
  assertNoLeaksInOutput(output);

  return output;
}

/** The plan shown after the turn must describe what ACTUALLY happened.
 *  Reporting every step "done" whenever the turn was not cancelled meant a
 *  failed step, and every step the model skipped by finishing early, were
 *  rendered with a green check the user could see was wrong. */
function toPlan(
  planDoc: PlanDoc,
  status: "done" | "error" | "cancelled" | "needs_clarification",
  stepStates?: Map<number, Plan["steps"][number]["state"]> | null
): Plan {
  const fallback = (): Plan["steps"][number]["state"] => {
    if (status === "cancelled") return "cancelled";
    if (status === "error") return "error";
    if (status === "needs_clarification") return "pending";
    return "done";
  };

  return {
    summary: planDoc.plan_summary,
    steps: planDoc.steps.map((s) => ({
      step_id: s.step_id,
      description: s.description,
      // A step still marked "running" when the turn ended never reported back;
      // that is a cancellation, not a success.
      state: normalizeState(stepStates?.get(s.step_id)) ?? fallback(),
    })),
  };
}

function normalizeState(state: Plan["steps"][number]["state"] | undefined): Plan["steps"][number]["state"] | null {
  if (!state) return null;
  if (state === "running") return "cancelled";
  return state;
}

function validateAgentOutput(output: AgentOutput): void {
  // status must be "done", "error", "cancelled" or "needs_clarification"
  if (output.status !== "done" && output.status !== "error" && output.status !== "cancelled" && output.status !== "needs_clarification") {
    throw new Error(`Invalid status: ${output.status}. Must be "done", "error", "cancelled" or "needs_clarification"`);
  }

  // message must be string
  if (typeof output.message !== "string") {
    throw new Error("message must be a string");
  }

  // plan must be null or valid Plan
  if (output.plan !== null) {
    if (typeof output.plan.summary !== "string") {
      throw new Error("plan.summary must be string");
    }
    if (!Array.isArray(output.plan.steps)) {
      throw new Error("plan.steps must be array");
    }
    for (const step of output.plan.steps) {
      if (typeof step.step_id !== "number" || typeof step.description !== "string") {
        throw new Error("Invalid plan step structure");
      }
      if (step.state !== "pending" && step.state !== "running" && step.state !== "done" && step.state !== "error" && step.state !== "cancelled") {
        throw new Error(`Invalid step state: ${step.state}`);
      }
    }
  }

  // tool_trace must be array (always present)
  if (!Array.isArray(output.tool_trace)) {
    throw new Error("tool_trace must be array");
  }
  for (const entry of output.tool_trace) {
    if (typeof entry.step_id !== "number" ||
        typeof entry.tool_name !== "string" ||
        typeof entry.output !== "string" ||
        (entry.status !== "success" && entry.status !== "error") ||
        typeof entry.attempt !== "number") {
      throw new Error("Invalid tool_trace entry structure");
    }
  }

  // artifacts must be array (always present)
  if (!Array.isArray(output.artifacts)) {
    throw new Error("artifacts must be array");
  }
  for (const artifact of output.artifacts) {
    if (artifact.type !== "code_diff" && artifact.type !== "file" && artifact.type !== "preview") {
      throw new Error(`Invalid artifact type: ${artifact.type}`);
    }
    if (typeof artifact.content !== "string") {
      throw new Error("artifact.content must be string");
    }
  }

  if (output.verification !== undefined && output.verification !== null) {
    if (!output.verification.message || !["not_needed", "passed", "started", "not_run", "failed"].includes(output.verification.status)) {
      throw new Error("Invalid verification evidence");
    }
  }

  // next_action_hint must be string or null
  if (output.next_action_hint !== null && typeof output.next_action_hint !== "string") {
    throw new Error("next_action_hint must be string or null");
  }
}
