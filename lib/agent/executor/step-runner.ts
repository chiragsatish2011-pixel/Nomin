// STEP 3: Stepwise Execution with Retries and Model Decision Checkpoint
// Each step executes with max 2 retries. After EVERY result, model decides next action.

import type { NormalInput, PlanDoc, PlanStep, ToolTraceEntry, Artifact, StreamEvent, AgentTurn, ConversationTurn } from "../types";
import { modelGateway } from "../model-gateway";
import { tierForRole } from "../model-tiers";
import { runTool } from "../tool-runner";
import { sanitizeTraceEntry } from "../sanitize";
import { perf } from "../perf";
import type { NimMessage } from "../types";
import { executePromptFor, RAW_FILE_AUTHOR_SYSTEM_PROMPT } from "../static-prompts";
import { buildContextWindow, contextWindowToMessages, CONTEXT_PRESETS, RENDER_PRESETS } from "../context";
import { applyTrace, pendingSteps, renderHandoffCheckpoint, type TaskState } from "../task-state";
import { canUseFastTier, decideThinking } from "../thinking";
import { checkCoherence, knownFilesFromTrace } from "./coherence";
import { frameUntrustedContent } from "../untrusted-content";
import { EXHAUSTIVE_STEP_DISCIPLINE, exhaustiveBuildTestEnabled, isInterfaceBuildRequest } from "../exhaustive-build-test";
import { proposeDesignRevision, runDesignCritic, shouldRunDesignReview } from "../quality-chain";

const MAX_RETRIES = 2;

/** Self-corrections allowed per step before the loop stops second-guessing the
 *  model. One is enough to catch the real defect (a premature finish) and low
 *  enough that a wrong correction cannot cost more than a single round trip. */
const MAX_COHERENCE_CORRECTIONS = 1;

export class StepFailedError extends Error {
  constructor(
    public readonly stepId: number,
    public readonly lastError: string | undefined
  ) {
    super(`Step ${stepId} failed after ${MAX_RETRIES + 1} attempts: ${lastError}`);
    this.name = "StepFailedError";
  }
}

export type ExecutionOutcome = {
  toolTrace: ToolTraceEntry[];
  artifacts: Artifact[];
  history: ConversationTurn[];
  /** Final state of every planned step, for the output contract. */
  stepStates: Map<number, PlanStep["state"]>;
  /** Set when a step exhausted its retries. The turn ends as an error, but the
   *  trace collected up to that point is still returned — throwing discarded it
   *  and the user got "something failed" with no record of what ran. */
  failure?: { stepId: number; error: string };
};

export async function executeSteps(
  plan: PlanDoc,
  input: NormalInput,
  emit: (event: StreamEvent) => void,
  sessionId: string,
  /** Structured working memory for this task. Updated in place as steps resolve,
   *  and fed to every decision call instead of making the model re-derive the
   *  same facts from transcript. */
  taskState: TaskState,
  signal?: AbortSignal,
  onCheckpoint?: (checkpoint: { toolTrace: ToolTraceEntry[]; artifacts: Artifact[] }) => void
): Promise<ExecutionOutcome> {
  const toolTrace: ToolTraceEntry[] = [];
  const artifacts: Artifact[] = [];
  const history: ConversationTurn[] = [
    ...input.conversation_history,
  ];
  // `history` is the in-turn context used by later decisions.  Only the rows
  // created during this execution belong back in the durable session. Returning
  // the seeded transcript used to append every old user/assistant turn again
  // after each tool run, which quietly multiplied context and rate pressure.
  const newHistory: ConversationTurn[] = [];
  const remember = (turn: ConversationTurn) => {
    history.push(turn);
    newHistory.push(turn);
  };
  const checkpoint = () => onCheckpoint?.({ toolTrace: [...toolTrace], artifacts: [...artifacts] });
  // REMOVED: a "the first execution path was unavailable, continuing with the
  // next available path" progress notice. With a single credential and a single
  // provider there is no second path to continue to, so that sentence could
  // only ever have been false. A genuine failure now surfaces as a real error
  // instead of a reassuring message about a fallback that does not exist.
  const throwIfCancelled = () => {
    if (!signal?.aborted) return;
    checkpoint();
    const error = new Error("Turn cancelled by the user.");
    error.name = "AbortError";
    throw error;
  };
  const stepStates = new Map<number, PlanStep["state"]>(plan.steps.map((step) => {
    const prior = taskState.steps.find((entry) => entry.id === step.step_id);
    return [step.step_id, prior?.state === "done" ? "done" as const : "pending" as const];
  }));

  for (const step of plan.steps) {
    throwIfCancelled();
    // A resumed execution carries the approved plan and durable step ledger.
    // Never recreate a file or re-run a passed command merely because the
    // earlier turn was paused by a provider quota.
    if (stepStates.get(step.step_id) === "done") continue;
    // Update step state to running
    emit({ type: "plan_update", step_id: step.step_id, state: "running" });
    stepStates.set(step.step_id, "running");

    let attempt = 0;
    let success = false;
    let finished = false;
    let lastError: string | undefined;
    let corrections = 0;
    let correction: string | undefined;
    let providerPath: ToolTraceEntry["path_used"] = "deterministic";

    while (attempt <= MAX_RETRIES && !success) {
      throwIfCancelled();
      attempt++;

      const isRetry = attempt > 1;

      // THINK BEFORE ACTING — but only where the decision is genuinely open.
      // A correction always thinks: we have just told the model it was wrong,
      // and re-deciding without reasoning reproduces the same answer.
      const gate = decideThinking(step, { isRetry, state: taskState });
      // Full-file authoring already requires a complete structured tool payload.
      // Letting the provider emit hidden reasoning BEFORE that payload was the
      // main source of long stalls with no file ever reaching the workspace.
      // Use a direct first pass for every fresh write; schema/coherence/tool
      // failure automatically escalates the next bounded pass to reasoning.
      const quickAuthoringPass = step.tool === "write_file" && !isRetry && !correction;
      const thinking = (gate.think || Boolean(correction)) && !quickAuthoringPass;

      // Build messages for model to decide tool call
      const messages = buildExecuteMessages(
        input,
        step,
        history,
        taskState,
        isRetry,
        lastError,
        correction,
        quickAuthoringPass
      );

      // Model decides the tool call. Right-sizing: a fully determined step that
      // is not authoring file content only has to emit a path, a query or a
      // command, and the cheap tier does that as well as the large one.
      const decisionStart = Date.now();
      // A write decision emits an entire source file and deliberately has
      // thinking enabled. It is not comparable to choosing a known path for a
      // read. Give it one realistic, bounded opportunity to complete instead
      // of timing out at 30s and paying for a duplicate generation. Other
      // execution decisions retain the short two-attempt recovery policy.
      const focusedStylesheet = step.tool === "write_file" && /\b(?:css|stylesheet|styles?)\b/i.test(step.description);
      const authoringReliability = step.tool === "write_file"
        // Measured against the configured local build worker: 900 completion
        // tokens take ~31.5s, so a normal 2.5k-token App.tsx decision can need
        // around 90s before transport overhead. The old 90s ceiling cancelled
        // healthy JSON at the boundary, before write_file ever reached the
        // browser. One 180s attempt is still bounded, adds no RPM, and is much
        // cheaper than generating the same full file twice.
        ? { timeoutMs: 180_000, maxAttempts: 1 }
        : undefined;
      // A 4,096-token ceiling makes a full-file JSON response large enough to
      // exceed the hosted tier's interactive window, then fail without ever
      // reaching the browser. Staged UI work writes focused components and
      // stylesheets, so 2,800 leaves room for complete code while materially
      // reducing the slowest request's output reservation. The tool contract
      // still rejects incomplete/malformed JSON; this is not a truncation
      // shortcut.
      const decisionMaxTokens = step.tool === "write_file" ? (focusedStylesheet ? 1_800 : 2_800) : undefined;
      const directWritePath = step.tool === "write_file" ? resolveExplicitWritePath(step.description, input) : null;
      let turn: AgentTurn;
      // The seeded browser workspace has one known, safe final check. Asking a
      // model to rediscover `npm run dev` after every UI build wasted a request
      // and was the most common place for it to emit `finish` instead of the
      // approved command. Run this deterministic check directly; any failure
      // still returns real command evidence and re-enters the normal recovery
      // path on the next attempt.
      const knownSandboxVerification = attempt === 1 &&
        step.tool === "run_command" &&
        /\b(?:build|test|lint|typecheck|check|verify|preview|dev(?:elopment)?\s+server)\b/i.test(step.description) &&
        (input.workspace_snapshot.file_tree.includes("projects/web/package.json") || input.workspace_path === "workspace");
      if (directWritePath) {
        try {
          const rawContent = await modelGateway.completeText(
            buildRawFileMessages(input, step, history, taskState, directWritePath, isRetry, lastError),
            {
              tier: tierForRole(input.model, "executor"),
              maxTokens: rawFileTokenBudget(directWritePath),
              callType: "execution_decision",
              thinking: false,
              fast: false,
              budget: input.budget,
              allowTruncated: /\.(?:css|scss|sass|less)$/i.test(directWritePath),
              reliability: authoringReliability,
              // Full-file authoring is the longest call in the turn. Without the
              // signal, Stop could not interrupt it at all — the user watched a
              // cancelled turn keep working for up to three minutes.
              signal,
              onRoute: (route) => { providerPath = route; },
            },
          );
          const content = unwrapFileBody(rawContent, directWritePath);
          if (!looksLikeCompleteFile(directWritePath, content)) {
            lastError = `The authoring response was not a complete ${directWritePath} file. Return raw file content only.`;
            remember({ role: "tool", tool_name: "model", content: `Decision error: ${lastError}` });
            continue;
          }
          turn = {
            thought: `Writing the complete ${directWritePath} file requested by this approved step.`,
            action: "write_file",
            action_input: { path: directWritePath, content },
            done: false,
          };
        } catch (error) {
          throwIfCancelled();
          lastError = error instanceof Error ? error.message : "Unable to author the requested file.";
          const decisionFailure: ToolTraceEntry = sanitizeTraceEntry({
            step_id: step.step_id,
            tool_name: "model_decision",
            input: { stage: "file_authoring" },
            output: lastError,
            status: "error",
            attempt,
            path_used: providerPath,
          });
          toolTrace.push(decisionFailure);
          applyTrace(taskState, toolTrace);
          emit({ type: "tool_result", step_id: step.step_id, status: "error", output: lastError });
          remember({ role: "tool", tool_name: "model", content: `Decision error: ${lastError}` });
          // Repeating the same full-file prompt after a deterministic output
          // ceiling spends another minute and produces the same truncation.
          // A provider-declared building allowance is equally deterministic
          // within this turn. Preserve its precise explanation and checkpoint
          // this step immediately instead of spending two more doomed calls.
          // Retry remains available after capacity or provider configuration
          // changes, not as an automatic loop against an exhausted allowance.
          if (/output limit|included building allowance/i.test(lastError)) attempt = MAX_RETRIES + 1;
          continue;
        }
      } else if (knownSandboxVerification) {
        turn = {
          thought: "Running the workspace preview check.",
          action: "run_command",
          action_input: { command: "npm run dev", cwd: "projects/web" },
          done: false,
        };
      } else if (attempt === 1) {
        const inspection = deterministicInspectionTurn(step, input);
        if (inspection) {
          // The first read of a known workspace is fully determined by the
          // approved plan and the browser snapshot.  Do it directly instead
          // of spending a model request merely to rediscover a file path.
          // This makes a real tool action happen even during a short provider
          // slowdown, and gives later authoring decisions real project context.
          turn = inspection;
        } else {
          try {
            turn = await modelGateway.complete(messages, {
              tier: tierForRole(input.model, "executor"),
              maxTokens: decisionMaxTokens,
              callType: "execution_decision",
              thinking,
              fast: canUseFastTier(step, gate),
              budget: input.budget,
              reliability: authoringReliability,
              signal,
              onRoute: (route) => { providerPath = route; },
            });
          } catch (error) {
            throwIfCancelled();
            lastError = error instanceof Error ? error.message : "Unable to decide the next action.";
            const decisionFailure: ToolTraceEntry = sanitizeTraceEntry({
              step_id: step.step_id,
              tool_name: "model_decision",
              input: { stage: "execution_decision" },
              output: lastError,
              status: "error",
              attempt,
              path_used: providerPath,
            });
            toolTrace.push(decisionFailure);
            applyTrace(taskState, toolTrace);
            emit({ type: "tool_result", step_id: step.step_id, status: "error", output: lastError });
            remember({ role: "tool", tool_name: "model", content: `Decision error: ${lastError}` });
            // This is a transient provider failure, not evidence that the
            // approved work is impossible. The outer retry is intentionally
            // bounded by MAX_RETRIES and re-decides from this recorded result.
            continue;
          }
        }
      } else try {
        turn = await modelGateway.complete(messages, {
          tier: tierForRole(input.model, "executor"),
          maxTokens: decisionMaxTokens,
          callType: "execution_decision",
          thinking,
          fast: canUseFastTier(step, gate),
          budget: input.budget,
          reliability: authoringReliability,
          signal,
          onRoute: (route) => { providerPath = route; },
        });
      } catch (error) {
        throwIfCancelled();
        // A provider decision can fail before there is a tool call. Preserve
        // the actual ledger and retry the *step* with the recorded failure.
        // Previously this branch forced `attempt = MAX_RETRIES + 1`, causing
        // every transient decision failure to pause a task before its first
        // browser action.
        lastError = error instanceof Error ? error.message : "Unable to decide the next action.";
        const decisionFailure: ToolTraceEntry = sanitizeTraceEntry({
          step_id: step.step_id,
          tool_name: "model_decision",
          input: { stage: "execution_decision" },
          output: lastError,
          status: "error",
          attempt,
          path_used: providerPath,
        });
        toolTrace.push(decisionFailure);
        applyTrace(taskState, toolTrace);
        emit({ type: "tool_result", step_id: step.step_id, status: "error", output: lastError });
        remember({ role: "tool", tool_name: "model", content: `Decision error: ${lastError}` });
        continue;
      }
      perf("step3.decision", Date.now() - decisionStart, {
        stepId: step.step_id,
        attempt,
        action: turn.action,
        thinking,
        thinkingReason: quickAuthoringPass ? "exhaustive_authoring_fast_pass" : correction ? "coherence_correction" : gate.reason,
        fast: canUseFastTier(step, gate),
      });
      // Never launch a browser tool after the user pressed Stop while a model
      // decision was in flight.
      throwIfCancelled();
      correction = undefined;

      // Validate model response schema
      if (!isValidAgentTurn(turn)) {
        lastError = describeInvalidTurn(turn);
        remember({
          role: "tool",
          content: `Error: ${lastError}`,
          tool_name: "model",
        });
        continue;
      }

      // The plan is a consent and scope contract, not a decorative outline.
      // Without this check a model could turn an approved write step into an
      // unrelated command (or a read into a write) before the normal tool
      // boundary ever sees it. Read/search remain interchangeable because both
      // are non-mutating inspection. Any other mismatch is re-decided before
      // execution; genuinely unresolved product choices are handled before a
      // plan is created and never become an execution tool.
      if (!actionAllowedForStep(step.tool, turn.action)) {
        lastError =
          `This approved step is scoped to ${step.tool ?? "a non-tool decision"}, but the model selected ${turn.action}. ` +
          `Choose the approved action for this step.`;
        remember({ role: "tool", tool_name: "trion", content: `Rejected: ${lastError}` });
        perf("step3.actionContractRejected", 0, { stepId: step.step_id, expected: step.tool, received: turn.action });
        continue;
      }

      // DECIDE FROM THE ACTUAL RESULT, NOT AN ASSUMED ONE.
      //
      // Compare the decision against the trace before acting on it. This catches
      // the failure schema validation structurally cannot: a perfectly
      // well-formed tool call that contradicts what really happened. The
      // dominant case in practice is finish/done:true emitted while approved
      // plan steps have no trace entry at all — four of the five failures on the
      // baseline coding run. One correction per step, so a wrong correction
      // costs one round trip and can never loop.
      const untouched = pendingSteps(taskState).filter((p) => !toolTrace.some((entry) => entry.step_id === p.id));
      const finishingEarly = turn.action === "finish" && turn.done === true && untouched.length > 0;

      // A premature finish is not a coherence NOTE, it is a wrong tool for this
      // step. The step-runner asked the model to execute step N; answering
      // "finish" leaves step N's work undone, and merely moving on to step N+1
      // silently drops it — measured on T4, where the utility file the step was
      // supposed to create never existed and only the wiring got written.
      //
      // So it is rejected like any other bad call and the step is retried with
      // an explicit reason. Once, though: a model that still wants to finish on
      // the retry is not going to be argued out of it, and the accept-then-
      // override path below at least carries the run on to the next step.
      if (finishingEarly && attempt === 1) {
        lastError =
          `"finish" is not a valid action for this step. Steps ${untouched.map((s) => s.id).join(", ")} of the approved plan ` +
          `have no tool call in the execution trace, including this one. Execute step ${step.step_id} — ${step.description} — ` +
          `using ${step.tool ?? "the appropriate tool"}.`;
        perf("step3.finishRejected", 0, { stepId: step.step_id, attempt, untouched: untouched.map((s) => s.id) });
        remember({ role: "tool", tool_name: "trion", content: `Rejected: ${lastError}` });
        continue;
      }

      if (!finishingEarly && corrections < MAX_COHERENCE_CORRECTIONS) {
        const problem = checkCoherence(turn, toolTrace, {
          pending: pendingSteps(taskState).map((s) => ({ id: s.id, description: s.description, tool: s.tool })),
          ...knownFilesFromTrace(toolTrace),
          snapshot: input.workspace_snapshot.file_tree,
        });
        if (problem) {
          corrections++;
          correction = problem.correction;
          perf("step3.coherence", 0, { stepId: step.step_id, kind: problem.kind, action: turn.action });
          remember({
            role: "tool",
            tool_name: "trion",
            content: `Coherence check: ${problem.correction}`,
          });
          // Not the model's retry — ours. Re-deciding must not consume one of
          // the two attempts the step is entitled to for real tool failures.
          attempt--;
          continue;
        }
      }

      // The model's own reasoning goes into the thread. Without it a retry sees
      // only the tool error, not the attempt that produced it, and re-issues the
      // identical call — which is how a step burned all three attempts on the
      // same mistake.
      if (turn.thought) {
        remember({ role: "assistant", content: `[step ${step.step_id}] ${turn.thought} → ${turn.action}` });
      }

      // runTool emits the tool_call event (with execution_id for the client
      // WebContainer executor) — emitting it here too would duplicate it.
      const toolStart = Date.now();
      const result = await runTool(turn, { sessionId, stepId: step.step_id, emit });
      perf("step3.tool", Date.now() - toolStart, { stepId: step.step_id, tool: turn.action, ok: result.ok });

      // VERIFICATION: decide success/failure BEFORE the trace row is written.
      // Verifying afterwards recorded the attempt as a success and then retried
      // it, so the trace showed a step that both succeeded and was retried.
      const verification = verifyToolResult(turn, result);
      const verified = result.ok && verification.ok;

      // Record trace entry (includes attempt number)
      const traceEntry: ToolTraceEntry = {
        step_id: step.step_id,
        tool_name: turn.action,
        input: turn.action_input,
        output: verified ? result.output : result.error ?? verification.error ?? "",
        status: verified ? "success" : "error",
        attempt,
        path_used: providerPath,
      };

      // Sanitize trace entry
      const sanitizedTraceEntry = sanitizeTraceEntry(traceEntry);
      toolTrace.push(sanitizedTraceEntry);

      // Fold the real result into the task state NOW, so the next step's
      // decision call sees the file this step just wrote without having to find
      // it in the transcript.
      applyTrace(taskState, toolTrace);
      checkpoint();

      // Emit tool result event (with live output for the trace UI)
      emit({
        type: "tool_result",
        step_id: step.step_id,
        status: verified ? "success" : "error",
        output: verified ? result.output : result.error ?? verification.error,
      });

      if (result.ok && !verification.ok) {
        lastError = verification.error;
        remember({
          role: "tool",
          content: `Verification failed: ${verification.error}`,
          tool_name: turn.action,
        });
        continue;
      }

      if (result.ok) {
        // UI quality chain — intentionally only once, after the final planned
        // source write of a substantial visual task. The critic has no tool
        // route; if it finds a concrete checklist violation, the synthesizer
        // may rewrite only this already-approved file, followed by one focused
        // re-check. These are genuine write calls in the normal trace, never
        // fictional "review" tool events.
        const isFinalPlannedWrite = !plan.steps.some((candidate) => candidate.step_id > step.step_id && candidate.tool === "write_file");
        const designEvidence = collectDesignEvidence(toolTrace);
        if (
          turn.action === "write_file" && designEvidence && isFinalPlannedWrite &&
          shouldRunDesignReview(input, plan, toolTrace)
        ) {
          const review = await runDesignCritic({
            input,
            plan,
            trace: toolTrace,
            sourcePath: designEvidence.targetPath,
            source: designEvidence.bundle,
          });
          perf("quality.designReview", 0, { verdict: review.verdict, violations: review.violations.length });
          if (review.verdict === "revise" && review.violations.length > 0) {
            const revision = await proposeDesignRevision({
              input,
              sourcePath: designEvidence.targetPath,
              source: designEvidence.targetSource,
              review,
            });
            const revisionPath = revision?.action_input?.path;
            const revisionContent = revision?.action_input?.content;
            // Same file, same approved operation. A design critic can request a
            // change but never expands the approved scope into another path.
            if (revision?.action === "write_file" && revisionPath === designEvidence.targetPath && typeof revisionContent === "string") {
              const revisionResult = await runTool(revision, { sessionId, stepId: step.step_id, emit });
              const revisionEntry = sanitizeTraceEntry({
                step_id: step.step_id,
                tool_name: "write_file",
                input: revision.action_input,
                output: revisionResult.ok ? revisionResult.output : revisionResult.error ?? "",
                status: revisionResult.ok ? "success" : "error",
                attempt: attempt + 1,
              });
              toolTrace.push(revisionEntry);
              applyTrace(taskState, toolTrace);
              emit({ type: "tool_result", step_id: step.step_id, status: revisionResult.ok ? "success" : "error", output: revisionResult.ok ? revisionResult.output : revisionResult.error });
              if (revisionResult.ok) {
                remember({ role: "tool", tool_name: "write_file", content: annotateEmptyResult("write_file", revisionResult.output) });
                const recheck = await runDesignCritic({
                  input,
                  plan,
                  trace: toolTrace,
                  sourcePath: designEvidence.targetPath,
                  source: designEvidence.bundle.replace(designEvidence.targetSource, revisionContent),
                  previousViolations: review.violations,
                  recheck: true,
                });
                perf("quality.designRecheck", 0, { verdict: recheck.verdict, remaining: recheck.violations.length });
              }
            }
          }
        }
        success = true;
        if (result.artifacts) {
          artifacts.push(...result.artifacts);
        }
        checkpoint();
        // Append to history for next model decision. Empty results are
        // annotated so the decision checkpoint reads them as a fact about the
        // workspace ("nothing here yet") rather than as a dead end.
        remember({
          role: "tool",
          content: annotateEmptyResult(turn.action, result.output),
          tool_name: turn.action,
        });
        throwIfCancelled();

        // The model's explicit "finish" declares the work complete — stop
        // executing the remaining plan steps instead of pushing the model to
        // run them.
        //
        // But "declares" is not "is". A finish only ENDS the run when no
        // approved step is still untouched. This is the second line of defence:
        // the rejection above already sent one back, so a model still finishing
        // here is not going to be talked out of it. Rather than fail the turn,
        // the run carries on to the next step, whose own decision call gets a
        // far better prompt position ("update App.tsx to render Counter") than
        // any amount of "you are not finished" could.
        const stillUntouched = pendingSteps(taskState).filter(
          (pending) => pending.id !== step.step_id && !toolTrace.some((entry) => entry.step_id === pending.id)
        );
        finished = turn.action === "finish" && turn.done === true && stillUntouched.length === 0;
        if (turn.action === "finish" && turn.done === true && stillUntouched.length > 0) {
          perf("step3.finishOverridden", 0, { stepId: step.step_id, untouched: stillUntouched.map((s) => s.id) });
          remember({
            role: "tool",
            tool_name: "trion",
            content:
              `Your "finish" was not accepted: steps ${stillUntouched.map((s) => s.id).join(", ")} of the approved plan have no ` +
              `tool call in the trace. Continuing to the next one. Do that work.`,
          });
        }
      } else {
        lastError = result.error;
        // Real error - append to history for retry
        remember({
          role: "tool",
          content: `Error: ${result.error}`,
          tool_name: turn.action,
        });

        // A missing browser-owned WebContainer cannot be repaired by asking
        // the model to emit the same tool call again. Stop immediately: this
        // saves two doomed decision requests and turns a 180s hang into one
        // actionable error. Real command/file failures still use the normal
        // retry budget.
        if (isClientBridgeUnavailable(result.error)) {
          attempt = MAX_RETRIES + 1;
          perf("step3.bridgeUnavailable", 0, { stepId: step.step_id });
        }
      }
    }

    if (!success) {
      emit({ type: "plan_update", step_id: step.step_id, state: "error" });
      stepStates.set(step.step_id, "error");
      // Return, do not throw. The caller needs the trace of everything that DID
      // run to explain the failure — throwing unwound it and the user was shown
      // an error with an empty trace.
      return {
        toolTrace,
        artifacts,
        history: newHistory,
        stepStates,
        failure: { stepId: step.step_id, error: lastError ?? "The step did not complete." },
      };
    }

    emit({ type: "plan_update", step_id: step.step_id, state: "done" });
    stepStates.set(step.step_id, "done");

    if (finished) {
      // The model declared the work complete. Remaining steps were never run —
      // marking them "done" would be a lie in the final plan, so they are
      // cancelled, which is what actually happened to them.
      for (const remaining of plan.steps) {
        if (remaining.step_id > step.step_id) {
          emit({ type: "plan_update", step_id: remaining.step_id, state: "cancelled" });
          stepStates.set(remaining.step_id, "cancelled");
        }
      }
      break;
    }
  }

  return { toolTrace, artifacts, history: newHistory, stepStates };
}

/**
 * A visual result can span component markup and styles. Reviewing only the
 * final write missed generic layouts in an earlier JSX file whenever the final
 * step happened to be CSS. Build a bounded, trace-grounded bundle and choose
 * the source with the strongest visual structure as the only revision target.
 */
function collectDesignEvidence(trace: ToolTraceEntry[]): { targetPath: string; targetSource: string; bundle: string } | null {
  const latest = new Map<string, { path: string; content: string; index: number }>();
  trace.forEach((entry, index) => {
    const path = typeof entry.input.path === "string" ? entry.input.path : "";
    const content = typeof entry.input.content === "string" ? entry.input.content : "";
    if (entry.tool_name !== "write_file" || entry.status !== "success" || !path || !content || !/\.(?:[jt]sx?|css|scss|sass|html?|vue|svelte)$/i.test(path)) return;
    latest.set(path, { path, content, index });
  });
  const files = [...latest.values()];
  if (!files.length) return null;
  const score = (file: { path: string; content: string; index: number }) => {
    const markup = (file.content.match(/<(?:main|section|article|header|footer|nav|div)\b/gi) ?? []).length;
    const component = /\.(?:[jt]sx?|vue|svelte|html?)$/i.test(file.path) ? 10 : 0;
    return component + Math.min(markup, 8) + file.index / 1000;
  };
  const target = [...files].sort((a, b) => score(b) - score(a))[0];
  const bundle = files
    .sort((a, b) => a.index - b.index)
    .map((file) => `=== ${file.path} ===\n${file.content}`)
    .join("\n\n");
  return { targetPath: target.path, targetSource: target.content, bundle };
}

function isClientBridgeUnavailable(error: string | undefined): boolean {
  // Both the idle message ("bridge unavailable…45s") and the hard-ceiling
  // message ("operation exceeded…180s") are unrecoverable within this turn:
  // retrying them burns full model decisions plus full bridge waits.
  return Boolean(error && /WebContainer bridge unavailable|WebContainer operation exceeded|Client disconnected before the WebContainer/i.test(error));
}

const VALID_ACTIONS = ["read_file", "write_file", "run_command", "search_codebase", "web_fetch", "finish"];

export function isValidAgentTurn(turn: AgentTurn): boolean {
  if (
    typeof turn.thought !== "string" ||
    typeof turn.action !== "string" ||
    !VALID_ACTIONS.includes(turn.action) ||
    typeof turn.done !== "boolean" ||
    typeof turn.action_input !== "object" ||
    turn.action_input === null
  ) {
    return false;
  }
  // The advertised schema requires a summary whenever the turn claims to be
  // done: without it the finish has no grounded result for the trace and the
  // synthesis falls back to a generic "Turn completed." A missing summary is
  // a precise, retryable schema error — not a reason to accept an empty finish.
  if (turn.done === true && (typeof turn.summary !== "string" || turn.summary.trim().length === 0)) {
    return false;
  }
  return true;
}

/** Say WHICH field was wrong. "Model returned invalid action schema" told the
 *  model nothing, so the retry reproduced the same malformed turn. */
function describeInvalidTurn(turn: AgentTurn): string {
  const problems: string[] = [];
  if (typeof turn.thought !== "string") problems.push('"thought" must be a string');
  if (typeof turn.action !== "string" || !VALID_ACTIONS.includes(turn.action)) {
    problems.push(`"action" must be one of: ${VALID_ACTIONS.join(", ")} (got ${JSON.stringify(turn.action)})`);
  }
  if (typeof turn.done !== "boolean") problems.push('"done" must be true or false');
  if (turn.done === true && (typeof (turn as { summary?: unknown }).summary !== "string" || ((turn as { summary?: string }).summary as string).trim().length === 0)) problems.push('"summary" must be a non-empty string when "done" is true');
  if (typeof turn.action_input !== "object" || turn.action_input === null) problems.push('"action_input" must be a JSON object');
  return `Your response did not match the required schema: ${problems.join("; ")}. Respond with ONLY the JSON object.`;
}

/** Empty search/read results are valid answers, but a bare `{"results":[]}` is
 *  easy for the model to read as "something went wrong". Spell out what it
 *  actually means so the next decision branches on task intent instead. */
export function annotateEmptyResult(action: string, output: string): string {
  let parsed: { results?: unknown[]; content?: string } | null = null;
  try {
    parsed = JSON.parse(output) as { results?: unknown[]; content?: string };
  } catch {
    return output;
  }

  if (action === "search_codebase" && Array.isArray(parsed?.results) && parsed.results.length === 0) {
    return `${output}

NOTE: The search completed successfully and matched nothing. This is a fact about the workspace, not an error. If the task is to CREATE something new, this is the expected result for a fresh workspace — proceed to scaffold the files with write_file. Only treat this as a problem if the task required editing code that was supposed to already exist.`;
  }

  if (action === "read_file" && typeof parsed?.content === "string" && parsed.content.length === 0) {
    return `${output}

NOTE: The file exists and is empty. This is not an error. If the task is to populate it, proceed with write_file.`;
  }

  return output;
}

function verifyToolResult(turn: AgentTurn, result: { ok: boolean; output: string; error?: string }): { ok: boolean; error?: string } {
  if (!result.ok) return { ok: false, error: result.error };

  // A result that came back EMPTY is still a result. "No files matched" and
  // "the file is empty" are facts about the workspace, not tool failures — and
  // on a build-from-scratch request they are the EXPECTED answer. Reporting
  // them as failures burned both retries and then aborted the step, which is
  // how "make me a duck game" on an empty workspace ended in "there are no
  // files to work from and I couldn't continue". The model decides what an
  // empty result means; the runner must not decide for it.
  //
  // Only a malformed payload is a real failure here: it means the bridge
  // returned something we cannot hand to the model at all.
  if (turn.action === "read_file" || turn.action === "search_codebase" || turn.action === "web_fetch") {
    try {
      JSON.parse(result.output);
    } catch {
      return { ok: false, error: "Tool output is not valid JSON" };
    }
  }
  return { ok: true };
}

/**
 * A workspace inspection step is occasionally completely determined before a
 * model is involved: the approved plan asks to read a file and the browser
 * snapshot already lists that file.  Use that evidence directly.  This is not
 * a shortcut for authoring or commands; it is the same read the model would
 * have emitted, with zero model requests and no guessed path.
 */
function deterministicInspectionTurn(step: PlanDoc["steps"][number], input: NormalInput): AgentTurn | null {
  if (step.tool === "search_codebase") {
    // A broad, literal search is a valid context-first first action even in an
    // empty project. An empty result is evidence the authoring step needs, not
    // an execution failure. It also avoids losing a whole build to a model call
    // whose only job was to choose a harmless search string.
    return {
      thought: "Checking the workspace for the existing application entry point.",
      action: "search_codebase",
      action_input: { query: "export", maxResults: 20 },
      done: false,
    };
  }

  if (step.tool !== "read_file") return null;

  const files = input.workspace_snapshot.file_tree.filter((entry) => /\.(?:[cm]?[jt]sx?|css|html|json|md)$/i.test(entry));
  if (!files.length) return null;

  const mentioned = step.description.match(/[\w@./-]+\.(?:[cm]?[jt]sx?|css|html|json|md)\b/i)?.[0];
  const path = mentioned
    ? files.find((file) => file === mentioned || file.endsWith(`/${mentioned}`))
    : files.find((file) => /(?:^|\/)(?:App|page|layout)\.[cm]?[jt]sx?$/i.test(file)) ?? files[0];

  if (!path) return null;
  return {
    thought: "Reading the existing workspace file named in the approved inspection step.",
    action: "read_file",
    action_input: { path },
    done: false,
  };
}

function resolveExplicitWritePath(description: string, input: NormalInput): string | null {
  const mentioned = description.match(/[\w@./-]+\.(?:[cm]?[jt]sx?|css|scss|sass|less|html?|json|md|ya?ml|toml|py|go|rs)\b/i)?.[0];
  if (!mentioned) return null;
  const clean = mentioned.replace(/^\.\//, "");
  if (clean.includes("/")) return clean;
  return input.workspace_snapshot.file_tree.find((file) => file === clean || file.endsWith(`/${clean}`)) ?? null;
}

function rawFileTokenBudget(path: string): number {
  if (/\.(?:css|scss|sass|less)$/i.test(path)) return 1_400;
  if (/\.html?$/i.test(path)) return 1_800;
  return 3_200;
}

function unwrapFileBody(raw: string, path: string): string {
  const trimmed = raw.trim();
  const body = trimmed.replace(/^```(?:[\w+-]+)?\s*\n/, "").replace(/\n```\s*$/, "").trimEnd();
  if (/\.(?:css|scss|sass|less)$/i.test(path)) {
    return salvageCssPrefix(body);
  }
  return body + "\n";
}

export function salvageCssPrefix(css: string): string {
  const boundary = lastBalancedCssBoundary(css);
  return (boundary >= 0 ? css.slice(0, boundary + 1) : css).trimEnd() + "\n";
}

function lastBalancedCssBoundary(css: string): number {
  let depth = 0;
  let last = -1;
  let quote = "";
  let escaped = false;
  let comment = false;
  for (let index = 0; index < css.length; index++) {
    const char = css[index];
    const next = css[index + 1];
    if (comment) {
      if (char === "*" && next === "/") { comment = false; index++; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "*") { comment = true; index++; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "{") depth++;
    if (char === "}" && depth > 0) {
      depth--;
      if (depth === 0) last = index;
    }
  }
  return last;
}

function looksLikeCompleteFile(path: string, content: string): boolean {
  if (content.length < 40 || /\b(?:TODO|your code here|rest of (?:the )?code)\b/i.test(content)) return false;
  if (/\.(?:tsx?|jsx?)$/i.test(path)) return /\b(?:import|export|function|const|class)\b/.test(content) && !/^\s*[<{[]\s*"(?:thought|action)"/.test(content);
  if (/\.(?:css|scss|sass|less)$/i.test(path)) return /[^@\s][^{]*\{[^}]*\}/s.test(content);
  if (/\.html?$/i.test(path)) return /<(?:!doctype|html|head|body|main|div)\b/i.test(content);
  return true;
}

function buildRawFileMessages(
  input: NormalInput,
  step: PlanDoc["steps"][number],
  history: Array<{ role: "user" | "assistant" | "tool"; content: string; tool_name?: string }>,
  taskState: TaskState,
  path: string,
  isRetry: boolean,
  lastError?: string,
): NimMessage[] {
  const messages: NimMessage[] = [{ role: "system", content: RAW_FILE_AUTHOR_SYSTEM_PROMPT }];
  messages.push(...contextWindowToMessages(buildContextWindow(history, CONTEXT_PRESETS.execution), RENDER_PRESETS.execution));
  messages.push({ role: "user", content: renderHandoffCheckpoint(taskState) });
  if (isRetry && lastError) messages.push({ role: "user", content: `The previous file body was rejected: ${lastError}` });
  messages.push({
    role: "user",
    content: `Approved path: ${path}\nCurrent step: ${step.step_id} - ${step.description}\nOriginal outcome: ${input.user_message}\n${fileShapeConstraint(path)}\nReturn the complete raw contents of ${path} now.`,
  });
  return messages;
}

function fileShapeConstraint(path: string): string {
  if (/\.(?:tsx?|jsx?)$/i.test(path)) {
    return "Hard size limit: at most 180 lines. Use small data arrays and reusable markup; include every requested section, but do not add filler, an icon library, or long SVG paths.";
  }
  if (/\.(?:css|scss|sass|less)$/i.test(path)) {
    return "Hard size limit: at most 140 lines. Use shared custom properties and grouped selectors; do not repeat declarations or create ornamental variants. Close every rule before starting another.";
  }
  if (/\.html?$/i.test(path)) {
    return "Hard size limit: at most 100 lines. Keep application UI in the framework entry component; this file should contain only the necessary document shell and metadata.";
  }
  return "Keep the file concise and complete. Stop as soon as the requested implementation is present.";
}

function buildExecuteMessages(
  input: NormalInput,
  step: PlanDoc["steps"][0],
  history: Array<{ role: "user" | "assistant" | "tool"; content: string; tool_name?: string }>,
  taskState: TaskState,
  isRetry: boolean,
  lastError?: string,
  correction?: string,
  stagedUiAuthoring = false
): NimMessage[] {
  const messages: NimMessage[] = [
    // Curated per step kind, and byte-identical across every call of that kind:
    // a read-only step does not pay for the write_file and run_command specs or
    // the whole "WRITING FILES" section. A retry or an unhinted step gets the
    // full catalog — see executePromptFor.
    { role: "system", content: executePromptFor(step.tool, { isRetry, stagedUiAuthoring }) },
  ];

  // Shared assembler — same turn-selection rules as every other call type.
  // Rendered with the execution preset, which keeps error rows and the most
  // recent tool payloads whole and collapses older RESOLVED ones to a receipt.
  messages.push(
    ...contextWindowToMessages(buildContextWindow(history, CONTEXT_PRESETS.execution), RENDER_PRESETS.execution)
  );

  // A deterministic checkpoint bridges the planner/executor (and any configured
  // model-tier change) without an extra summarizer request. It contains only
  // evidence from the approved plan and completed tool calls.
  //
  // This lives in the USER message, never the system prompt: the system prefix
  // has to stay byte-identical for the cacheable-prefix check.
  messages.push({ role: "user", content: renderHandoffCheckpoint(taskState) });

  if (isRetry && lastError) {
    messages.push({
      role: "user",
      content: `Previous attempt failed: ${lastError}. Try a different approach or fix the error.`,
    });
  }

  if (correction) {
    messages.push({ role: "user", content: `STOP — check this before acting:\n${correction}` });
  }

  const attachments = input.attached_context
    .map((ctx) => frameUntrustedContent(`ATTACHMENT: ${ctx.path ?? "attachment"}`, String(ctx.content ?? "").slice(0, 12_000)))
    .join("\n");

  // Say it at the point of decision, not after the fact.
  //
  // The model's default answer to "execute step N" was "finish" — on a
  // nine-step scaffold it answered finish on eight of nine steps, each costing a
  // rejection and a second decision call. One line here is two orders of
  // magnitude cheaper than that round trip, and it is only present on the steps
  // where it is true.
  const remaining = pendingSteps(taskState).filter((s) => s.id !== step.step_id);
  const mustAct = remaining.length
    ? `\nThis step is NOT the end of the work: steps ${remaining.map((s) => s.id).join(", ")} still follow. ` +
      `"finish" will be rejected. Emit the tool call that does step ${step.step_id}.\n`
    : "";

  messages.push({
    role: "user",
    content: `Current step: ${step.step_id} - ${step.description}
Suggested tool: ${step.tool || "none (finish)"}
${mustAct}${attachments ? `\nUser-attached files for this turn:\n${attachments}\n` : ""}
${exhaustiveBuildTestEnabled() && isInterfaceBuildRequest(input.user_message) ? `\n${EXHAUSTIVE_STEP_DISCIPLINE}\n` : ""}Execute step ${step.step_id}: ${step.description}`,
  });

  return messages;
}

/**
 * Machine-enforced boundary between the user-approved plan and the concrete
 * action selected by the model. Exported for the regression suite because this
 * is a safety invariant, not merely prompt guidance.
 */
export function actionAllowedForStep(
  plannedTool: PlanStep["tool"],
  action: AgentTurn["action"]
): boolean {
  // `finish` is itself an action, not a universal escape hatch. Letting it
  // through on a planned write/run step meant a second premature-finish attempt
  // could be recorded as a successful step despite no approved tool ever
  // running. Only an explicit no-tool/finish plan step may end the turn.
  if (action === "finish") return plannedTool === null || plannedTool === "finish";
  if (plannedTool === "read_file" || plannedTool === "search_codebase" || plannedTool === "web_fetch") {
    return action === "read_file" || action === "search_codebase" || action === "web_fetch";
  }
  return plannedTool !== null && action === plannedTool;
}
