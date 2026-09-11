// STEP 4: Synthesis (runs on both success and error)
// Turns full step history into natural-language summary for user

import type { NormalInput, SynthesisDoc, ToolTraceEntry, PlanDoc, VerificationSummary } from "../types";
import { modelGateway } from "../model-gateway";
import { sanitize } from "../sanitize";
import type { NimMessage } from "../types";
import { DIRECT_ANSWER_SYSTEM_PROMPT, PLAN_ONLY_SYSTEM_PROMPT, SYNTHESIS_SYSTEM_PROMPT } from "../static-prompts";
import { buildContextWindow, contextWindowToMessages, renderContextWindow, CONTEXT_PRESETS } from "../context";
import type { CallType } from "../token-ledger";
import { perf } from "../perf";

export async function synthesizeResult(
  input: NormalInput,
  toolTrace: ToolTraceEntry[],
  plan: PlanDoc | null,
  error?: Error,
  /** Rendered task state. Carries the step ledger, so the summary can be told
   *  which approved steps never ran instead of inferring completion from the
   *  presence of a plan. */
  taskState?: string,
  verification?: VerificationSummary | null
): Promise<SynthesisDoc> {
  // A failed task must never spend another model request merely to translate a
  // failure into prose. More importantly, model fallbacks occasionally emit a
  // literal debug receipt (paths, tool names and planned steps) precisely when
  // the person needs a calm recovery action. Every failure therefore takes this
  // deterministic, evidence-only path — rate limits, sandbox disconnects,
  // timeouts, malformed model output, and unexpected orchestration failures
  // all get the same professional surface.
  if (error) return pausedTaskSynthesis(toolTrace, error);

  // This is a deterministic completion gate, not an instruction the model can
  // ignore. It also avoids spending a synthesis request merely to turn missing
  // evidence into reassuring prose. "started" passes through: a live dev server
  // is reportable final evidence, and its honest message travels with it.
  if (verification?.required && verification.status !== "passed" && verification.status !== "started") {
    return {
      message: verification.status === "not_run"
        ? "The changes are in place, but Trion still needs to run the final project check before it can confirm the result is ready."
        : "The final project check did not pass, so Trion can’t confirm the result is ready yet.",
      next_action_hint: "Retry the final check after reviewing the task details.",
    };
  }
  const messages: NimMessage[] = [
    { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
    { role: "user", content: buildSynthesisPrompt(input, toolTrace, plan, error, taskState) },
  ];

  // The result summary now carries file lists and fenced code; 800 tokens cut
  // it off mid-block.
  const doc = await completeSynthesis(messages, input.model, 1_400, "synthesis");

  // GROUNDING — checked, not requested.
  //
  // The prompt already forbids claiming a file that no write_file produced, and
  // the model does it anyway: a benchmark turn whose entire trace was one
  // read_file was summarised as "Created Counter.tsx / Updated App.tsx /
  // Started dev server". That is the worst output this system can emit, because
  // it is confident, specific and false, and the user has no way to tell. An
  // instruction cannot fix it; comparing the claim to the trace can.
  const invented = ungroundedFileClaims(doc.message, toolTrace);
  if (invented.length === 0) return doc;

  perf("synthesis.ungrounded", 0, { paths: invented.slice(0, 5) });

  const retry = await completeSynthesis(
    [
      ...messages,
      {
        role: "user",
        content:
          `Your previous answer claimed these files were created or changed: ${invented.join(", ")}. ` +
          `The execution trace contains NO successful write_file for them, so that is false. ` +
          `Rewrite the answer using only what the trace shows. If no file was written, say so plainly and say which planned steps did not run.`,
      },
    ],
    input.model,
    1_400,
    "synthesis_fallback"
  );

  if (ungroundedFileClaims(retry.message, toolTrace).length === 0) return retry;

  // Still inventing. Ship the facts instead — a plain, correct account of what
  // ran beats a fluent account of what did not.
  return { message: describeTraceLiterally(toolTrace, plan), next_action_hint: undefined };
}

/** Verb + path, in that order, within one clause: "created `src/a.ts`",
 *  "Updated **projects/web/src/App.tsx**". */
const CLAIMED_WRITE =
  /\b(creat(?:ed|ing)|updat(?:ed|ing)|add(?:ed|ing)|wrote|writing|modif(?:ied|ying)|generat(?:ed|ing))\b[^.\n]{0,80}?([\w.-]+(?:\/[\w.-]+)*\.[a-z]{1,5})\b/gi;

/** Paths the message says were written that the trace does not confirm. */
export function ungroundedFileClaims(message: string, toolTrace: ToolTraceEntry[]): string[] {
  const written = new Set(
    toolTrace
      .filter((entry) => entry.tool_name === "write_file" && entry.status === "success")
      .map((entry) => (typeof entry.input.path === "string" ? entry.input.path.replace(/^\.\//, "") : ""))
      .filter(Boolean)
  );

  const invented = new Set<string>();
  for (const match of message.replace(/[`*_]/g, "").matchAll(CLAIMED_WRITE)) {
    const path = match[2].replace(/^\.\//, "");
    // A bare filename counts as grounded if any written path ends with it —
    // "updated App.tsx" about projects/web/src/App.tsx is true, not invented.
    const grounded = [...written].some((w) => w === path || w.endsWith(`/${path}`) || path.endsWith(`/${w}`));
    if (!grounded) invented.add(path);
  }
  return [...invented];
}

/** Deterministic, trace-only account. The last resort, and never wrong. */
export function describeTraceLiterally(toolTrace: ToolTraceEntry[], plan: PlanDoc | null): string {
  const failed = toolTrace.filter((t) => t.status === "error");
  if (failed.length) return pausedTaskSynthesis(toolTrace).message;

  const changed = toolTrace.filter((entry) => entry.tool_name === "write_file" && entry.status === "success").length;
  const checked = toolTrace.filter((entry) => entry.tool_name === "run_command" && entry.status === "success").length;
  if (changed > 0) {
    return `The work completed. ${changed} ${changed === 1 ? "project update was" : "project updates were"} applied${checked ? " and the final check was run" : ""}.`;
  }
  return plan ? "The task completed without changing the project." : "The response is ready.";
}

/** One professional recovery message for every execution failure. The raw
 * trace stays available behind the optional activity detail, never in the
 * primary reply. */
export function pausedTaskSynthesis(toolTrace: ToolTraceEntry[], error?: Error): SynthesisDoc {
  const detail = error?.message ?? "";
  const localAllowanceLimited = /included building allowance|building allowance is currently exhausted/i.test(detail);
  const capacityLimited = /shared model-request limit|rate limit|resourceexhausted|too many requests/i.test(detail);
  const bridgeUnavailable = /webcontainer bridge unavailable|client disconnected|browser tool result/i.test(detail);
  const verificationFailed = /final verification|verification command|build check/i.test(detail);
  const timedOut = /timed out|operation exceeded/i.test(detail);
  const noConfirmedAction = !toolTrace.some((entry) => entry.status === "success");
  return {
    message: localAllowanceLimited
      ? noConfirmedAction
        ? "Your included building allowance is currently exhausted. No work is being shown as complete. Connect your own model to continue now, or wait for the allowance to reset."
        : "Your included building allowance was reached after part of the project completed. Connect your own model to continue from the next unfinished step, or wait for the allowance to reset."
      : capacityLimited
      ? noConfirmedAction
        ? "Trion could not start the saved build while the service was temporarily busy. No work is being shown as complete. Retry in about a minute to continue from the first step."
        : "Trion reached a temporary service limit after completing part of the saved build. Retry in about a minute to continue from the next unfinished step."
      : bridgeUnavailable
      ? "Trion paused because the browser workspace stopped responding after confirmed work. Keep this Trion tab open until the tool finishes, then retry from the next unfinished step."
      : verificationFailed
      ? "Trion paused because the final project check did not complete successfully. Confirm the reported build or test issue, then retry the saved verification step."
      : timedOut
      ? "Trion paused because the next build step timed out after confirmed work. Retry continues from the next unfinished step without repeating completed work."
      : noConfirmedAction
        ? "Trion could not start the next saved build step. No work is being shown as complete. Retry continues from that exact step."
        : "Trion paused after confirmed work was completed. Retry continues from the next unfinished step.",
    next_action_hint: bridgeUnavailable
      ? "Keep the workspace tab open, wait for it to become ready, then retry the saved task."
      : verificationFailed
        ? "Review the failed project check and retry; completed file changes will not be repeated."
        : "Retry continues the saved task instead of starting over.",
  };
}

/** A planning failure is not an execution checkpoint. Keep its recovery copy
 * stage-accurate so the user is never told a nonexistent build step was saved. */
export function planningFailureSynthesis(error?: Error): SynthesisDoc {
  const detail = error?.message ?? "";
  const capacityLimited = /shared model-request limit|rate limit|resourceexhausted|too many requests/i.test(detail);
  const missingProvider = /not configured in this environment/i.test(detail);
  const timedOut = /timed out|timeout/i.test(detail);
  return {
    message: capacityLimited
      ? "Trion could not prepare the build plan because the shared service is temporarily busy. No build steps were started. Try again in about a minute."
      : missingProvider
        ? "Trion could not prepare the build plan because no model connection is configured. Add a connection in Settings, then start a new request."
        : timedOut
          ? "Trion could not prepare the build plan because the model service did not respond in time. No build steps were started; retry the request or use your own connection in Settings."
      : "Trion could not prepare the build plan, so no project work was started. Try again to create a fresh plan.",
    next_action_hint: missingProvider
      ? "Open Settings → Connections and activate a model connection, then start a new request."
      : timedOut
        ? "Retry once, or open Settings → Connections to use your own model provider."
        : "Retry planning; there are no partial project changes to recover.",
  };
}

/** Technical trace names stay in the audit trail; completion copy uses a
 * concise human description so a timeout does not expose implementation jargon
 * as the user's primary explanation. */

/**
 * Think-mode reply: present the plan, do not report on execution.
 *
 * Routing a plan-only turn through the execution-synthesis prompt asked the
 * model to summarise a trace that was empty by design, and it dutifully replied
 * "No files were created or modified. The project remains unchanged." — a
 * correct sentence and a useless answer to "how would you build this?".
 *
 * When a taskState is provided (ongoing session), include it so recall questions
 * ("which files have you changed?", "what was the original goal?") can be
 * answered from the authoritative session record rather than the truncated
 * transcript.
 */
export async function synthesizePlanOnly(input: NormalInput, plan: PlanDoc, taskState?: string): Promise<SynthesisDoc> {
  const conversation = renderContextWindow(buildContextWindow(input.conversation_history, CONTEXT_PRESETS.synthesis));

  const messages: NimMessage[] = [
    { role: "system", content: PLAN_ONLY_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Conversation so far:
${conversation}

User request: ${input.user_message}

The plan you produced (already shown to the user):
${plan.plan_summary}
${plan.steps.map((s) => `${s.step_id}. ${s.description}${s.tool ? ` [${s.tool}]` : ""}`).join("\n")}

Files that currently exist in the workspace (use these EXACT paths when naming
files — do not shorten or guess them):
${input.workspace_snapshot.file_tree.slice(0, 120).map((path) => `- ${path}`).join("\n") || "- (empty workspace)"}
${taskState ? `\n\n=== TASK STATE (authoritative) ===\n${taskState}\n\nThis record covers the WHOLE session. If the question asks which files were changed, which commands ran, what failed, or what the original goal was, answer from these lines and list EVERY matching entry — including ones from early turns that the transcript no longer shows.` : ""}

Present this approach to the user.`,
    },
  ];

  // 800 tokens cut the answer off mid-sentence once it was writing real
  // Markdown with a file list and a tradeoffs section.
  const synthesis = await completeSynthesis(messages, input.model, 1_200, "plan_only");
  // Trion automatically selects the appropriate execution path; it does not
  // expose a Think/Execute mode toggle. A model-generated hint such as
  // “switch to Execute mode” is therefore an impossible instruction even when
  // the plan itself is good. Keep the plan prose, but make the next action a
  // stable, truthful product instruction.
  return { ...synthesis, next_action_hint: "Send the request when you are ready to build it." };
}

export async function synthesizeDirectAnswer(input: NormalInput, taskState?: string): Promise<SynthesisDoc> {
  // Conversational turns are still CONVERSATION — they need the thread they are
  // part of. Prior turns go in as real chat messages so a follow-up
  // ("and the other one?") resolves against what was actually said.
  const window = buildContextWindow(input.conversation_history, CONTEXT_PRESETS.directAnswer);
  const messages: NimMessage[] = [
    { role: "system", content: DIRECT_ANSWER_SYSTEM_PROMPT },
    ...contextWindowToMessages(window),
  ];

  // A conversational turn inside a long build is very often a RECALL question
  // ("what did I ask you to build?", "which files have you changed?"). The
  // transcript window cannot answer those once the session outgrows it; the
  // task state can, and it is a fraction of the size.
  // Placed AFTER the transcript and immediately before the question, because
  // ordering decided the answer in practice: sitting ahead of a long chat
  // window, this block lost to recency. Asked "which files have you changed?"
  // on turn 10 of a benchmark session, the model listed only the two files from
  // turn 9 and omitted one written on turn 4 — which this block named. It had
  // the answer and answered from the transcript instead.
  if (taskState) {
    messages.push({
      role: "user",
      content:
        `=== WHAT THIS SESSION HAS ESTABLISHED (authoritative) ===\n${taskState}\n\n` +
        `This record outranks the transcript above: it covers the WHOLE session, ` +
        `the transcript only its recent part. If the question asks which files ` +
        `were changed, which commands ran, or what failed, answer from these ` +
        `lines and list EVERY matching entry — including ones from early turns ` +
        `that the transcript no longer shows. Never report the session as ` +
        `clean if a failure is listed.`,
    });
  }

  messages.push({ role: "user", content: input.user_message });

  // Enough room for a code example without truncating it. A direct-answer
  // model can still be induced to quote its hidden instruction/context block;
  // do not rely on a refusal instruction alone when the output itself exposes
  // that failure. This boundary keeps the response useful without revealing
  // internal prompts, contracts, or routing details.
  const synthesis = await completeSynthesis(messages, input.model, 1_200, "direct_answer");
  if (!containsInternalDisclosure(synthesis.message)) return synthesis;
  return {
    message: "I can’t provide internal instructions or hidden system details. I can explain how Trion works at a high level instead.",
    next_action_hint: "Ask about a specific capability or workflow outcome.",
  };
}

function containsInternalDisclosure(message: string): boolean {
  return /(?:\byou are trion,? a coding agent\b|\breturn only valid json\b|\bavailable tools:\b|\b(?:intent|plan|execute)_system_prompt\b|\bturn contract\b.{0,160}\bstep\s*[0-5]\b|\bnormalizeInput\b|\bclassifyIntent\b|\bgeneratePlanDoc\b|\bexecuteSteps\b|\bsynthesizeResult\b)/is.test(message);
}

function buildSynthesisPrompt(
  input: NormalInput,
  toolTrace: ToolTraceEntry[],
  plan: PlanDoc | null,
  error?: Error,
  taskState?: string
): string {
  // 200 characters per row was not enough to see a single command's output, so
  // the summary was written from step NAMES rather than step RESULTS — which is
  // how "created the file" got reported for a step whose output said the write
  // had failed. Failures get the most room, because they are what the user needs.
  const traceSummary = toolTrace
    .map((t) => {
      const budget = t.status === "error" ? 1_200 : 700;
      const body = t.output.length > budget ? `${t.output.slice(0, budget)}… (truncated)` : t.output;
      const target = describeTarget(t.input);
      return `Step ${t.step_id} — ${t.tool_name}${target ? ` ${target}` : ""} (attempt ${t.attempt}): ${t.status.toUpperCase()}\n${body}`;
    })
    .join("\n\n");

  // The files that actually changed on disk, which is what the user most wants
  // named. Derived from the trace, so it can never claim a write that never ran.
  const written = toolTrace
    .filter((t) => t.tool_name === "write_file" && t.status === "success")
    .map((t) => (typeof t.input.path === "string" ? t.input.path : null))
    .filter((path): path is string => Boolean(path));

  const planSummary = plan
    ? `Plan: ${plan.plan_summary}\nSteps: ${plan.steps.map((s) => `${s.step_id}. ${s.description} (${s.tool || "none"})`).join("; ")}`
    : "No plan (direct answer)";

  const errorInfo = error ? `\nThe turn ended with this error: ${error.message}` : "";

  const conversation = renderContextWindow(
    buildContextWindow(input.conversation_history, CONTEXT_PRESETS.synthesis)
  );

  return `Conversation so far:
${conversation}

User request: ${input.user_message}
${taskState ? `\n=== TASK STATE (authoritative) ===\n${taskState}\n` : ""}
${planSummary}

Files written this turn (verified from the trace — this list is EXHAUSTIVE, and
if it says "none" then no file was created or changed):
${written.length ? written.map((path) => `- ${path}`).join("\n") : "- none"}

Execution trace:
${traceSummary || "(no tools executed)"}
${errorInfo}

Write the user-facing result now, following your system instructions. Report only
what the trace above actually shows. If the step ledger lists steps that were
never done, say so — do not present a partial result as a finished one.`;
}

/** The thing a tool acted on, for a readable trace line. */
function describeTarget(input: Record<string, unknown>): string {
  if (typeof input.path === "string") return `(${input.path})`;
  if (typeof input.command === "string") return `($ ${input.command})`;
  if (typeof input.query === "string") return `("${input.query}")`;
  return "";
}

/**
 * Parse the model's JSON envelope — and NEVER throw.
 *
 * This used to throw on any malformed reply, which the state machine caught as a
 * turn failure. So a model that answered "hi" perfectly well but wrapped it in a
 * stray markdown fence produced a red error card instead of the answer it had
 * already written. The envelope is a transport detail; the prose inside it is
 * the product. When the envelope is broken, ship the prose.
 */
function parseSynthesisDoc(raw: string): SynthesisDoc {
  const text = raw.trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1)) as Partial<SynthesisDoc>;
      if (typeof parsed.message === "string" && parsed.message.trim() && !isDegenerate(parsed.message)) {
        return {
          message: sanitize(parsed.message),
          next_action_hint:
            typeof parsed.next_action_hint === "string" && parsed.next_action_hint.trim() && !isDegenerate(parsed.next_action_hint)
              ? sanitize(parsed.next_action_hint)
              : undefined,
        };
      }
    } catch {
      // Fall through to the raw-text path below.
    }
  }

  const fallback = stripEnvelope(text);
  if (fallback && !isDegenerate(fallback)) {
    return { message: sanitize(fallback), next_action_hint: undefined };
  }
  return { message: UNUSABLE, next_action_hint: undefined };
}

/** Sentinel for "the model produced nothing usable". Callers retry on it rather
 *  than shipping it. */
const UNUSABLE = "__trion_unusable__";

/**
 * Run a synthesis call on the fast tier, and fall back to the full model when
 * the fast one returns something unusable.
 *
 * The fast tier handles the overwhelming majority of these calls in a fraction
 * of the time, which is why it is the default. But when it degenerates, the
 * right answer is one slower call — not showing the user "....".
 */
async function completeSynthesis(
  messages: NimMessage[],
  tier: NormalInput["model"],
  maxTokens: number,
  callType: CallType
): Promise<SynthesisDoc> {
  // thinking OFF: synthesis is a rendering job. The inputs — the trace, the
  // files written, the step ledger — are already decided facts, and the output
  // is prose in a JSON envelope. Deliberating about it before writing it
  // produced a large block of discarded reasoning tokens on every turn (534
  // completion tokens against a ~250-token answer, measured on the baseline).
  const fast = parseSynthesisDoc(
    await modelGateway.completeText(messages, { tier, fast: true, maxTokens, callType, thinking: false })
  );
  if (fast.message !== UNUSABLE) return fast;

  // The fallback DOES think: the cheap path already produced something
  // unusable, so this is the retry that has to be right.
  const full = parseSynthesisDoc(
    await modelGateway.completeText(messages, { tier, fast: false, maxTokens, callType: "synthesis_fallback", thinking: true })
  );
  if (full.message !== UNUSABLE) return full;

  return {
    message: "I wasn't able to put a response together for that. Try rephrasing your request.",
    next_action_hint: undefined,
  };
}

/**
 * Is this the shape of an answer, or the shape of the instructions that asked
 * for one?
 *
 * The small fast model occasionally treats a prompt's "Open with X, then Y"
 * guidance as a TEMPLATE and returns the placeholders instead of filling them —
 * literally `"Open with approach ...\n\n- ...\n- ...\n\n..."`, or just `"...."`.
 * That parses as valid JSON with a non-empty message, so nothing downstream
 * catches it and the user is shown ellipses as their answer. Rejecting it here
 * routes the turn to the plain-text salvage path, which produces something
 * honest instead.
 */
function isDegenerate(message: string): boolean {
  const text = message.trim();
  if (!text) return true;

  // Nothing but ellipses, dashes and whitespace.
  if (/^[.\-*•\s]+$/.test(text)) return true;

  // Placeholder-dominated: more than a third of the non-empty lines are just
  // a bullet followed by an ellipsis, or an ellipsis alone.
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 0) {
    const placeholders = lines.filter((line) => /^(?:[-*•]\s*)?\.{2,}$/.test(line) || /\.\.\.\s*$/.test(line) && line.length < 32);
    if (placeholders.length / lines.length > 0.34) return true;
  }

  // Echoes the instruction verbs rather than answering.
  if (/^(?:Open with|Then the shape|Lead with|Start by (?:saying|opening))\b/i.test(text)) return true;

  return false;
}

/** Salvage readable prose from a reply that failed to parse as JSON: drop a
 *  markdown fence wrapper, and pull out a `"message": "…"` value if the object
 *  was merely truncated. */
function stripEnvelope(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = (fenced ? fenced[1] : text).trim();

  const messageField = body.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (messageField) {
    try {
      return JSON.parse(`"${messageField[1]}"`) as string;
    } catch {
      return messageField[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
  }

  // Not JSON at all — the model just answered in plain text. That is usable.
  return body.startsWith("{") ? "" : body;
}
