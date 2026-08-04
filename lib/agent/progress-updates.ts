import type { PlanDoc, ToolTraceEntry } from "./types";

/**
 * Local, evidence-only updates for the person watching a task. They replace
 * noisy raw tool logs without spending a model request or sending task data to
 * another provider. The primary agent remains responsible for all decisions.
 */
export function planProgress(plan: PlanDoc): string {
  const first = plan.steps[0]?.description;
  const next = first ? ` First I’ll ${lowercaseFirst(first)}.` : " I’ll begin with the approved plan.";
  return `I’ve mapped the work into ${plan.steps.length} ${plan.steps.length === 1 ? "step" : "steps"}.${next}`;
}

export function pausedProgress(plan: PlanDoc, trace: ToolTraceEntry[]): string {
  const completed = trace.filter((entry) => entry.status === "success").length;
  if (completed === 0) {
    return "The build paused before its first workspace action. Nothing has been presented as completed; retry will continue from the saved first step.";
  }
  return `The work paused after ${completed} completed ${completed === 1 ? "action" : "actions"}. Your completed changes are kept; retry will continue from the next unfinished step.`;
}

export function completeProgress(plan: PlanDoc, trace: ToolTraceEntry[]): string {
  const completed = trace.filter((entry) => entry.status === "success").length;
  return `The plan is complete. ${completed} ${completed === 1 ? "action was" : "actions were"} confirmed during the build; the final result below includes the verification evidence.`;
}

function lowercaseFirst(value: string): string {
  return value.length ? `${value[0].toLowerCase()}${value.slice(1)}` : value;
}
