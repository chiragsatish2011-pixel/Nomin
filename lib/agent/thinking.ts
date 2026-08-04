// Think-before-acting, gated on whether the step is actually ambiguous.
//
// The models behind every tier are reasoning models: unprompted, they spend a
// large and highly variable share of the completion budget narrating their own
// deliberation before emitting the JSON the loop parses. Measured directly
// against this codebase's intent call, that is 222 completion tokens of
// reasoning in front of a 19-token answer — a 12x multiplier on a three-field
// enum. The reasoning is discarded by every parser here, so on a mechanical call
// it is pure cost.
//
// Neither extreme is right:
//   - always think (the previous behaviour, since nothing set the flag): pays
//     the premium on every call, including classifying "hi" and formatting a
//     JSON envelope. That is most of the completion-token bill.
//   - never think: removes reasoning from the calls that need it — a retry after
//     a failure, a step coordinating two files, a step whose tool the plan did
//     not decide. Those are where first-attempt tool-call errors come from.
//
// So the gate is conservative: it thinks whenever a step shows any known
// ambiguity signal, and skips only for steps whose action is fully determined by
// the step description itself.

import type { PlanDoc } from "./types";
import type { TaskState } from "./task-state";

export type ThinkingDecision = {
  think: boolean;
  /** Recorded in perf output so the gate can be tuned against real data. */
  reason: string;
};

/** Verbs whose step description does NOT determine the action: the model has to
 *  work out what to do, not just how to phrase it. */
const DIAGNOSTIC = /\b(fix|debug|diagnos\w*|investigat\w*|find|locate|resolve|troubleshoot|identify|repair|why)\b/i;

/** Concrete targets named in the step. Two or more distinct ones means the step
 *  is coordinating.
 *
 *  The path alternative must consume a WHOLE path greedily. A non-greedy
 *  `[\w.-]+\/[\w.-]+` matched "projects/web" and "src/App.tsx" separately inside
 *  one path, so every fully-qualified single-file step looked like a two-target
 *  coordination and was sent to think. */
const PATH_LIKE = /\b[\w.-]+(?:\/[\w.-]+)+|\b[\w-]+\.(?:tsx?|jsx?|css|scss|html|json|md|ya?ml|py|rs|go|java|rb|sh|toml|txt)\b/g;

/** Joined actions ("write X and update Y") — one tool call cannot do both, so
 *  the model has to decide which half this step is. */
const CONJOINED = /\b(?:and|then|also)\b\s+(?:update|change|modify|edit|use|wire|import|register|render|add|apply)\b/i;

/** An instruction to change something that already exists. */
const EDIT_VERB = /\b(update|change|edit|modify|rename|replace|adjust|amend|refactor)\b/i;

export function decideThinking(
  step: Pick<PlanDoc["steps"][number], "description" | "tool">,
  opts: { isRetry: boolean; state: TaskState | null }
): ThinkingDecision {
  // 1. A retry is by definition a step where the obvious answer was wrong.
  if (opts.isRetry) return { think: true, reason: "retry" };

  // 2. The plan declined to pick a tool, so the decision is genuinely open.
  if (!step.tool) return { think: true, reason: "no_tool_hint" };

  // 3. Authoring. Measured, and the reason this rule exists: with thinking off,
  //    a write_file step very often answered "finish" instead of writing the
  //    file — on a nine-step scaffold, eight of nine steps did it. Emitting a
  //    whole file body is the most expensive thing the model can be asked for
  //    and "finish" is the cheapest, so with no deliberation it takes the exit.
  //    Every other gate here is about correctness; this one is about the model
  //    actually doing the work.
  if (step.tool === "write_file") return { think: true, reason: "authoring" };

  // 4. Diagnostic work: the description states a symptom, not an action.
  if (DIAGNOSTIC.test(step.description)) return { think: true, reason: "diagnostic" };

  // 5. Coordination across more than one named target.
  const paths = [...new Set(step.description.match(PATH_LIKE) ?? [])];
  if (paths.length > 1) return { think: true, reason: "multiple_targets" };
  if (CONJOINED.test(step.description)) return { think: true, reason: "conjoined_actions" };

  // 6. Editing a file this run has never read. Whether to read it first IS the
  //    decision, and getting it wrong overwrites content that mattered.
  //    (Reached only for non-write_file steps now that rule 3 exists; kept
  //    because an edit can also be planned as a run_command or an unhinted step.)
  if (EDIT_VERB.test(step.description)) {
    const known =
      opts.state?.filesTouched.some((file) => paths.some((p) => file.path.endsWith(p) || p.endsWith(file.path))) ?? false;
    if (paths.length === 1 && !known) return { think: true, reason: "blind_edit" };
  }

  return { think: false, reason: "determined_by_step" };
}

/**
 * Right-sizing: which steps can be decided by the cheap tier.
 *
 * Only when the step is fully determined AND the call is not authoring file
 * content. Emitting a path, a query or a command is a formatting job; writing
 * the body of a source file is not, and that is where the large model earns its
 * cost.
 */
export function canUseFastTier(step: Pick<PlanDoc["steps"][number], "tool">, decision: ThinkingDecision): boolean {
  if (decision.think) return false;
  return step.tool === "read_file" || step.tool === "search_codebase" || step.tool === "run_command";
}
