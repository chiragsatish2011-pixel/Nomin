// STEP 2: Plan Generation (user's tier)
// Produces plan and streams it immediately before any tool executes

import type { NormalInput, PlanDoc } from "../types";
import { modelGateway } from "../model-gateway";
import { tierForRole } from "../model-tiers";
import { sanitize } from "../sanitize";
import type { NimMessage, StreamEvent } from "../types";
import { PLAN_SYSTEM_PROMPT } from "../static-prompts";
import { buildContextWindow, renderContextWindow, CONTEXT_PRESETS } from "../context";
import { frameUntrustedContent } from "../untrusted-content";
import { perf } from "../perf";
import { exhaustiveBuildTestEnabled, isInterfaceBuildRequest, stageExhaustiveInterfacePlan } from "../exhaustive-build-test";
import { buildWorkspaceMap } from "../workspace-map";

/** Which way parsePlanDoc failed. The old code collapsed all three into one
 *  identical string, so the synthesis classifier — and the server logs — could
 *  not tell prose-with-no-JSON apart from valid-JSON-with-empty-steps. */
export type PlanParseStage = "no_json_pairs" | "empty_descriptions";

export class PlanParseError extends Error {
  readonly stage: PlanParseStage;
  readonly rawChars: number;
  readonly candidatePairs: number;
  constructor(stage: PlanParseStage, rawChars: number, candidatePairs: number) {
    // Keep the legacy substring so existing assertions and the generic
    // synthesis fallback keep matching; the parenthesised prefix is the new
    // machine-readable detail for logs and future classification.
    super(
      `Plan parse failed (${stage}, ${candidatePairs} candidate pairs in ${rawChars} chars): ` +
        `the plan came back without any usable steps.`,
    );
    this.name = "PlanParseError";
    this.stage = stage;
    this.rawChars = rawChars;
    this.candidatePairs = candidatePairs;
  }
}

/** Total plan attempts per turn: the first try plus exactly one repair re-ask. */
const MAX_PLAN_PARSE_ATTEMPTS = 2;

/** Follow-up for the single repair re-ask. Restates the schema contract the
 *  system prompt already sets; sent as a normal user message through the same
 *  gateway path, not as a prompt transplant. */
const PLAN_REPAIR_PROMPT =
  "Your previous reply could not be parsed as a plan. Reply again with ONLY the JSON object " +
  'using EXACTLY the fields {"plan_summary": "...", "steps": [{"step_id": 1, "description": "...", "tool": ...}]} ' +
  "and no other text: no prose, no markdown, no code fences, no extra fields. Maximum 5 steps.";

/** Produce the plan WITHOUT emitting it.
 *
 *  Split out so the orchestrator can start planning speculatively, in parallel
 *  with intent classification, and only announce the plan once the intent is
 *  confirmed to be a task. A plan streamed for a turn that turns out to be
 *  conversational would put a phantom plan node in the trace. */
export async function generatePlanDoc(
  input: NormalInput,
  hooks?: { onParseRetry?: () => void },
): Promise<PlanDoc> {
  const messages: NimMessage[] = [
    { role: "system", content: PLAN_SYSTEM_PROMPT },
    { role: "user", content: buildPlanUserPrompt(input) },
  ];

  // A compact plan is materially more reliable on a shared 40-RPM pool. Each
  // step needs its own evidence-grounded decision call, so a ten-step website
  // turns into a dozen model requests before synthesis. Five focused steps
  // still cover inspect → write → style → verify without exhausting capacity.
  // Planning is a compact contract, not a hidden-reasoning essay. On the
  // hosted tier a 2,200-token thinking plan was the most common reason a task
  // appeared frozen before its first browser action. Five structured steps fit
  // comfortably in 900 tokens; reserve the larger completion budget for the
  // actual file authoring call where it improves the deliverable.
  //
  // BOTH attempts go through modelGateway.completeText with identical options,
  // so the repair re-ask rides the same queue priority, rate limiter, circuit
  // breaker, and retry budget as the first try — never a bespoke fetch that
  // would silently double effective RPM against the governor.
  const gatewayOpts = {
    tier: tierForRole(input.model, "planner"),
    maxTokens: 900,
    callType: "plan" as const,
    thinking: false,
    budget: input.budget,
    // The configured primary route did not return even a 64-token health
    // response within 70 seconds. Planning is a compact structured contract,
    // while actual source authoring remains on the capable local build worker.
    // Use the healthy fast hosted route here; deterministic schema, scope and
    // verification guards still validate its plan before execution.
    fast: true,
  };
  // Bounded by counter, not by convention: if the model keeps answering in
  // prose despite the repair instruction, the second PlanParseError propagates
  // and the turn fails deterministically instead of looping.
  let pendingMessages: NimMessage[] = messages;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_PLAN_PARSE_ATTEMPTS; attempt += 1) {
    const raw = await modelGateway.completeText(pendingMessages, gatewayOpts);
    try {
      const plan = ensureVerificationStep(normalizeInterfaceWrites(parsePlanDoc(raw), input));
      return exhaustiveBuildTestEnabled() ? stageExhaustiveInterfacePlan(plan, input) : plan;
    } catch (error) {
      if (!(error instanceof PlanParseError)) throw error;
      // Log HERE, with the raw payload in scope. The state-machine catch site
      // only keeps the first 100 chars of the sanitized message, so anything
      // logged there cannot diagnose a parse failure. Server logs only — the
      // raw reply never reaches the browser.
      perf("plan.parseFailed", 0, {
        attempt,
        stage: error.stage,
        rawChars: error.rawChars,
        candidatePairs: error.candidatePairs,
      });
      console.warn(
        `[trion] plan parse attempt ${attempt}/${MAX_PLAN_PARSE_ATTEMPTS} failed ` +
          `(stage=${error.stage}, ${error.candidatePairs} candidate pairs in ${error.rawChars} chars). ` +
          `Raw reply (truncated): ${raw.slice(0, 4000)}`,
      );
      lastError = error;
      // Surface the retry so the progress view reads as active work, not a
      // stall: the first attempt produced prose instead of a plan and the
      // same gateway path is now re-asking for JSON only.
      hooks?.onParseRetry?.();
      pendingMessages = [...messages, { role: "user", content: PLAN_REPAIR_PROMPT }];
    }
  }
  throw lastError;
}

/** Surface an evidence-based default as part of the user-visible plan, rather
 * than burying it in model reasoning. This is local string composition: it
 * costs no second planning request and cannot add an execution step. */
export function withStatedAssumption(plan: PlanDoc, assumption: string | undefined): PlanDoc {
  if (!assumption) return plan;
  return {
    ...plan,
    plan_summary: `Assumption: ${assumption} ${plan.plan_summary}`,
  };
}

/** Stream the plan to the client. Always called BEFORE any tool executes. */
export function emitPlan(planDoc: PlanDoc, emit: (event: StreamEvent) => void): void {
  emit({
    type: "plan",
    plan: {
      summary: sanitize(planDoc.plan_summary),
      steps: planDoc.steps.map((s) => ({
        step_id: s.step_id,
        description: sanitize(s.description),
        state: "pending" as const,
        tool: s.tool,
      })),
    },
  });
}

export async function generatePlan(
  input: NormalInput,
  emit: (event: StreamEvent) => void
): Promise<PlanDoc> {
  const planDoc = await generatePlanDoc(input);
  emitPlan(planDoc, emit);
  return planDoc;
}

function buildPlanUserPrompt(input: NormalInput): string {
  const snapshot = input.workspace_snapshot;
  // Shared assembler — was `slice(-3)` truncated to 200 chars per turn, which
  // silently dropped anything established more than three turns back and cut
  // mid-sentence anything longer than a tweet.
  const conversation = renderContextWindow(
    buildContextWindow(input.conversation_history, CONTEXT_PRESETS.plan)
  );
  const attachments = input.attached_context
    .map((ctx) => frameUntrustedContent(`ATTACHMENT: ${ctx.path ?? "attachment"}`, String(ctx.content ?? "").slice(0, 12_000)))
    .join("\n");
  
  const fileConstraint = explicitFileConstraint(input.user_message);
  return `User request: ${input.user_message}

${fileConstraint}

Workspace snapshot:
- Files: ${snapshot.file_tree.length} files
- Open files: ${snapshot.open_files.join(", ") || "none"}

Workspace map (paths only; use it to choose exact files before planning):
${buildWorkspaceMap(snapshot.file_tree)}

Attached files (user-supplied, available for this turn):
${attachments || "- none"}

Conversation so far:
${conversation}

${exhaustiveBuildTestEnabled() && isInterfaceBuildRequest(input.user_message) ? `
=== EXHAUSTIVE BUILD TEST ===
This is a diagnostic quality run for an interface. Keep the plan to six or fewer concrete steps so the system can visibly complete these separate stages: inspect the relevant entry point, implement the requested outcome, make one dedicated polish pass for hierarchy/responsiveness/interaction states, then run a build or development server. Do not collapse those stages into “make it nice.” Every stage must be traceable by a real tool result.
` : ""}
Produce a plan to fulfill the user's request.`;
}

/**
 * `write_file` replaces a whole file. A plan that writes “hero”, “features” and
 * “CTA” to the same path as separate steps is not progressive—it overwrites
 * itself and multiplies authoring latency. Normalize this structural mistake
 * before the plan becomes an approval/execution contract.
 */
export function normalizeInterfaceWrites(plan: PlanDoc, input: NormalInput): PlanDoc {
  const appEntry = input.workspace_snapshot.file_tree.find((path) => /(?:^|\/)App\.[cm]?[jt]sx?$/i.test(path));
  const visualMarkup = /\b(?:hero|feature|testimonial|cta|call to action|section|landing|page markup|layout)\b/i;
  const metadata = /\b(?:title|meta|favicon|viewport|head)\b/i;
  const pathOf = (description: string) => description.match(/[\w@./-]+\.(?:[cm]?[jt]sx?|css|scss|sass|less|html?)\b/i)?.[0] ?? null;

  const routed = plan.steps.map((step) => {
    if (
      step.tool === "write_file" && appEntry && /\bindex\.html\b/i.test(step.description) &&
      visualMarkup.test(step.description) && !metadata.test(step.description)
    ) {
      return { ...step, description: step.description.replace(/\bindex\.html\b/i, appEntry) };
    }
    return step;
  });

  const merged: PlanDoc["steps"] = [];
  const writeByPath = new Map<string, number>();
  for (const step of routed) {
    const path = step.tool === "write_file" ? pathOf(step.description) : null;
    if (!path) {
      merged.push(step);
      continue;
    }
    const key = path.toLowerCase();
    const existingIndex = writeByPath.get(key);
    if (existingIndex === undefined) {
      writeByPath.set(key, merged.length);
      merged.push(step);
      continue;
    }
    const existing = merged[existingIndex];
    merged[existingIndex] = {
      ...existing,
      description: existing.description.startsWith("Write the complete ")
        ? `${existing.description}; ${step.description}`
        : `Write the complete ${path} in one pass: ${existing.description}; ${step.description}`,
    };
  }

  return {
    ...plan,
    steps: merged.map((step, index) => ({ ...step, step_id: index + 1 })),
  };
}

/** A user-specified file count is a scope contract, not a design suggestion. */
export function explicitFileConstraint(message: string): string {
  // “Exactly one React component file and one CSS file” names two distinct
  // outputs even though the first number is one.
  const pairedComponentAndCss = /\b(?:exactly|only|just)\s+one\s+(?:new\s+)?React\s+(?:component\s+)?file\s+and\s+one\s+CSS\s+file\b/i.test(message);
  if (pairedComponentAndCss) {
    return `=== HARD FILE-SCOPE CONSTRAINT ===
The user explicitly limited this request to exactly 2 files: one React component and one CSS file. The plan MUST contain exactly 2 write_file steps and must not add integration, polish, metadata, or configuration files. Use the app entry component for the React file unless the user named another path. Treat this as a hard contract, not a preference.`;
  }
  const match = message.match(/\b(?:exactly|only|just)\s+(one|two|three|four|\d+)\s+(?:new\s+)?(?:React\s+)?(?:component\s+)?files?\b/i);
  if (!match) return "";
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };
  const count = words[match[1].toLowerCase()] ?? Number(match[1]);
  if (!Number.isFinite(count) || count < 1) return "";
  return `=== HARD FILE-SCOPE CONSTRAINT ===
The user explicitly limited this request to exactly ${count} file${count === 1 ? "" : "s"}. The plan MUST contain exactly ${count} write_file steps, must not add integration, polish, metadata, or configuration files beyond that count, and must name the requested output files. When one React component is requested without a path, modify the app entry component rather than creating an additional component. Treat this as a hard contract, not a preference.`;
}

// "finish" is deliberately absent: the plan prompt never offers it, and a plan
// step carrying it would act as a terminator that ends the turn with no
// approved tool ever running. The executor's action contract already routes a
// genuine no-tool step through tool:null + finish.
const VALID_TOOLS = new Set(["read_file", "search_codebase", "web_fetch", "write_file", "run_command"]);
const MAX_STEPS = 5;
const RUNNABLE_SOURCE = /\.(?:[cm]?[jt]sx?|css|scss|sass|less|html?|vue|svelte|json)$/i;
const VERIFICATION_WORDS = /\b(?:build|test|lint|typecheck|type-check|check|validate|verify|development server|dev server|preview)\b/i;

/**
 * A source-writing task cannot be marked ready without a real check after the
 * final edit. The planner is told this rule, but enforcing it here prevents a
 * malformed or abbreviated plan from leaving the executor with no approved
 * way to verify its own output.
 *
 * This adds no model call by itself. It adds one normal execution decision and
 * command only to runnable coding tasks that would otherwise be unverified.
 */
export function ensureVerificationStep(plan: PlanDoc): PlanDoc {
  const writesRunnableSource = plan.steps.some(
    (step) => step.tool === "write_file" && RUNNABLE_SOURCE.test(step.description),
  );
  const alreadyChecks = plan.steps.some(
    (step) => step.tool === "run_command" && VERIFICATION_WORDS.test(step.description),
  );
  if (!writesRunnableSource || alreadyChecks) return plan;

  const verificationStep = {
    step_id: plan.steps.length + 1,
    description: "Run the project build or development check after the final change",
    tool: "run_command" as const,
  };
  return {
    ...plan,
    plan_summary: `${plan.plan_summary} Includes a final project check before reporting the result ready.`,
    // The planner is capped at MAX_STEPS normal work steps. Verification is a required
    // completion gate, not optional decoration, so it may make the plan one
    // step longer rather than silently dropping a user-visible implementation step.
    steps: [...plan.steps, verificationStep],
  };
}

// ---------------------------------------------------------------------------
// Scaffold-leak guard
//
// The plan prompt forbids describing the workspace as pre-existing, and the
// model MOSTLY complies — which is exactly the problem. "Read the existing web
// app structure to understand the project layout" came back on a later run of
// the same request the rule had already fixed once, so a prompt rule alone
// gives a guarantee that holds until it doesn't.
//
// This is the same stance the rest of this codebase takes toward model output:
// synthesis is checked against the trace rather than believed, and the
// classifier applies heuristics on top of the model's answer. A plan
// description is user-facing product copy, so it gets a deterministic pass too.
// Costs nothing — no tokens, no request, no round trip.
// ---------------------------------------------------------------------------

/** "…to understand the project layout", "…to get a sense of the codebase". */
const ORIENTATION_CLAUSE =
  /\s*,?\s*\b(?:in order\s+)?to\s+(?:better\s+)?(?:understand|underst[ao]nd|familiari[sz]e|orient|assess|survey|review|inspect|examine|see|determine|identify|learn|know|get)\b[^.!?]*/i;

/** Whole phrases naming the workspace as something that was already here. */
const SCAFFOLD_PHRASES: Array<[RegExp, string]> = [
  [/\b(?:the\s+)?(?:existing|current|pre-?configured|already[-\s]set[-\s]up)\s+(?:web\s+)?(?:app|application|project|codebase|workspace|repo(?:sitory)?)(?:'s)?\s+(?:structure|layout|setup|configuration|organi[sz]ation|scaffold(?:ing)?|boilerplate|template|files?)\b/gi, "the page layout"],
  [/\b(?:the\s+)?(?:project|codebase|workspace|repo(?:sitory)?)\s+(?:structure|layout|organi[sz]ation|scaffold(?:ing)?|boilerplate)\b/gi, "the page layout"],
  // The determiner is REQUIRED here, unlike the rules above.
  //
  // "scaffold" is a verb as often as a noun, and "scaffold the app" is a
  // perfectly good instruction. Making "the" optional rewrote it to "the page
  // the app". Only the noun sense — "the scaffold", "this boilerplate" — names
  // something that predates the request.
  [/\b(?:the|this|that|an?)\s+(?:scaffold(?:ing)?|boilerplate|starter(?:\s+template)?|template\s+files?)\b/gi, "the page"],
];

/** Bare adjectives implying the thing predates the request. Only stripped in
 *  front of workspace nouns, so "the current value of the counter" survives. */
const PREEXISTING_ADJECTIVE =
  /\b(existing|current|pre-?configured)\s+(?=(?:web\s+)?(?:app|application|project|codebase|workspace|repo(?:sitory)?|file|files|component|structure|layout|setup)\b)/gi;

/**
 * Rewrite one step description so it describes the WORK, not a tour of what was
 * already in the sandbox.
 *
 * Conservative by construction: it only removes orientation language and
 * renames the workspace. A description that never mentioned the scaffold passes
 * through byte-identical.
 */
export function deScaffold(description: string): string {
  let out = description.replace(ORIENTATION_CLAUSE, "");
  for (const [pattern, replacement] of SCAFFOLD_PHRASES) out = out.replace(pattern, replacement);
  out = out.replace(PREEXISTING_ADJECTIVE, "");
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([.,;:])/g, "$1").trim();

  // Stripping can leave a stub ("Read the", "Inspect"). A stub is worse than
  // the leak, so fall back to something that is at least true of any read step.
  if (out.length < 8 || /\b(?:read|inspect|review|check|examine|survey)\s*(?:the)?$/i.test(out)) {
    return "Check the current page";
  }
  return out;
}

/**
 * Parse and REPAIR the planner's JSON.
 *
 * A malformed plan used to throw, which the state machine caught as a turn
 * failure — so an otherwise fine request died at step 2 with "Invalid plan
 * structure" and the user never learned that only the punctuation was wrong.
 * Everything recoverable is recovered here; only a reply with no usable steps
 * at all is a real failure.
 */
export function parsePlanDoc(raw: string): PlanDoc {
  const text = raw.trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  let parsed: Partial<PlanDoc> | null = null;
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1)) as Partial<PlanDoc>;
    } catch {
      parsed = null;
    }
  }

  // A plan cut off mid-array still contains complete steps. Salvage them rather
  // than discarding the whole turn: the alternative is a hard failure whose
  // message ("no usable steps") tells the user nothing they can act on.
  const rawSteps = Array.isArray(parsed?.steps) ? parsed.steps : salvageSteps(text);
  const steps: PlanDoc["steps"] = [];
  for (const candidate of rawSteps) {
    if (steps.length >= MAX_STEPS) break;
    if (!candidate || typeof candidate !== "object") continue;
    const rawDescription = typeof candidate.description === "string" ? candidate.description.trim() : "";
    if (!rawDescription) continue;
    // Deterministic guard — the prompt asks, this enforces.
    const description = deScaffold(rawDescription);
    const tool = typeof candidate.tool === "string" && VALID_TOOLS.has(candidate.tool) ? candidate.tool : null;
    // Renumber unconditionally: models skip and repeat step_ids, and the
    // executor keys plan_update events off them, so duplicates made two UI rows
    // update as one.
    steps.push({ step_id: steps.length + 1, description, tool });
  }

  if (steps.length === 0) {
    throw new PlanParseError(
      rawSteps.length === 0 ? "no_json_pairs" : "empty_descriptions",
      text.length,
      rawSteps.length,
    );
  }

  const summary = typeof parsed?.plan_summary === "string" && parsed.plan_summary.trim()
    ? parsed.plan_summary.trim()
    : steps[0].description;

  return { plan_summary: summary, steps };
}

/** Pull whole `{ "description": …, "tool": … }` objects out of a response whose
 *  JSON is unbalanced (usually a truncated steps array). */
function salvageSteps(text: string): Array<{ description?: unknown; tool?: unknown }> {
  const salvaged: Array<{ description?: unknown; tool?: unknown }> = [];
  for (const match of text.matchAll(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"tool"\s*:\s*(?:"([^"]*)"|null)/g)) {
    let description: string;
    try {
      description = JSON.parse(`"${match[1]}"`) as string;
    } catch {
      description = match[1];
    }
    salvaged.push({ description, tool: match[2] ?? null });
  }
  return salvaged;
}
