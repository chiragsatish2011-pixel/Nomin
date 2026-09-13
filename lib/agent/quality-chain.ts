// Selective, evidence-first review roles.
//
// This module deliberately has no dependency on the executor or tool runner.
// Critics call completeText with a fixed JSON schema, so there is no action
// parser and no route by which a critic can mutate the workspace.

import type { AgentTurn, NimMessage, NormalInput, PlanDoc, SynthesisDoc, ToolTraceEntry, VerificationSummary } from "./types";
import { modelGateway } from "./model-gateway";
import { tierForRole } from "./model-tiers";
import { CODING_CRITIC_SYSTEM_PROMPT, CODING_SYNTHESIZER_SYSTEM_PROMPT, DESIGN_CRITIC_SYSTEM_PROMPT, DESIGN_SYNTHESIZER_SYSTEM_PROMPT } from "./static-prompts";
import { sanitize } from "./sanitize";

export type ReviewRole = "proposer" | "critic" | "synthesizer";

/**
 * Framework-level role capability declaration. Critics do not get an executor
 * or tool schema at runtime; this read-only list is an audit contract for the
 * evidence they may be supplied. In particular it contains no write or command
 * capability, which is enforced by using `completeText`, not `complete`.
 */
export const ROLE_TOOL_ACCESS: Record<ReviewRole, readonly string[]> = {
  proposer: ["read_file", "search_codebase", "write_file", "run_command"],
  critic: ["read_tool_trace", "read_file", "view_diff", "run_read_only_check"],
  synthesizer: ["read_file", "search_codebase", "write_file", "run_command"],
};

export type CodingReview = {
  verdict: "pass" | "qualify";
  findings: string[];
  corrected_claim: string;
};

export type DesignReview = {
  verdict: "pass" | "revise";
  violations: string[];
  revision_brief: string;
};

/** Never review conversation, plans, one-file changes, or unchecked failures. */
export function shouldRunCodingReview(
  input: NormalInput,
  plan: PlanDoc | null,
  trace: ToolTraceEntry[],
  verification: VerificationSummary | null | undefined
): boolean {
  if (process.env.TRION_CODING_REVIEW === "0") return false;
  return input.mode === "execute" &&
    Boolean(plan && plan.steps.length > 1) &&
    trace.filter((entry) => entry.tool_name === "write_file" && entry.status === "success").length > 1 &&
    verification?.status === "passed";
}

/** UI review is equally narrow and does not run for copy-only or single-file work. */
export function shouldRunDesignReview(input: NormalInput, plan: PlanDoc | null, trace: ToolTraceEntry[]): boolean {
  // A complete build is more valuable than an optional extra reviewer pass.
  // The free NIM tier shares roughly 40 RPM account-wide, so this expensive
  // chain is opt-in rather than silently consuming the calls needed to write
  // files, start the app, and verify it.
  if (process.env.TRION_DESIGN_REVIEW !== "1") return false;
  const visualRequest = /\b(?:website|web\s*page|landing\s*page|dashboard|ui|interface|frontend|front-end|react\s*(?:app|page|site)|portfolio|marketing\s*site)\b/i.test(input.user_message);
  return input.mode === "execute" && visualRequest && Boolean(plan && plan.steps.length > 2) &&
    trace.filter((entry) => entry.tool_name === "write_file" && entry.status === "success").length > 1;
}

/** The actual three-role coding completion chain: existing synthesis → critic → corrected synthesis. */
export async function reviewCodingCompletion(args: {
  input: NormalInput;
  plan: PlanDoc;
  trace: ToolTraceEntry[];
  verification: VerificationSummary;
  proposed: SynthesisDoc;
}): Promise<{ result: SynthesisDoc; critic: CodingReview }> {
  const critic = await runCodingCritic(args);
  const messages: NimMessage[] = [
    { role: "system", content: CODING_SYNTHESIZER_SYSTEM_PROMPT },
    {
      role: "user",
      content: `User request:\n${args.input.user_message}\n\nProposed completion:\n${args.proposed.message}\n\nCritic verdict:\n${JSON.stringify(critic)}\n\nEvidence:\n${traceEvidence(args.trace, args.plan, args.verification)}`,
    },
  ];

  try {
    const raw = await modelGateway.completeText(messages, {
      tier: tierForRole(args.input.model, "verifier"),
      fast: true,
      maxTokens: 900,
      callType: "coding_synthesizer",
      thinking: false,
      budget: args.input.budget,
    });
    const result = parseSynthesis(raw);
    return { result: result ?? qualifiedFallback(args.proposed, critic), critic };
  } catch {
    // A reviewer must never turn an otherwise complete result into a failed
    // turn. Preserve the factual proposer result, but attach qualification when
    // the critic found missing evidence.
    return { result: qualifiedFallback(args.proposed, critic), critic };
  }
}

/** Read-only UI checklist call. The executor can use this result to author a revision and re-check it once. */
export async function runDesignCritic(args: {
  input: NormalInput;
  plan: PlanDoc;
  trace: ToolTraceEntry[];
  sourcePath: string;
  source: string;
  previousViolations?: string[];
  recheck?: boolean;
}): Promise<DesignReview> {
  // The critic needs enough source to inspect the visual structure, not a
  // whole generated landing page. Keeping this under the review input budget
  // avoids a large revision making the mandatory re-check time out before it
  // can inspect the original violations.
  const source = args.source.length > 8_000 ? `${args.source.slice(0, 8_000)}\n/* excerpt truncated */` : args.source;
  const messages: NimMessage[] = [
    { role: "system", content: DESIGN_CRITIC_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Request: ${args.input.user_message}\nFile: ${args.sourcePath}\n${args.recheck ? `Previously flagged violations (re-check only these): ${args.previousViolations?.join(" | ") || "none"}\n` : ""}\nSource:\n${source}\n\nExecution evidence:\n${traceEvidence(args.trace, args.plan)}`,
    },
  ];
  try {
    const raw = await modelGateway.completeText(messages, {
      tier: tierForRole(args.input.model, "verifier"),
      fast: false,
      maxTokens: 700,
      callType: args.recheck ? "design_recheck" : "design_critic",
      thinking: false,
      budget: args.input.budget,
    });
    return parseDesignReview(raw) ?? { verdict: "pass", violations: [], revision_brief: "" };
  } catch {
    // An initial review may safely decline to create a fictional violation, but
    // a requested re-check must never be treated as evidence that a revision
    // landed. Keeping it in `revise` makes the missing inspection explicit to
    // the caller and prevents a timeout from becoming a false green check.
    return args.recheck
      ? { verdict: "revise", violations: ["The revised source could not be re-checked because the review request did not complete."], revision_brief: "Retry the read-only re-check before reporting this design issue resolved." }
      : { verdict: "pass", violations: [], revision_brief: "" };
  }
}

/**
 * The only mutating role in the UI chain. The executor validates both the
 * action and path before the normal tool boundary is allowed to run it.
 */
export async function proposeDesignRevision(args: {
  input: NormalInput;
  sourcePath: string;
  source: string;
  review: DesignReview;
}): Promise<AgentTurn | null> {
  const messages: NimMessage[] = [
    { role: "system", content: DESIGN_SYNTHESIZER_SYSTEM_PROMPT },
    {
      role: "user",
      content: `User request: ${args.input.user_message}\n\nApproved target path: ${args.sourcePath}\n\nCurrent complete source:\n${args.source}\n\nCritic findings to fix:\n${args.review.violations.map((item) => `- ${item}`).join("\n")}\n\nRevision brief: ${args.review.revision_brief}`,
    },
  ];
  try {
    const candidate = await modelGateway.complete(messages, {
      tier: tierForRole(args.input.model, "executor"),
      // The critic has already narrowed this to one source file and a short
      // list of concrete defects. Reserving the full authoring budget here
      // repeatedly timed out in live measurement without returning JSON. A
      // 2,200 tokens leaves room for a complete standalone page response and
      // its JSON envelope. This is still far below unrestricted authoring and
      // happens only after a concrete critic violation.
      // if a genuinely larger file needs redesign, the normal approved write
      // path remains available rather than keeping a review turn hostage.
      maxTokens: 2_200,
      callType: "design_synthesizer",
      thinking: false,
      budget: args.input.budget,
      // The critic supplies a short, concrete rewrite brief. The focused
      // writer completes reliably within the review window; its output is
      // never trusted without the targeted critic re-check that follows.
      fast: true,
      reliability: { timeoutMs: 45_000, maxAttempts: 1 },
    });
    const content = candidate.action_input.content;
    // Do not let a visual review silently transform a React component into a
    // standalone document (observed in real review traffic). This is an
    // invariant enforced before the executor receives any writable action.
    if (
      candidate.action !== "write_file" ||
      candidate.action_input.path !== args.sourcePath ||
      typeof content !== "string" ||
      !preservesSourceFormat(args.source, content)
    ) return null;
    return candidate;
  } catch {
    return null;
  }
}

function preservesSourceFormat(original: string, revision: string): boolean {
  const reactModule = /\b(?:export\s+default|import\s+.+?from)\b/.test(original);
  if (!reactModule) return true;
  return /\b(?:export\s+default|import\s+.+?from)\b/.test(revision) && !/<html[\s>]/i.test(revision);
}

export async function runCodingCritic(args: {
  input: NormalInput;
  plan: PlanDoc;
  trace: ToolTraceEntry[];
  verification: VerificationSummary;
  proposed: SynthesisDoc;
}): Promise<CodingReview> {
  const messages: NimMessage[] = [
    { role: "system", content: CODING_CRITIC_SYSTEM_PROMPT },
    {
      role: "user",
      content: `User request:\n${args.input.user_message}\n\nProposed completion:\n${args.proposed.message}\n\nExecution evidence:\n${traceEvidence(args.trace, args.plan, args.verification)}`,
    },
  ];
  try {
    const raw = await modelGateway.completeText(messages, {
      tier: tierForRole(args.input.model, "verifier"),
      fast: true,
      maxTokens: 600,
      callType: "coding_critic",
      thinking: false,
      budget: args.input.budget,
    });
    return parseCodingReview(raw) ?? deterministicCodingReview(args);
  } catch {
    return deterministicCodingReview(args);
  }
}

function traceEvidence(trace: ToolTraceEntry[], plan: PlanDoc, verification?: VerificationSummary): string {
  const rows = trace.slice(-32).map((entry) => {
    const target = typeof entry.input.path === "string"
      ? ` path=${entry.input.path}`
      : typeof entry.input.command === "string" ? ` command=${entry.input.command}` : "";
    return `step ${entry.step_id} ${entry.tool_name} ${entry.status}${target}`;
  });
  return `Approved plan (${plan.steps.length} steps): ${plan.steps.map((step) => `${step.step_id}:${step.tool ?? "reason"}`).join(", ")}\n` +
    `Trace:\n${rows.join("\n") || "(empty)"}\n` +
    (verification ? `Verification: ${verification.status}; ${verification.message}` : "Verification: not supplied");
}

function deterministicCodingReview(args: { plan: PlanDoc; trace: ToolTraceEntry[]; verification: VerificationSummary; proposed: SynthesisDoc }): CodingReview {
  const findings: string[] = [];
  if (args.verification.required && args.verification.status !== "passed") {
    findings.push("Runnable code changed without successful post-change verification.");
  }
  const written = new Set(args.trace.filter((entry) => entry.tool_name === "write_file" && entry.status === "success").map((entry) => String(entry.input.path ?? "")));
  const namedWrites = args.plan.steps.filter((step) => step.tool === "write_file" && /[\w.-]+\.[a-z]{1,5}\b/i.test(step.description));
  if (namedWrites.some((step) => ![...written].some((path) => step.description.includes(path)))) {
    findings.push("At least one named write step has no matching successful file-write evidence.");
  }
  return {
    verdict: findings.length ? "qualify" : "pass",
    findings,
    corrected_claim: findings.length ? "Report the work as unverified and name the outstanding check." : "Evidence supports the proposed completion.",
  };
}

function parseCodingReview(raw: string): CodingReview | null {
  const parsed = parseObject(raw);
  if (!parsed || (parsed.verdict !== "pass" && parsed.verdict !== "qualify")) return null;
  return {
    verdict: parsed.verdict,
    findings: Array.isArray(parsed.findings) ? parsed.findings.filter((item): item is string => typeof item === "string").slice(0, 6).map(sanitize) : [],
    corrected_claim: typeof parsed.corrected_claim === "string" ? sanitize(parsed.corrected_claim) : "",
  };
}

function parseDesignReview(raw: string): DesignReview | null {
  const parsed = parseObject(raw);
  if (!parsed || (parsed.verdict !== "pass" && parsed.verdict !== "revise")) return null;
  return {
    verdict: parsed.verdict,
    violations: Array.isArray(parsed.violations) ? parsed.violations.filter((item): item is string => typeof item === "string").slice(0, 6).map(sanitize) : [],
    revision_brief: typeof parsed.revision_brief === "string" ? sanitize(parsed.revision_brief) : "",
  };
}

function parseSynthesis(raw: string): SynthesisDoc | null {
  const parsed = parseObject(raw);
  if (!parsed || typeof parsed.message !== "string" || !parsed.message.trim()) return null;
  return {
    message: sanitize(parsed.message),
    next_action_hint: typeof parsed.next_action_hint === "string" ? sanitize(parsed.next_action_hint) : undefined,
  };
}

function parseObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function qualifiedFallback(proposed: SynthesisDoc, critic: CodingReview): SynthesisDoc {
  if (critic.verdict === "pass") return proposed;
  const note = critic.findings.length ? `\n\nVerification note: ${critic.findings.join(" ")}` : "\n\nVerification note: I can’t confirm every claimed result yet.";
  return { message: `${proposed.message}${note}`, next_action_hint: proposed.next_action_hint ?? "Run the project verification command before relying on the result." };
}
