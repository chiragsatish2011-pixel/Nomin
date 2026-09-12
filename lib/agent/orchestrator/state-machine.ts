// STEPS 0-5: Explicit State Machine for Agent Turn
// Implements the exact sequence: Input â†’ Intent â†’ Plan â†’ Execute â†’ Synthesize â†’ Output

import type {
  NormalInput,
  AgentOutput,
  AgentModel,
  AttachedContext,
  Plan,
  PlanDoc,
  SynthesisDoc,
  ToolTraceEntry,
  Artifact,
  PlanStep,
  VerificationSummary,
  ConversationTurn,
} from "../types";
import type { AgentStreamEvent, LegacyAgentOutput } from "../protocol";

type PlanStepState = PlanStep["state"];

import { classifyIntent, isDefinitelyTask } from "../intent/classifier";
import { generatePlanDoc, emitPlan, withStatedAssumption } from "../planner/generator";
import { executeSteps } from "../executor/step-runner";
import { pausedTaskSynthesis, planningFailureSynthesis, answerFailureSynthesis, synthesizeResult, synthesizeDirectAnswer, synthesizePlanOnly } from "../synthesis/generator";
import { buildFinalOutput } from "../output/builder";
import { normalizeInput } from "../input";
import { getOrCreateSession, appendTurn, getPendingExecution, getSessionCount, getTaskState, hydrateHistoryIfEmpty, rehydratePendingExecution, serverUptimeS, setPendingExecution, setTaskState } from "../session-store";
import {
  applyPlan,
  applyTrace,
  emptyTaskState,
  recordOpenQuestion,
  recordRefinement,
  renderTaskState,
  dismissOpenQuestions,
  resumePlan,
  resolveOpenQuestions,
  type TaskState,
} from "../task-state";
import { awaitPlanApproval, hashPlan } from "../execution/bridge";
import { toPendingExecution, type ClientCheckpoint } from "../resume-checkpoint";
import { planNeedsApproval } from "../approval";
import { sanitize as sanitizeError } from "../sanitize";
import { buildClarificationOutput, toClarificationQuestion } from "../clarification";
import { clarificationContextFor } from "../clarification-context";
import { directFastReply } from "../direct-fast-path";
import { evaluateVerification } from "../verification";
import { reviewCodingCompletion, shouldRunCodingReview } from "../quality-chain";
import { perf } from "../perf";
import { withLedgerSession } from "../token-ledger";
import { withTurnSignal } from "../turn-control";
import { completeProgress, pausedProgress, planProgress } from "../progress-updates";
import type { ByokProviderConfig } from "@/lib/nim/byok-context";

const TIMING_ENABLED = process.env.TRION_PERF === "1";

function timingLog(label: string, startTime: number, meta?: Record<string, unknown>) {
  if (!TIMING_ENABLED) return;
  const elapsed = Date.now() - startTime;
  perf(`timing.${label}`, elapsed, meta);
}

interface ExecutionContext {
  input: NormalInput;
  plan: PlanDoc | null;
  toolTrace: ToolTraceEntry[];
  artifacts: Artifact[];
  /** Real per-step outcome. Without it every step in the final output was
   *  reported "done", including ones that errored or never ran. */
  stepStates: Map<number, PlanStepState> | null;
  error: Error | null;
  sessionId: string;
}

/** The validated route request travels intact through every orchestration
 * stage. Keeping this shape in one place prevents history/BYOK context options
 * being silently dropped between the API boundary and normalizeInput. */
type TurnRequest = {
  sessionId: string;
  userText: string;
  mode: "plan" | "execute";
  model: AgentModel;
  workspacePath: string;
  snapshot?: string[];
  attachments?: AttachedContext[];
  history?: ConversationTurn[];
  resume?: boolean;
  /** Client-persisted resume checkpoint for server-map misses. See input.ts. */
  checkpoint?: ClientCheckpoint | null;
  byok?: ByokProviderConfig;
};

// NOTE: the legacy `trace` event is no longer emitted. It duplicated the
// status/plan_update/tool_result stream the UI already renders, and the client
// drove a SECOND execution panel from it — so a running turn showed "Live
// execution" twice, with the two panels disagreeing about progress.

// Helper to emit legacy output event
function emitOutput(emit: (event: AgentStreamEvent) => void, output: AgentOutput) {
  // Convert to legacy format
  const legacyOutput = convertToLegacyOutput(output);
  emit({ type: "output", output: legacyOutput });
}

/**
 * A build with no successful post-change check is not complete. Add one small,
 * resumable verification-only step rather than discarding a finished workspace
 * or asking the model to plan everything again. The execution decision still
 * chooses the project-appropriate command from the live workspace.
 */
export function prepareVerificationContinuation(plan: PlanDoc, taskState: TaskState): PlanDoc {
  const existing = plan.steps.find((step) => step.description === "Verify the finished project" && step.tool === "run_command");
  const continued = existing
    ? plan
    : {
        ...plan,
        steps: [
          ...plan.steps,
          {
            step_id: Math.max(0, ...plan.steps.map((step) => step.step_id)) + 1,
            description: "Verify the finished project",
            tool: "run_command",
          },
        ],
      };
  resumePlan(taskState, continued);
  const verificationStep = taskState.steps.find((step) => step.description === "Verify the finished project" && step.tool === "run_command");
  if (verificationStep) {
    verificationStep.state = "pending";
    verificationStep.lastError = undefined;
  }
  return continued;
}

function stepStatesFromTaskState(plan: PlanDoc, taskState: TaskState): Map<number, PlanStepState> {
  return new Map(plan.steps.map((step) => [
    step.step_id,
    taskState.steps.find((entry) => entry.id === step.step_id)?.state ?? "pending",
  ]));
}

async function pauseForVerification(
  ctx: ExecutionContext,
  taskState: TaskState,
  verification: VerificationSummary,
  originalUserText: string,
  emit: (event: AgentStreamEvent) => void
): Promise<AgentOutput> {
  if (!ctx.plan) throw new Error("Cannot create a verification checkpoint without a plan.");
  ctx.plan = prepareVerificationContinuation(ctx.plan, taskState);
  ctx.stepStates = stepStatesFromTaskState(ctx.plan, taskState);
  setTaskState(ctx.sessionId, taskState);
  setPendingExecution(ctx.sessionId, {
    plan: ctx.plan,
    originalUserText,
    toolTrace: ctx.toolTrace,
    artifacts: ctx.artifacts,
  });

  const error = new Error("Final verification did not complete successfully.");
  emit({ type: "progress", stage: "paused", message: pausedProgress(ctx.plan, ctx.toolTrace) });
  emit({ type: "status", status: "synthesizing" });
  const synthesis = await synthesizeResult(ctx.input, ctx.toolTrace, ctx.plan, error, renderTaskState(taskState), verification);
  const output = buildFinalOutput(synthesis, ctx.plan, ctx.toolTrace, ctx.artifacts, "error", ctx.stepStates, verification);
  appendTurn(ctx.sessionId, { role: "assistant", content: synthesis.message });
  emit({ type: "status", status: "error" });
  emitOutput(emit, output);
  emit({ type: "result", data: output });
  return output;
}

/**
 * A missing verification command is a gap in the plan, not a reason to hand
 * control back to the user.  Older turns appended this step and immediately
 * paused, which made every otherwise successful build require a manual Retry
 * before the check could even start.  Run the one added, deterministic step in
 * the same turn.  We only pause when that *actual* command cannot complete.
 */
async function runMissingVerification(
  ctx: ExecutionContext,
  taskState: TaskState,
  emit: (event: AgentStreamEvent) => void,
  signal?: AbortSignal
): Promise<{ failure?: { stepId: number; error: string } }> {
  if (!ctx.plan) throw new Error("Cannot run verification without a plan.");

  ctx.plan = prepareVerificationContinuation(ctx.plan, taskState);
  setTaskState(ctx.sessionId, taskState);
  // The added step must be visible in the existing calm progress view, but it
  // is not a new plan or a new approval request.
  emitPlan(ctx.plan, emit);
  emit({ type: "progress", stage: "plan", message: planProgress(ctx.plan) });
  emit({ type: "status", status: "executing" });

  const continuation = await executeSteps(ctx.plan, ctx.input, emit, ctx.sessionId, taskState, signal, (checkpoint) => {
    setPendingExecution(ctx.sessionId, {
      plan: ctx.plan!,
      originalUserText: ctx.input.user_message,
      ...checkpoint,
    });
  });
  ctx.toolTrace.push(...continuation.toolTrace);
  ctx.artifacts.push(...continuation.artifacts);
  ctx.stepStates = continuation.stepStates;
  applyTrace(taskState, continuation.toolTrace);
  setTaskState(ctx.sessionId, taskState);
  for (const turn of continuation.history) appendTurn(ctx.sessionId, turn);
  throwIfTurnCancelled(signal);
  return { failure: continuation.failure };
}

// NOTE: a turn emits exactly ONE `result` event, carrying the AgentOutput.
// It used to emit two — a legacy AgentResult first, then the AgentOutput — and
// the client ran its end-of-turn work on both, which double-incremented the turn
// counter and tore the sandbox down twice.

function convertToLegacyOutput(output: AgentOutput): LegacyAgentOutput {
  // Simple conversion - in reality this might be more complex
  if (output.status === "error") {
    const allowanceExhausted = /included building allowance/i.test(output.message);
    return {
      type: "error",
      code: allowanceExhausted ? "building_allowance_exhausted" : "agent_error",
      message: output.message,
      retryable: !allowanceExhausted,
    };
  }
  // For non-error, emit as chat_reply
  return {
    type: "chat_reply" as const,
    content: output.message,
  };
}

export async function runTurn(
  request: TurnRequest,
  emit: (event: AgentStreamEvent) => void,
  t0: number = Date.now(),
  signal?: AbortSignal
): Promise<AgentOutput> {
  // Every model call this turn makes lands in this session's token ledger,
  // whichever stage spends it. Measurement only — see token-ledger.ts.
  //
  // `withTurnSignal` is the counterpart that is NOT measurement: it makes the
  // turn's cancellation ambient, so Stop reaches every model call this turn
  // issues — classification, planning, execution decisions, synthesis and the
  // review roles alike — instead of only the handful that were passed a signal
  // by hand. See turn-control.ts.
  return withTurnSignal(signal, () =>
    withLedgerSession(request.sessionId, () => runTurnInner(request, emit, t0, signal))
  );
}

async function runTurnInner(
  request: TurnRequest,
  emit: (event: AgentStreamEvent) => void,
  t0: number,
  signal?: AbortSignal
): Promise<AgentOutput> {
  const ctx: ExecutionContext = {
    input: null!,
    plan: null,
    toolTrace: [],
    artifacts: [],
    stepStates: null,
    error: null,
    sessionId: request.sessionId,
  };

  try {
    throwIfTurnCancelled(signal);
    // STEP 0: Input Construction
    emit({ type: "status", status: "thinking" });
    timingLog("T1_step0_start", t0);
    
    const session = getOrCreateSession(request.sessionId, request.mode, request.model, request.workspacePath);
    hydrateHistoryIfEmpty(request.sessionId, request.history);
    const step0Start = Date.now();
    ctx.input = await normalizeInput(
      {
        sessionId: request.sessionId,
        userText: request.userText,
        mode: request.mode,
        model: request.model,
        workspacePath: request.workspacePath,
        snapshot: request.snapshot,
        history: request.history,
        byok: request.byok,
      },
      session,
      request.attachments
    );
    throwIfTurnCancelled(signal);
    timingLog("T1_step0_normalizeInput_done", t0, { files: ctx.input.workspace_snapshot.file_tree.length, historyTurns: ctx.input.conversation_history.length });
    perf("step0.normalizeInput", Date.now() - step0Start, {
      files: ctx.input.workspace_snapshot.file_tree.length,
      historyTurns: ctx.input.conversation_history.length,
      historyTokens: estTokensOfHistory(ctx.input.conversation_history),
    });

    // Retry is a continuation command, never another natural-language turn.
    // Reuse the exact plan the user already approved and the durable step
    // ledger, so a quota pause costs no second classification or planning call.
    let pendingExecution = request.resume ? getPendingExecution(ctx.sessionId) : null;
    if (!pendingExecution && request.resume) {
      // Server-map miss. The map is process-local: a restart, redeploy, or
      // cold start wipes it while the browser still holds the thread. Log the
      // miss with enough detail to distinguish that from TTL eviction (30d)
      // or a regenerated key (the client keeps one id per thread).
      const miss = { session: ctx.sessionId, storeSize: getSessionCount(), uptimeS: serverUptimeS() };
      perf("checkpoint.miss", 0, miss);
      console.warn(`[trion] checkpoint.miss session=${ctx.sessionId} storeSize=${miss.storeSize} uptimeS=${miss.uptimeS}`);
      if (request.checkpoint) {
        // The browser is the source of truth: it persisted the last turn's
        // plan and evidence from its result event. Rehydrate the cache and
        // resume as if the process had never died. Retry is an explicit user
        // action on a plan it already saw, so no second approval is needed.
        const rehydrated = toPendingExecution(request.checkpoint, request.userText);
        pendingExecution = rehydrated;
        rehydratePendingExecution(ctx.sessionId, rehydrated);
        emit({ type: "progress", stage: "notice", message: "Workspace checkpoint was restored from this browser — continuing where the last run paused." });
      }
    }
    if (pendingExecution) {
      return resumeApprovedExecution(ctx, pendingExecution, emit, t0, signal);
    }
    if (request.resume) {
      // Genuinely unrecoverable (abandoned thread, corrupt or absent client
      // state). Restart planning from the last message instead of dead-ending:
      // a fresh turn is strictly more useful than a stop sign.
      emit({ type: "progress", stage: "notice", message: "Continuing from your last message — prior progress couldn't be restored." });
    }

    // Persist user message to session history
    appendTurn(ctx.sessionId, { role: "user", content: request.userText });

    // A deterministic local reply is both more correct and dramatically
    // cheaper than asking a provider to classify and restate "2 + 2". Keep
    // this ahead of task-state/planning, but intentionally narrow so every
    // non-trivial or context-dependent turn keeps the full agent contract.
    const immediateReply = directFastReply(ctx.input.user_message);
    if (immediateReply) {
      // A deterministic social/identity reply is an explicit context switch,
      // not an answer to an earlier build question. Clear the unresolved branch
      // so the next real request starts from what the user actually says.
      const priorTaskState = getTaskState(ctx.sessionId);
      if (priorTaskState?.openQuestions.length) {
        dismissOpenQuestions(priorTaskState);
        setTaskState(ctx.sessionId, priorTaskState);
      }
      const output = buildFinalOutput(
        { message: immediateReply, next_action_hint: "Ask me anything you'd like to explore or build." },
        null,
        [],
        [],
        "done"
      );
      appendTurn(ctx.sessionId, { role: "assistant", content: immediateReply });
      emitOutput(emit, output);
      emit({ type: "result", data: output });
      return output;
    }

    // Structured working memory for this task — created on the first turn,
    // advanced on every one after. Fed to the execution, synthesis and
    // direct-answer calls so none of them has to reconstruct the goal or the
    // decisions taken from a sliding transcript window.
    const taskState = advanceTaskState(ctx.sessionId, request.userText);
    // A fresh user instruction supersedes any older paused plan. Only the
    // explicit retry path above is allowed to continue it.
    setPendingExecution(ctx.sessionId, null);

    // STEP 1: Intent Classification (always trion-1.4)
    //
    // When the request is unambiguously imperative ("create a file…", "can you
    // build…"), the classifier's own override forces "task" whatever the model
    // returns — so planning can start NOW, concurrently, instead of after a
    // full classification round trip. On those turns this removes an entire
    // sequential model call from the critical path; on every other turn nothing
    // speculative is started, so nothing is wasted.
    const speculativePlan = isDefinitelyTask(ctx.input)
      ? generatePlanDoc(ctx.input).then(
          (plan) => ({ ok: true as const, plan }),
          (error: unknown) => ({ ok: false as const, error }),
        )
      : null;

    timingLog("T2_classification_start", t0);
    const step1Start = Date.now();
    const intent = await classifyIntent(ctx.input);
    throwIfTurnCancelled(signal);
    timingLog("T3_classification_done", t0, { intent: intent.intent });
    perf("step1.intent", Date.now() - step1Start, { intent: intent.intent });
    
    if (intent.intent === "direct_answer") {
      // Short-circuit: skip to synthesis â€” do NOT emit status events that
      // would create trace nodes (no "thinking", "synthesizing" etc.).
      // Direct answers have no execution trace.
      timingLog("T4_direct_answer_synthesis_start", t0);
      // Drop the workspace snapshot (a conversational reply needs no file tree),
      // but KEEP conversation_history. Zeroing it here was the single largest
      // source of "the agent forgot what we were just talking about": every
      // conversational turn was answered statelessly, so a follow-up like
      // "what did I just ask you?" had nothing to work from. The shared context
      // assembler decides how much of it to send.
      const conversationalInput: NormalInput = {
        session_id: ctx.input.session_id,
        workspace_path: ctx.input.workspace_path,
        mode: ctx.input.mode,
        model: ctx.input.model,
        user_message: ctx.input.user_message,
        conversation_history: ctx.input.conversation_history,
        attached_context: ctx.input.attached_context,
        workspace_snapshot: { file_tree: [], open_files: [] },
      };
      // The task state goes in too. A conversational turn in the middle of a
      // long build is very often a RECALL question ("what did I ask you to
      // build?", "which files have you changed?"), and answering that from a
      // six-turn transcript window is exactly the memory failure this replaces.
      let synthesis;
      try {
        synthesis = await synthesizeDirectAnswer(conversationalInput, renderTaskState(taskState));
      } catch (synthesisError) {
        // Cancellation must keep propagating to the outer handler — answering
        // a stopped turn deterministically would resurrect it as a result.
        if (synthesisError instanceof TurnCancelledError || signal?.aborted) throw synthesisError;
        // A reply that cannot be composed is NOT a planning failure: no plan
        // was ever attempted, so the "build plan" recovery copy would lie
        // about the stage. Answer deterministically from the failure class —
        // the model is what just failed, so no second model call is attempted.
        const failure = answerFailureSynthesis(synthesisError instanceof Error ? synthesisError : new Error(String(synthesisError)));
        timingLog("T4_direct_answer_failed", t0);
        const output = buildFinalOutput(failure, null, [], [], "error");
        appendTurn(ctx.sessionId, { role: "assistant", content: failure.message });
        emitOutput(emit, output);
        emit({ type: "result", data: output });
        return output;
      }
      throwIfTurnCancelled(signal);
      timingLog("T4_direct_answer_synthesis_done", t0);
      const output = buildFinalOutput(synthesis, null, [], [], "done");
      
      // Persist assistant response to session history
      appendTurn(ctx.sessionId, { role: "assistant", content: synthesis.message });
      
      // Emit legacy events for UI compatibility
      emitOutput(emit, output);
      
      // Emit new format result
      emit({ type: "result", data: output });
      return output;
    }

    // Handle needs_clarification: respond with the clarifying question directly
    // The model's classification response already contains the clarifying question in intent.reason
    if (intent.intent === "needs_clarification") {
      timingLog("T4_clarification_response_start", t0);
      // Use the clarifying question from the model's classification response directly
      // Validate that it looks like a question, otherwise use a default
      const clarificationQuestion = toClarificationQuestion(
        intent.reason,
        ctx.input.user_message,
        clarificationContextFor(ctx.input),
      );
      recordOpenQuestion(taskState, clarificationQuestion);
      setTaskState(ctx.sessionId, taskState);
      const output = buildClarificationOutput(clarificationQuestion);
      timingLog("T4_clarification_response_done", t0);

      // Persist as a CLARIFYING turn so the next turn's classifier can see the
      // question this user is about to answer (and the trimmer never drops it).
      appendTurn(ctx.sessionId, { role: "assistant", content: clarificationQuestion, clarifying: true, unresolved: true });

      // Emit legacy events for UI compatibility
      emitOutput(emit, output);

      // Emit new format result
      emit({ type: "result", data: output });
      return output;
    }

    // Only for task turns: surface the AI-chosen activity
    emit({ type: "status", status: intent.activity });

    // STEP 2: Plan Generation (user's tier) + Stream Plan
    emit({ type: "status", status: "planning" });
    timingLog("T2_plan_start", t0);
    
    const step2Start = Date.now();
    // Take the speculative plan when it succeeded; otherwise plan now.
    let generatedPlan: PlanDoc;
    if (speculativePlan) {
      const speculative = await speculativePlan;
      if (!speculative.ok) throw speculative.error;
      generatedPlan = speculative.plan;
    } else {
      generatedPlan = await generatePlanDoc(ctx.input);
    }
    ctx.plan = withStatedAssumption(generatedPlan, intent.assumption);
    throwIfTurnCancelled(signal);
    applyPlan(taskState, ctx.plan);
    setTaskState(ctx.sessionId, taskState);
    emitPlan(ctx.plan, emit);
    emit({ type: "progress", stage: "plan", message: planProgress(ctx.plan) });
    timingLog("T2_plan_done", t0, { steps: ctx.plan.steps.length, speculative: Boolean(speculativePlan) });
    perf("step2.plan", Date.now() - step2Start, { steps: ctx.plan.steps.length, speculative: Boolean(speculativePlan) });


    // PLAN MODE: skip execution â€” but NEVER silently. The plan_skipped event
    // tells the UI to render "plan mode â€” no execution", so a plan-only turn
    // can never be mistaken for a broken turn. (Root cause of the earlier
    // "plan generated but never executed" bug: this branch ran by default
    // because the UI defaulted to plan mode and quick modes never changed it â€”
    // the skip itself was invisible.)
    if (request.mode === "plan") {
      emit({ type: "plan_skipped", reason: "plan_mode" });
      emit({ type: "status", status: "synthesizing" });
      timingLog("T4_plan_synthesis_start", t0);
      const planOnlySynthesis = await synthesizePlanOnly(ctx.input, ctx.plan);
      throwIfTurnCancelled(signal);
      timingLog("T4_plan_synthesis_done", t0);
      // Steps are "pending", not "done": in Think mode nothing ran, and marking
      // them done put a full row of green checks under a plan that was never
      // executed.
      const planOnlyStates = new Map<number, PlanStepState>(ctx.plan.steps.map((s) => [s.step_id, "pending" as const]));
      const planOutput = buildFinalOutput(planOnlySynthesis, ctx.plan, [], [], "done", planOnlyStates);
      appendTurn(ctx.sessionId, { role: "assistant", content: planOnlySynthesis.message });
      emitOutput(emit, planOutput);
      emit({ type: "result", data: planOutput });
      return planOutput;
    }

    // STEP 2.5: Plan Approval Gate â€” a HARD pause between plan and execution.
    // Step 3 does NOT start until the client posts a decision to
    // /api/trion/approval. The pending gate lives in the execution bridge
    // (same mechanism family as the WebContainer tool bridge).
    // Only show approval gate if the plan contains steps that require approval.
    // Risk-based, not tool-based. See approval.ts — gating on "contains
    // write_file or run_command" meant gating on "is a task at all", so the
    // confirmation appeared on every single turn and stopped being read.
    const approvalDecision = planNeedsApproval(ctx.plan);

    if (approvalDecision.required) {
      timingLog("T2_approval_start", t0);
      // The gate is bound to THIS plan's bytes: the client echoes planHash
      // with its decision, so a stale approval for an older plan cannot
      // release this gate.
      const planHash = hashPlan(ctx.plan);
      emit({ type: "plan_approval", plan: toPlan(ctx.plan), reason: approvalDecision.reason, planHash });
      const approval = await awaitPlanApproval(request.sessionId, { planHash });
      throwIfTurnCancelled(signal);
      timingLog("T2_approval_done", t0, { approval });
  
      if (approval !== "approve") {
        // User cancelled (or the gate timed out) â€” end the turn cleanly with a
        // "cancelled" status. Not "done", not "error".
        emit({ type: "status", status: "cancelled" });
        const cancelledSynthesis: SynthesisDoc = {
          message:
            "The plan was not approved â€” the turn ended without executing anything. Approve the plan to run it, or adjust your request and send it again.",
          next_action_hint: "Approve the plan, edit your request, or start a new task.",
        };
        const cancelledOutput = buildFinalOutput(cancelledSynthesis, ctx.plan, [], [], "cancelled");
        appendTurn(ctx.sessionId, { role: "assistant", content: cancelledSynthesis.message });
        emitOutput(emit, cancelledOutput);
        emit({ type: "result", data: cancelledOutput });
        return cancelledOutput;
      }
    }

    // STEP 3: Stepwise Execution
    emit({ type: "status", status: "executing" });
    timingLog("T3_execute_start", t0);
    // Create the continuation checkpoint before the first execution decision.
    // Stop can therefore be followed immediately by Continue even when no tool
    // has completed yet; later tool results replace this with richer evidence.
    setPendingExecution(ctx.sessionId, {
      plan: ctx.plan,
      originalUserText: ctx.input.user_message,
      toolTrace: [],
      artifacts: [],
    });
    
    const step3Start = Date.now();
    const { toolTrace, artifacts, history, stepStates, failure } = await executeSteps(
      ctx.plan,
      ctx.input,
      emit,
      ctx.sessionId,
      taskState,
      signal,
      (checkpoint) => setPendingExecution(ctx.sessionId, {
        plan: ctx.plan!,
        originalUserText: ctx.input.user_message,
        ...checkpoint,
      })
    );
    timingLog("T3_execute_done", t0, { toolCalls: toolTrace.length });
    perf("step3.execute", Date.now() - step3Start, { toolCalls: toolTrace.length });
    ctx.toolTrace = toolTrace;
    ctx.artifacts = artifacts;
    ctx.stepStates = stepStates;

    // Fold everything that ran into the durable state before it is used for
    // synthesis or carried into the next turn.
    applyTrace(taskState, toolTrace);
    setTaskState(ctx.sessionId, taskState);
    setPendingExecution(ctx.sessionId, {
      plan: ctx.plan,
      originalUserText: ctx.input.user_message,
      toolTrace: ctx.toolTrace,
      artifacts: ctx.artifacts,
    });
    throwIfTurnCancelled(signal);
    let executionFailure = failure;
    let verification = evaluateVerification(ctx.toolTrace);

    // Persist tool results to session history
    for (const turn of history) {
      appendTurn(ctx.sessionId, turn);
    }

    // A step exhausted its retries. The turn ends as an error, but synthesis
    // still runs over the trace of everything that DID happen, so the user is
    // told what was accomplished before the failure and exactly what broke.
    // A planner can omit the final check even when all code changes succeeded.
    // Add and run it now instead of forcing a user retry solely to execute a
    // step Trion itself just created.
    if (!executionFailure && verification.required && verification.status === "not_run") {
      const continued = await runMissingVerification(ctx, taskState, emit, signal);
      executionFailure = continued.failure;
      verification = evaluateVerification(ctx.toolTrace);
    }

    if (executionFailure) {
      setPendingExecution(ctx.sessionId, {
        plan: ctx.plan,
        originalUserText: ctx.input.user_message,
        toolTrace: ctx.toolTrace,
        artifacts: ctx.artifacts,
      });
      ctx.error = new Error(sanitizeError(`Step ${executionFailure.stepId} could not be completed: ${executionFailure.error}`));
      emit({ type: "progress", stage: "paused", message: pausedProgress(ctx.plan, ctx.toolTrace) });
      emit({ type: "status", status: "synthesizing" });
      const failureSynthesis = await synthesizeResult(ctx.input, ctx.toolTrace, ctx.plan, ctx.error, renderTaskState(taskState), verification);
      throwIfTurnCancelled(signal);
      const failureOutput = buildFinalOutput(failureSynthesis, ctx.plan, ctx.toolTrace, ctx.artifacts, "error", ctx.stepStates, verification);
      appendTurn(ctx.sessionId, { role: "assistant", content: failureSynthesis.message });
      emit({ type: "status", status: "error" });
      emitOutput(emit, failureOutput);
      emit({ type: "result", data: failureOutput });
      return failureOutput;
    }

    if (verification.required && verification.status !== "passed" && verification.status !== "started") {
      return pauseForVerification(ctx, taskState, verification, ctx.input.user_message, emit);
    }


    // STEP 4: Synthesis (always runs, even on error)
    emit({ type: "status", status: "synthesizing" });
    timingLog("T4_synthesis_start", t0);
    const step4Start = Date.now();
    let synthesis = await synthesizeResult(ctx.input, ctx.toolTrace, ctx.plan, ctx.error ?? undefined, renderTaskState(taskState), verification);
    // High-stakes completion review is deliberately narrow: it happens only
    // after a real multi-file coding run with successful verification. Direct
    // answers, plan-only turns, simple edits, and failures never pay for it.
    // The critic is a completeText-only role with no executor or writable tool
    // catalog; it reviews actual trace evidence rather than assumptions.
    if (ctx.plan && shouldRunCodingReview(ctx.input, ctx.plan, ctx.toolTrace, verification)) {
      const reviewed = await reviewCodingCompletion({
        input: ctx.input,
        plan: ctx.plan,
        trace: ctx.toolTrace,
        verification,
        proposed: synthesis,
      });
      synthesis = reviewed.result;
      perf("quality.codingReview", 0, { verdict: reviewed.critic.verdict, findings: reviewed.critic.findings.length });
    }
    throwIfTurnCancelled(signal);
    timingLog("T4_synthesis_done", t0, { traceEntries: ctx.toolTrace.length });
    perf("step4.synthesis", Date.now() - step4Start, { traceEntries: ctx.toolTrace.length });

    // STEP 5: Final Output
    timingLog("T5_output_start", t0);
    const step5Start = Date.now();
    const output = buildFinalOutput(synthesis, ctx.plan, ctx.toolTrace, ctx.artifacts, "done", ctx.stepStates, verification);
    setPendingExecution(ctx.sessionId, null);
    emit({ type: "progress", stage: "complete", message: completeProgress(ctx.plan, ctx.toolTrace) });
    timingLog("T5_output_done", t0);
    perf("step5.output", Date.now() - step5Start);

    // Persist assistant response to session history
    appendTurn(ctx.sessionId, { role: "assistant", content: synthesis.message });

    // Close the pipeline explicitly. Without a terminal status the UI's
    // thinking indicator relied on the result event alone to stop spinning.
    emit({ type: "status", status: "done" });

    // Emit legacy events for UI compatibility
    emitOutput(emit, output);

    // Emit new format result
    emit({ type: "result", data: output });
    return output;

  } catch (err) {
    if (err instanceof TurnCancelledError || signal?.aborted) {
      return finishCancelled(ctx, emit);
    }
    const raw = err instanceof Error ? err : new Error(String(err));
    // Sanitize at the boundary. The raw message can carry the upstream provider
    // name (an HTTP error body quotes the model id verbatim), and every path
    // below puts it in front of the user.
    ctx.error = new Error(sanitizeError(raw.message));
    ctx.error.name = raw.name;
    timingLog("T_error_caught", t0, { error: ctx.error.message.slice(0, 100) });

    emit({ type: "status", status: "error" });

    // Still run synthesis for error case
    try {
      // Synthesis needs an input. When the failure happened in STEP 0 there
      // isn't one, and calling through with `null` threw a second time.
      if (!ctx.input) throw ctx.error;
      timingLog("T4_error_synthesis_start", t0);
      const synthesis = ctx.plan
        ? await synthesizeResult(ctx.input, ctx.toolTrace, ctx.plan, ctx.error ?? undefined)
        : planningFailureSynthesis(ctx.error);
      timingLog("T4_error_synthesis_done", t0);
      const output = buildFinalOutput(synthesis, ctx.plan, ctx.toolTrace, ctx.artifacts, "error", ctx.stepStates);

      // Persist assistant response to session history
      appendTurn(ctx.sessionId, { role: "assistant", content: synthesis.message });
      
      // Emit legacy events for UI compatibility
      emitOutput(emit, output);
      
      // Emit new format result
      emit({ type: "result", data: output });
      return output;
    } catch {
      // Fallback error output if synthesis fails
      const fallbackSynthesis = ctx.plan
        ? pausedTaskSynthesis(ctx.toolTrace, ctx.error)
        : planningFailureSynthesis(ctx.error);
      const fallbackOutput: AgentOutput = {
        message: fallbackSynthesis.message,
        status: "error",
        plan: ctx.plan ? { summary: ctx.plan.plan_summary, steps: ctx.plan.steps.map(s => ({ step_id: s.step_id, description: s.description, state: "error" as const })) } : null,
        tool_trace: ctx.toolTrace,
        artifacts: ctx.artifacts,
        next_action_hint: fallbackSynthesis.next_action_hint,
      };
      
      appendTurn(ctx.sessionId, { role: "assistant", content: fallbackOutput.message });
      
      emitOutput(emit, fallbackOutput);
      emit({ type: "result", data: fallbackOutput });
      return fallbackOutput;
    }
  }
}

/** Continue an already-approved plan after a transient pause. This deliberately
 * enters at Step 3: classification and planning have already happened, and the
 * durable task ledger tells the executor which steps are complete. */
async function resumeApprovedExecution(
  ctx: ExecutionContext,
  pending: { plan: PlanDoc; originalUserText: string; toolTrace: ToolTraceEntry[]; artifacts: Artifact[] },
  emit: (event: AgentStreamEvent) => void,
  t0: number,
  signal?: AbortSignal
): Promise<AgentOutput> {
  const stored = getTaskState(ctx.sessionId);
  const taskState = stored ?? emptyTaskState(pending.originalUserText);
  ctx.plan = pending.plan;
  ctx.toolTrace = [...pending.toolTrace];
  ctx.artifacts = [...pending.artifacts];
  resumePlan(taskState, ctx.plan);
  if (!stored) {
    // Rehydrated after process death: the durable step ledger died with the
    // old process, so fold the checkpoint's own evidence back in. Steps with
    // a successful trace entry stay done instead of being rebuilt; anything
    // else runs. Evidence-only, never invented.
    applyTrace(taskState, pending.toolTrace);
  }
  setTaskState(ctx.sessionId, taskState);

  // Rehydrate the calm progress view without asking for approval again: the
  // user approved this exact plan before the pause.
  emitPlan(ctx.plan, emit);
  emit({ type: "progress", stage: "plan", message: planProgress(ctx.plan) });
  for (const step of taskState.steps) {
    if (step.state === "done") emit({ type: "plan_update", step_id: step.id, state: "done" });
  }
  emit({ type: "status", status: "executing" });

  const resumed = await executeSteps(ctx.plan, ctx.input, emit, ctx.sessionId, taskState, signal, (checkpoint) => {
    setPendingExecution(ctx.sessionId, {
      plan: ctx.plan!,
      originalUserText: pending.originalUserText,
      toolTrace: [...pending.toolTrace, ...checkpoint.toolTrace],
      artifacts: [...pending.artifacts, ...checkpoint.artifacts],
    });
  });
  ctx.toolTrace.push(...resumed.toolTrace);
  ctx.artifacts.push(...resumed.artifacts);
  ctx.stepStates = resumed.stepStates;
  applyTrace(taskState, resumed.toolTrace);
  setTaskState(ctx.sessionId, taskState);
  throwIfTurnCancelled(signal);

  for (const turn of resumed.history) appendTurn(ctx.sessionId, turn);

  let executionFailure = resumed.failure;
  let verification = evaluateVerification(ctx.toolTrace);
  if (!executionFailure && verification.required && verification.status === "not_run") {
    const continued = await runMissingVerification(ctx, taskState, emit, signal);
    executionFailure = continued.failure;
    verification = evaluateVerification(ctx.toolTrace);
  }
  if (executionFailure) {
    setPendingExecution(ctx.sessionId, {
      plan: ctx.plan,
      originalUserText: pending.originalUserText,
      toolTrace: ctx.toolTrace,
      artifacts: ctx.artifacts,
    });
    const error = new Error(sanitizeError(`Step ${executionFailure.stepId} could not be completed: ${executionFailure.error}`));
    emit({ type: "progress", stage: "paused", message: pausedProgress(ctx.plan, ctx.toolTrace) });
    emit({ type: "status", status: "synthesizing" });
    const synthesis = await synthesizeResult(ctx.input, ctx.toolTrace, ctx.plan, error, renderTaskState(taskState), verification);
    const output = buildFinalOutput(synthesis, ctx.plan, ctx.toolTrace, ctx.artifacts, "error", ctx.stepStates, verification);
    appendTurn(ctx.sessionId, { role: "assistant", content: synthesis.message });
    emit({ type: "status", status: "error" });
    emitOutput(emit, output);
    emit({ type: "result", data: output });
    return output;
  }

  // "started" (dev server live, no build/test proof) is honest final evidence,
  // not a reason to pause: the preview is the deliverable and the message says
  // exactly what was and was not validated.
  if (verification.required && verification.status !== "passed" && verification.status !== "started") {
    return pauseForVerification(ctx, taskState, verification, pending.originalUserText, emit);
  }

  emit({ type: "status", status: "synthesizing" });
  let synthesis = await synthesizeResult(ctx.input, ctx.toolTrace, ctx.plan, undefined, renderTaskState(taskState), verification);
  if (shouldRunCodingReview(ctx.input, ctx.plan, ctx.toolTrace, verification)) {
    synthesis = (await reviewCodingCompletion({ input: ctx.input, plan: ctx.plan, trace: ctx.toolTrace, verification, proposed: synthesis })).result;
  }
  throwIfTurnCancelled(signal);
  const output = buildFinalOutput(synthesis, ctx.plan, ctx.toolTrace, ctx.artifacts, "done", ctx.stepStates, verification);
  setPendingExecution(ctx.sessionId, null);
  emit({ type: "progress", stage: "complete", message: completeProgress(ctx.plan, ctx.toolTrace) });
  appendTurn(ctx.sessionId, { role: "assistant", content: synthesis.message });
  emit({ type: "status", status: "done" });
  emitOutput(emit, output);
  emit({ type: "result", data: output });
  timingLog("T5_resume_output_done", t0);
  return output;
}

/** The HTTP route closes the stream and releases any bridge wait on abort. This
 * guard is the other half: it prevents the already-running agent loop from
 * making a plan, launching a tool, or spending a synthesis call after that
 * cancellation. A provider request already in flight cannot always be revoked,
 * but every subsequent action is stopped. */
class TurnCancelledError extends Error {
  constructor() {
    super("Turn cancelled by the user.");
    this.name = "TurnCancelledError";
  }
}

function throwIfTurnCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TurnCancelledError();
}

function finishCancelled(ctx: ExecutionContext, emit: (event: AgentStreamEvent) => void): AgentOutput {
  const hasWork = ctx.toolTrace.length > 0;
  const output = buildFinalOutput(
    {
      message: hasWork
        ? "Turn cancelled. Any completed workspace changes remain available; unfinished steps were not run."
        : "Turn cancelled before any workspace changes were made.",
      next_action_hint: hasWork ? "Review the completed changes or continue with a new request." : "Send a new request when you are ready.",
    },
    ctx.plan,
    ctx.toolTrace,
    ctx.artifacts,
    "cancelled",
    ctx.stepStates
  );
  appendTurn(ctx.sessionId, { role: "assistant", content: output.message });
  emit({ type: "status", status: "cancelled" });
  emitOutput(emit, output);
  emit({ type: "result", data: output });
  return output;
}

/**
 * Carry the task state into this turn.
 *
 * Three cases, and the distinction matters for what the agent remembers:
 *  - no state yet: this message IS the goal.
 *  - a question is outstanding: this message ANSWERS it. The answer is promoted
 *    to a decision, because it is the most load-bearing thing the user said and
 *    it has to outlive the question that prompted it.
 *  - otherwise: a refinement of the goal in flight. The original goal is kept —
 *    "make the accent green" is not a new task, and treating it as one is
 *    precisely how a long session loses the plot.
 *
 * The workspace facts (files touched, commands run) survive all three, because
 * they are true of the workspace regardless of which instruction produced them.
 */
function advanceTaskState(sessionId: string, userMessage: string): TaskState {
  const existing = getTaskState(sessionId);
  if (!existing) {
    const fresh = emptyTaskState(userMessage);
    fresh.turnCount = 1;
    setTaskState(sessionId, fresh);
    return fresh;
  }

  if (existing.openQuestions.length > 0) resolveOpenQuestions(existing, userMessage);
  else recordRefinement(existing, userMessage);

  existing.turnCount += 1;
  setTaskState(sessionId, existing);
  return existing;
}

function estTokensOfHistory(history: Array<{ role: string; content: string }>): number {
  let total = 0;
  for (const turn of history) total += Math.ceil(turn.content.length / 4);
  return total;
}

/** Shape a PlanDoc into the public Plan contract (used by the approval gate â€”
 *  steps are pending because nothing has run yet). */
function toPlan(planDoc: PlanDoc): Plan {
  return {
    summary: planDoc.plan_summary,
    steps: planDoc.steps.map((s) => ({
      step_id: s.step_id,
      description: s.description,
      state: "pending" as const,
      tool: s.tool,
    })),
  };
}

// Approval is decided by planNeedsApproval() in ../approval.ts, on the RISK a
// plan carries rather than on which tools it happens to use.
