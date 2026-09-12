// Client-supplied resume checkpoints — validation and conversion.
//
// The server keeps checkpoints in a process-local Map, so any restart,
// redeploy, or serverless cold start wipes them. The browser already persists
// the user-visible thread (SavedSession) and already re-sends its transcript
// for history rehydration; checkpoints follow the same pattern: the client
// snapshots the last errored turn's {plan, toolTrace, artifacts} from its
// result event, stores it under its own session id, and re-sends it with
// resume:true. The server treats its map as a cache and rehydrates from the
// client payload on lookup miss instead of dead-ending.
//
// Everything in here is untrusted input until validated: shape-checked,
// length-capped, and stripped of server-audit fields (path_used) and stale
// preview URLs (a resumed dev server issues its own).

import type { Artifact, PlanDoc, ToolTraceEntry } from "./types";
import type { PendingExecution } from "./session-store";

export const MAX_CHECKPOINT_JSON_CHARS = 256_000;
const MAX_PLAN_STEPS = 12;
const MAX_STEP_DESC_CHARS = 2_000;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_TRACE_ENTRIES = 60;
const MAX_TRACE_OUTPUT_CHARS = 20_000;
const MAX_TOOL_NAME_CHARS = 200;
const MAX_ARTIFACTS = 10;
const MAX_ARTIFACT_CONTENT_CHARS = 200_000;
const MAX_ARTIFACT_LANG_CHARS = 100;

export type ClientCheckpoint = {
  plan: PlanDoc;
  toolTrace: ToolTraceEntry[];
  artifacts: Artifact[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!text || text.length > max) return null;
  return text;
}

/** Accept either the raw PlanDoc (plan_summary) or the public Plan (summary)
 *  the client actually receives in result events. Renumbers steps exactly
 *  like the planner parser does, so duplicated/skipped ids cannot desync the
 *  executor's plan_update events. */
function toPlanDoc(value: unknown): PlanDoc | null {
  if (!isRecord(value)) return null;
  const summary =
    cleanText(value.plan_summary, MAX_SUMMARY_CHARS) ?? cleanText(value.summary, MAX_SUMMARY_CHARS);
  if (!summary) return null;
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > MAX_PLAN_STEPS) {
    return null;
  }
  const steps: PlanDoc["steps"] = [];
  for (const candidate of value.steps) {
    if (!isRecord(candidate)) return null;
    const description = cleanText(candidate.description, MAX_STEP_DESC_CHARS);
    if (!description) return null;
    const tool = candidate.tool === null || candidate.tool === undefined
      ? null
      : typeof candidate.tool === "string"
        ? candidate.tool.slice(0, MAX_TOOL_NAME_CHARS)
        : null;
    steps.push({ step_id: steps.length + 1, description, tool });
  }
  return { plan_summary: summary, steps };
}

function toTrace(value: unknown): ToolTraceEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_TRACE_ENTRIES) return null;
  const trace: ToolTraceEntry[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const stepId = candidate.step_id;
    const toolName = cleanText(candidate.tool_name, MAX_TOOL_NAME_CHARS);
    const output = typeof candidate.output === "string"
      ? candidate.output.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      : null;
    if (typeof stepId !== "number" || !Number.isFinite(stepId) || !toolName || output === null) return null;
    if (output.length > MAX_TRACE_OUTPUT_CHARS) return null;
    if (candidate.status !== "success" && candidate.status !== "error") return null;
    const attempt = typeof candidate.attempt === "number" && Number.isFinite(candidate.attempt) && candidate.attempt >= 1
      ? Math.floor(candidate.attempt)
      : 1;
    trace.push({
      step_id: Math.floor(stepId),
      tool_name: toolName,
      input: isRecord(candidate.input) ? (candidate.input as Record<string, unknown>) : {},
      output,
      status: candidate.status,
      attempt,
    });
  }
  return trace;
}

function toArtifacts(value: unknown): Artifact[] | null {
  if (!Array.isArray(value) || value.length > MAX_ARTIFACTS) return null;
  const artifacts: Artifact[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    if (candidate.type !== "code_diff" && candidate.type !== "file" && candidate.type !== "preview") return null;
    if (typeof candidate.content !== "string" || candidate.content.length > MAX_ARTIFACT_CONTENT_CHARS) return null;
    const language = candidate.language === undefined
      ? undefined
      : cleanText(candidate.language, MAX_ARTIFACT_LANG_CHARS) ?? undefined;
    // preview_url is deliberately dropped: it points at a dead dev server
    // from before the restart, and the resumed run issues its own.
    artifacts.push({ type: candidate.type, language, content: candidate.content });
  }
  return artifacts;
}

/** Strict shape validation. Returns null for anything malformed, oversized,
 *  or foreign — the caller treats that as "no checkpoint" and takes the
 *  graceful-fallback path, never a 400 that would hard-fail a retry. */
export function validateClientCheckpoint(value: unknown): ClientCheckpoint | null {
  if (value === undefined || value === null) return null;
  try {
    if (JSON.stringify(value).length > MAX_CHECKPOINT_JSON_CHARS) return null;
  } catch {
    return null;
  }
  const plan = toPlanDoc(isRecord(value) ? value.plan : null);
  const toolTrace = toTrace(isRecord(value) ? value.toolTrace : null);
  const artifacts = toArtifacts(isRecord(value) ? value.artifacts : null);
  if (!plan || !toolTrace || !artifacts) return null;
  return { plan, toolTrace, artifacts };
}

/** Shape a validated client checkpoint into the server's resume input. The
 *  retried user message is authoritative for intent; the checkpoint supplies
 *  only the approved plan and its evidence. */
export function toPendingExecution(checkpoint: ClientCheckpoint, userText: string): PendingExecution {
  return {
    plan: checkpoint.plan,
    originalUserText: userText,
    toolTrace: checkpoint.toolTrace,
    artifacts: checkpoint.artifacts,
  };
}
