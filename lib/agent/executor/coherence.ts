// Does the model's next action agree with what actually happened?
//
// Step 3 re-decides after every tool result, and the whole design depends on
// that decision being made from the REAL result. This module compares the
// decision against the tool_trace — the only record of what ran — and returns a
// correction when they disagree.
//
// The checks are ranked by what the benchmark actually caught. On the baseline
// run of the 11-case coding suite, four of the five failures were the SAME
// defect: the model emitted finish/done:true while the approved plan still had
// steps that had never been attempted. In one of them (T6) the turn read a file,
// finished immediately, and the synthesis then described a component file that
// no write_file had ever created. Nothing in the loop objected, because a
// premature `finish` is a perfectly well-formed tool call — which is exactly why
// schema validation cannot catch this class of error and a trace comparison can.
//
// Every check below compares a SPECIFIC, falsifiable claim against the trace.
// Anything vaguer is left alone: a false correction costs a wasted round trip,
// which is the cost this is supposed to remove.

import type { AgentTurn, ToolTraceEntry } from "../types";

export type CoherenceProblem = {
  kind: "finishes_with_work_pending" | "finishes_over_failure" | "claims_unrun_success" | "cites_unread_file";
  /** Shown to the model as a correction. States the trace fact, not an opinion. */
  correction: string;
};

export type PendingStep = { id: number; description: string; tool: string | null };

/** "I already created…", "as we saw…", "has been added" — a past-tense claim
 *  that this run has already done something. */
const PAST_SUCCESS =
  /\b(?:already|previously)\s+(?:created|written|wrote|added|installed|updated|modified|ran|read)\b|\b(?:as|since)\s+(?:we|i)\s+(?:already\s+)?(?:saw|read|created|wrote|established|confirmed)\b|\b(?:has|have)\s+been\s+(?:created|written|added|installed|updated)\b/i;

/** A path mentioned inside the thought. */
const PATH_LIKE = /\b[\w.-]+(?:\/[\w.-]+)+\.[a-z]{1,5}\b|\b[\w-]+\.(?:tsx?|jsx?|css|scss|html|json|md|ya?ml|txt)\b/gi;

/** Claims about a file's CONTENTS, which require having read or written it. */
const CONTENT_CLAIM =
  /\b(?:contains|currently\s+(?:has|renders|imports|exports)|already\s+(?:has|imports|exports|renders|defines)|the\s+file\s+(?:has|shows|declares))\b/i;

export function checkCoherence(
  turn: AgentTurn,
  toolTrace: ToolTraceEntry[],
  context: {
    /** Plan steps with no successful result yet. */
    pending: PendingStep[];
    read: Set<string>;
    written: Set<string>;
    snapshot: readonly string[];
  }
): CoherenceProblem | null {
  const thought = (turn.thought ?? "").trim();
  const finishing = turn.action === "finish" && turn.done === true;

  // 1. Finishing with plan steps that were never attempted.
  //
  //    This is the dominant real-world failure. The plan is the contract the
  //    user approved at the gate; ending the turn without touching three of its
  //    steps is not a judgement call, it is an abandoned task reported as a
  //    completed one. The correction names the exact steps, because "you are not
  //    finished" without them told the model nothing it could act on.
  if (finishing && context.pending.length > 0) {
    const untouched = context.pending.filter((step) => !toolTrace.some((entry) => entry.step_id === step.id));
    if (untouched.length > 0) {
      return {
        kind: "finishes_with_work_pending",
        correction:
          `You are about to finish, but ${untouched.length} approved plan step(s) have never been attempted:\n` +
          untouched.map((step) => `- step ${step.id}: ${step.description}${step.tool ? ` (${step.tool})` : ""}`).join("\n") +
          `\nThe execution trace shows no tool call for any of them. Do the next one now instead of finishing. ` +
          `Only finish if that step is genuinely already satisfied by work in the trace above — and if so, say which trace entry satisfies it.`,
      };
    }
  }

  // 2. Finishing on top of a failure. Telling the user the task is done when the
  //    last thing that happened was an error is the most damaging wrong answer
  //    this loop can produce.
  if (finishing && toolTrace.length > 0) {
    const last = toolTrace[toolTrace.length - 1];
    if (last.status === "error") {
      return {
        kind: "finishes_over_failure",
        correction:
          `You are about to finish, but the most recent tool call FAILED: step ${last.step_id} (${last.tool_name}) returned: ` +
          `${String(last.output).slice(0, 300)}. Either fix that failure with another tool call, or finish with a summary that ` +
          `states plainly what did not work. Do not report the task as complete.`,
      };
    }
  }

  if (!thought) return null;

  // 3. Claiming past success with nothing successful in the trace.
  const succeeded = toolTrace.filter((entry) => entry.status === "success");
  if (succeeded.length === 0 && PAST_SUCCESS.test(thought)) {
    const failed = toolTrace.filter((entry) => entry.status === "error");
    const detail = failed.length
      ? `The only tool calls so far FAILED (${failed.map((f) => `${f.tool_name} at step ${f.step_id}`).join(", ")}).`
      : `No tool call has succeeded yet in this turn.`;
    return {
      kind: "claims_unrun_success",
      correction:
        `Your reasoning says work has already been done, but the execution trace does not support that. ${detail} ` +
        `Decide the next action from the trace, not from an assumption about what an earlier step produced.`,
    };
  }

  // 4. Asserting a file's CONTENTS without ever having read or written it.
  if (CONTENT_CLAIM.test(thought)) {
    for (const cited of new Set(thought.match(PATH_LIKE) ?? [])) {
      const path = cited.replace(/^\.\//, "");
      const known =
        context.read.has(path) ||
        context.written.has(path) ||
        [...context.read, ...context.written].some((p) => p.endsWith(path) || path.endsWith(p));
      if (known) continue;
      const inSnapshot = context.snapshot.some((p) => p === path || p.endsWith(`/${path}`));
      return {
        kind: "cites_unread_file",
        correction:
          `Your reasoning states what "${cited}" contains, but it has not been read or written in this turn` +
          (inSnapshot
            ? ` — it does exist in the workspace, so read it with read_file before relying on its contents.`
            : `, and it is not in the workspace snapshot at all. Do not assume a file exists or what is in it: verify with read_file or search_codebase, or create it explicitly with write_file.`),
      };
    }
  }

  return null;
}

/** Files this turn has demonstrably read or written, from the trace. */
export function knownFilesFromTrace(toolTrace: ToolTraceEntry[]): { read: Set<string>; written: Set<string> } {
  const read = new Set<string>();
  const written = new Set<string>();
  for (const entry of toolTrace) {
    if (entry.status !== "success") continue;
    const path = typeof entry.input.path === "string" ? entry.input.path.replace(/^\.\//, "") : null;
    if (!path) continue;
    if (entry.tool_name === "read_file") read.add(path);
    if (entry.tool_name === "write_file") written.add(path);
  }
  return { read, written };
}
