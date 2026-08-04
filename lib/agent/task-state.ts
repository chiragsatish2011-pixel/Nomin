// Structured task state — the agent's working memory, kept separately from the
// raw conversation.
//
// Before this module the only record of "what is going on" was chat replay: the
// decision call at step 9 reconstructed the goal, the decisions already made and
// the files already touched by re-reading ten turns of transcript, most of which
// was tool payload. That is expensive — the transcript is the single largest
// variable input to every execution call — and lossy in exactly the wrong
// direction, because the oldest turn is the one carrying the ORIGINAL GOAL and
// it is the first thing a recency window drops.
//
// This is a deterministic projection of things that actually happened: the plan,
// the tool_trace, the clarifications. No model call, so it costs no latency and
// cannot hallucinate. It is what gets fed to later decision calls, and it lives
// on the session so it survives across turns.

import type { PlanDoc, ToolTraceEntry } from "./types";

export type TouchedFile = {
  path: string;
  /** "written" outranks "read": a file we wrote is a file we know the contents of. */
  action: "read" | "written";
  stepId: number;
};

/**
 * A step that failed, kept beyond the turn it failed in.
 *
 * The per-turn `steps` ledger cannot carry this: `applyPlan` reassigns it
 * wholesale at the start of every turn, so a failure is erased by the next
 * plan. `commandsRun` cannot carry it either — that list only records
 * successes. So a session where `npm install nanoid` failed twice on turn 3
 * answered "No failures occurred earlier in this session" when asked on turn
 * 11, which is not a recall miss but a state that never held the fact at all.
 */
export type RecordedFailure = {
  turn: number;
  stepId: number;
  tool: string;
  /** The command or path involved, which is what makes the failure identifiable. */
  target: string;
  error: string;
};

export type TaskState = {
  /** The request that started this task. Not overwritten by a follow-up, because
   *  a follow-up is usually a refinement OF this goal rather than a new one. */
  goal: string;
  /** Later user messages against the same goal, in order. */
  refinements: string[];
  /** Choices the run has committed to, derived from what actually ran. */
  decisions: string[];
  filesTouched: TouchedFile[];
  commandsRun: Array<{ command: string; stepId: number }>;
  /** Clarifying questions asked and not yet answered. */
  openQuestions: string[];
  /** Per-step outcome ledger for the CURRENT turn's plan. */
  steps: Array<{
    id: number;
    description: string;
    tool: string | null;
    state: "pending" | "running" | "done" | "error" | "cancelled";
    attempts: number;
    lastError?: string;
  }>;
  /** Failures from ANY turn of this task, not just the current one. */
  failures: RecordedFailure[];
  /** "<turn>:<stepId>" for every step that has succeeded, across all turns.
   *  Keyed rather than counted so re-applying a trace cannot double-count. */
  completedStepKeys: string[];
  /** Steps completed across ALL turns of this task — long-horizon recall. */
  completedStepCount: number;
  turnCount: number;
};

export function emptyTaskState(goal: string): TaskState {
  return {
    goal,
    refinements: [],
    decisions: [],
    filesTouched: [],
    commandsRun: [],
    openQuestions: [],
    steps: [],
    failures: [],
    completedStepKeys: [],
    completedStepCount: 0,
    turnCount: 0,
  };
}

/** Fold this turn's plan into the state, resetting the per-turn step ledger. */
export function applyPlan(state: TaskState, plan: PlanDoc): TaskState {
  state.steps = plan.steps.map((step) => ({
    id: step.step_id,
    description: step.description,
    tool: step.tool,
    state: "pending" as const,
    attempts: 0,
  }));
  return state;
}

/** Re-open only incomplete steps of a previously approved plan. This makes a
 * retry a continuation, not another planning turn. */
export function resumePlan(state: TaskState, plan: PlanDoc): TaskState {
  const previous = new Map(state.steps.map((step) => [step.id, step]));
  state.steps = plan.steps.map((step) => {
    const prior = previous.get(step.step_id);
    return {
      id: step.step_id,
      description: step.description,
      tool: step.tool,
      state: prior?.state === "done" ? "done" as const : "pending" as const,
      attempts: prior?.attempts ?? 0,
    };
  });
  return state;
}

/**
 * Fold the real tool_trace into the state.
 *
 * Everything here derives from rows describing work that ACTUALLY RAN, so a
 * decision can never be recorded for a tool call the model merely proposed.
 */
export function applyTrace(state: TaskState, trace: ToolTraceEntry[]): TaskState {
  for (const entry of trace) {
    const step = state.steps.find((s) => s.id === entry.step_id);
    if (step) {
      step.attempts = Math.max(step.attempts, entry.attempt);
      step.state = entry.status === "success" ? "done" : "error";
      step.lastError = entry.status === "error" ? String(entry.output).slice(0, 200) : undefined;
    }

    if (entry.status !== "success") {
      // Durable, because the per-turn ledger above is about to be thrown away
      // by the next plan. Deduplicated on turn+step+tool so the retry attempts
      // of one failing step record once rather than three times.
      const target =
        (typeof entry.input.command === "string" && entry.input.command) ||
        (typeof entry.input.path === "string" && entry.input.path) ||
        entry.tool_name;
      const key = `${state.turnCount}:${entry.step_id}:${entry.tool_name}`;
      const already = state.failures.find(
        (f) => `${f.turn}:${f.stepId}:${f.tool}` === key
      );
      if (!already) {
        state.failures.push({
          turn: state.turnCount,
          stepId: entry.step_id,
          tool: entry.tool_name,
          target: String(target).slice(0, 120),
          error: String(entry.output).replace(/\s+/g, " ").slice(0, 160),
        });
        // This block is re-sent on every later call, so it is capped. Oldest
        // goes first: a recent failure is the one still worth acting on.
        if (state.failures.length > 8) state.failures.splice(0, state.failures.length - 8);
      }
      continue;
    }

    const stepKey = `${state.turnCount}:${entry.step_id}`;
    if (!state.completedStepKeys.includes(stepKey)) state.completedStepKeys.push(stepKey);

    const path = typeof entry.input.path === "string" ? entry.input.path.replace(/^\.\//, "") : null;
    if (path && (entry.tool_name === "write_file" || entry.tool_name === "read_file")) {
      const action = entry.tool_name === "write_file" ? "written" : "read";
      const existing = state.filesTouched.find((f) => f.path === path);
      if (!existing) state.filesTouched.push({ path, action, stepId: entry.step_id });
      // A read followed by a write is a write. The reverse is not a downgrade.
      else if (action === "written") existing.action = "written";
    }

    if (entry.tool_name === "run_command" && typeof entry.input.command === "string") {
      const command = entry.input.command;
      if (!state.commandsRun.some((c) => c.command === command)) {
        state.commandsRun.push({ command, stepId: entry.step_id });
      }
    }
  }

  // Cumulative, not per-turn. This used to be reassigned from the current
  // turn's ledger, so at turn 9 of a session with 19 completed steps it
  // reported "1 steps done overall" — a per-turn count wearing a cumulative
  // label, which is worse than not reporting it.
  state.completedStepCount = state.completedStepKeys.length;
  return state;
}

/** Steps of the current plan that have not produced a successful tool result.
 *  This is what a premature `finish` is checked against. */
export function pendingSteps(state: TaskState) {
  return state.steps.filter((s) => s.state === "pending" || s.state === "running");
}

/** Record a decision the run committed to. Deduplicated and capped: this block
 *  goes into every subsequent decision call, so noise here is paid for
 *  repeatedly. */
export function recordDecision(state: TaskState, decision: string): TaskState {
  const clean = decision.replace(/\s+/g, " ").trim().slice(0, 160);
  if (clean && !state.decisions.includes(clean)) state.decisions.push(clean);
  if (state.decisions.length > 12) state.decisions.splice(0, state.decisions.length - 12);
  return state;
}

export function recordOpenQuestion(state: TaskState, question: string): TaskState {
  const clean = question.replace(/\s+/g, " ").trim().slice(0, 200);
  if (clean && !state.openQuestions.includes(clean)) state.openQuestions.push(clean);
  return state;
}

/** The user replied to a question we asked. The ANSWER becomes a decision — it
 *  is the most load-bearing thing they said, and it must outlive the question. */
export function resolveOpenQuestions(state: TaskState, answer: string): TaskState {
  if (state.openQuestions.length) {
    recordDecision(state, `Asked "${state.openQuestions[0]}" — user answered: ${answer}`);
    state.openQuestions = [];
  }
  return state;
}

/** A person can change the subject instead of answering a question. Do not
 * carry that old branch into the next task and accidentally interpret a later
 * request as its delayed answer. This records no fabricated decision because
 * no decision was made. */
export function dismissOpenQuestions(state: TaskState): TaskState {
  state.openQuestions = [];
  return state;
}

/** A new user instruction against an ongoing task. */
export function recordRefinement(state: TaskState, message: string): TaskState {
  const clean = message.replace(/\s+/g, " ").trim().slice(0, 200);
  if (clean && !state.refinements.includes(clean)) state.refinements.push(clean);
  if (state.refinements.length > 8) state.refinements.splice(0, state.refinements.length - 8);
  return state;
}

/**
 * Render the state for a model call.
 *
 * Deliberately terse and deliberately ordered: goal first, because it is what a
 * long run loses; open questions last, because they are what the next action has
 * to respect. Every line is a fact with a provenance in the plan or the trace.
 */
export function renderTaskState(state: TaskState): string {
  const lines: string[] = [`ORIGINAL GOAL: ${state.goal}`];

  if (state.refinements.length) {
    lines.push(`Refined since by the user: ${state.refinements.map((r) => `"${r}"`).join("; ")}`);
  }

  if (state.decisions.length) {
    lines.push("Decisions already made (do not revisit):");
    for (const decision of state.decisions) lines.push(`- ${decision}`);
  }

  const written = state.filesTouched.filter((f) => f.action === "written").map((f) => f.path);
  const read = state.filesTouched.filter((f) => f.action === "read").map((f) => f.path);
  // Enumerated rather than comma-joined, and counted. As a single joined line
  // this was demonstrably skimmable: asked to list changed files on turn 10 of
  // the long-horizon session, the model named the two from the most recent turn
  // and silently dropped a third that this line contained. The count gives the
  // answer something to check itself against. Reads stay joined — they are
  // rarely what a recall question is about, and this block is re-sent on every
  // later call, so the extra tokens are only spent where they changed an answer.
  if (written.length) {
    lines.push(`Files already written (${written.length} total — this is the COMPLETE list):`);
    for (const path of written) lines.push(`- ${path}`);
  }
  if (read.length) lines.push(`Files read (contents may no longer be in view): ${read.join(", ")}`);
  if (state.commandsRun.length) {
    lines.push(`Commands already run: ${state.commandsRun.map((c) => c.command).join("; ")}`);
  }

  const done = state.steps.filter((s) => s.state === "done");
  const failed = state.steps.filter((s) => s.state === "error");
  const pending = pendingSteps(state);
  lines.push(
    `Step ledger: ${done.length} done, ${failed.length} failed, ${pending.length} still to do` +
      (state.turnCount > 1 ? ` (turn ${state.turnCount} of this task; ${state.completedStepCount} steps done overall)` : "")
  );
  for (const step of done) lines.push(`- [DONE] ${step.id}. ${step.description}`);
  for (const step of failed) {
    lines.push(`- [FAILED after ${step.attempts} attempt(s)] ${step.id}. ${step.description}${step.lastError ? ` — ${step.lastError}` : ""}`);
  }
  for (const step of pending) lines.push(`- [STILL TO DO] ${step.id}. ${step.description}`);

  // Failures from earlier turns, which the per-turn ledger above cannot show.
  // Rendered after the ledger so the current turn stays the headline, and
  // labelled by turn so "earlier" is answerable precisely.
  const earlier = state.failures.filter((f) => f.turn !== state.turnCount);
  if (earlier.length) {
    lines.push("Failures earlier in this session (already happened; do not claim the session was clean):");
    for (const failure of earlier) {
      lines.push(`- turn ${failure.turn}: ${failure.tool} on "${failure.target}" failed — ${failure.error}`);
    }
  }

  if (state.openQuestions.length) {
    lines.push("Unanswered questions you asked the user:");
    for (const question of state.openQuestions) lines.push(`- ${question}`);
  }

  return lines.join("\n");
}

/**
 * A compact, evidence-only handoff for the next model call.
 *
 * Planner, executor, and verifier can be routed to different configured
 * tiers, but none should have to replay a long transcript to understand the
 * previous role's work. This checkpoint is derived only from the durable plan
 * and real tool trace, so it is cheap, resumable, and cannot invent progress.
 * It deliberately replaces an extra LLM "summarize what happened" call: that
 * would consume another request against the shared NIM budget on every step.
 */
export function renderHandoffCheckpoint(state: TaskState): string {
  const lines = [
    "=== MODEL HANDOFF CHECKPOINT (evidence only) ===",
    `Goal: ${state.goal.slice(0, 500)}`,
  ];

  if (state.refinements.length) {
    lines.push(`Latest user refinement: ${state.refinements.at(-1)?.slice(0, 260)}`);
  }
  if (state.decisions.length) {
    lines.push("Committed decisions:");
    for (const decision of state.decisions.slice(-4)) lines.push(`- ${decision}`);
  }

  const written = state.filesTouched.filter((file) => file.action === "written").map((file) => file.path);
  if (written.length) lines.push(`Files written: ${written.slice(-12).join(", ")}${written.length > 12 ? ` (+${written.length - 12} earlier)` : ""}`);
  if (state.commandsRun.length) lines.push(`Commands that succeeded: ${state.commandsRun.slice(-6).map((entry) => entry.command).join("; ")}`);

  lines.push("Current plan ledger:");
  for (const step of state.steps.slice(0, 10)) {
    const marker = step.state === "done" ? "DONE" : step.state === "error" ? "FAILED" : "TODO";
    lines.push(`- [${marker}] ${step.id}. ${step.description.slice(0, 180)}`);
  }
  const latestFailure = state.failures.at(-1);
  if (latestFailure && latestFailure.turn === state.turnCount) {
    lines.push(`Latest failure: ${latestFailure.tool} on ${latestFailure.target} — ${latestFailure.error}`);
  }
  if (state.openQuestions.length) lines.push(`Unresolved user decision: ${state.openQuestions[0]}`);

  // The task-state fields are individually bounded. This final guard protects
  // future additions from silently turning a handoff into a context overflow.
  const checkpoint = lines.join("\n");
  return checkpoint.length <= 4_000 ? checkpoint : `${checkpoint.slice(0, 3_950)}\n[checkpoint truncated]`;
}
