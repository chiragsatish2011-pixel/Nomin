// Single entry point for ALL model calls
// Hides NIM completely; routes by tier; sanitizes I/O

import type { AgentTurn, NimMessage, TrionTier } from "./types";
import { queuedCompletion, queuedTextCompletion } from "@/lib/nim/internal-client";
import { sanitize, assertNoLeaks } from "./sanitize";
import { perf, estTokensOf } from "./perf";
import { STATIC_SYSTEM_PROMPTS } from "./static-prompts";
import { recordUsage, type CallType } from "./token-ledger";

export interface ModelOptions {
  tier: TrionTier;
  maxTokens?: number;
  temperature?: number;
  /** Use the fast fallback model (intent/synthesis — no heavy reasoning needed). */
  fast?: boolean;
  /** Ask the model to emit chain-of-thought before answering. Off for calls
   *  whose answer is mechanical; on only where the decision is ambiguous.
   *  Undefined leaves the provider default alone. */
  thinking?: boolean;
  /** Permit a text caller to validate/salvage a provider-truncated prefix. */
  allowTruncated?: boolean;
  /** Which call in the loop this is. Attributes real token spend per stage. */
  callType?: CallType;
  /**
   * A small number of calls are materially different from the usual decision
   * shape. In particular, choosing a full `write_file` body needs time to
   * generate it; it must not inherit the timeout of a read-path selection.
   * This remains a bounded policy, not an open-ended wait.
   */
  reliability?: { timeoutMs: number; maxAttempts: number };
  /** Internal audit callback. The route is stripped before AgentOutput reaches
   * the browser, so provider identity never becomes user-facing content. */
  onRoute?: (route: "hosted" | "gemini") => void;
  onFallback?: (from: "hosted" | "gemini", to: "hosted" | "gemini") => void;
}

/**
 * A model call that has already exceeded its useful interactive window must
 * not silently hold the whole turn hostage.  These are *total attempts* — an
 * execution decision gets one fresh retry, not five identical timeout loops.
 *
 * This lowers worst-case latency and request spend. It does not add any calls
 * on the healthy path (one request per decision remains one request).
 */
export const CALL_RELIABILITY: Record<CallType, { timeoutMs: number; maxAttempts: number }> = {
  classification: { timeoutMs: 15_000, maxAttempts: 1 },
  direct_answer: { timeoutMs: 20_000, maxAttempts: 1 },
  plan: { timeoutMs: 45_000, maxAttempts: 2 },
  plan_only: { timeoutMs: 30_000, maxAttempts: 1 },
  execution_decision: { timeoutMs: 30_000, maxAttempts: 2 },
  synthesis: { timeoutMs: 30_000, maxAttempts: 1 },
  synthesis_fallback: { timeoutMs: 20_000, maxAttempts: 1 },
  // Review roles run only after a substantial deliverable. Their prompts and
  // outputs are deliberately small, so a bounded single attempt is both less
  // expensive and safer than retrying a subjective review.
  coding_critic: { timeoutMs: 20_000, maxAttempts: 1 },
  coding_synthesizer: { timeoutMs: 25_000, maxAttempts: 1 },
  design_critic: { timeoutMs: 20_000, maxAttempts: 1 },
  design_synthesizer: { timeoutMs: 30_000, maxAttempts: 1 },
  design_recheck: { timeoutMs: 20_000, maxAttempts: 1 },
  judge: { timeoutMs: 30_000, maxAttempts: 1 },
};

// AUDIT NOTE (tier right-sizing).
//
// This table used to carry a `model` field on every tier, all three set to the
// same upstream model — and nothing ever read it. The concrete model was chosen
// downstream, in internal-client, purely from the boolean `fast` flag. So the
// tier labels were decorative: "trion-1.4 for classification and low-ambiguity
// decisions" was configured but not happening, because the tier never reached
// the thing that picks a model.
//
// The field is gone rather than corrected-in-place, so it cannot silently rot
// back into a lie. Model selection is now exactly one decision, made per CALL,
// by the `fast` flag that the call sites set deliberately — see the routing
// comments in step-runner (execution), classifier (always fast) and synthesis
// (fast with a full-model fallback).
const TIER_CONFIG: Record<TrionTier, { maxTokens: number; temperature: number }> = {
  "trion-1.4": { maxTokens: 4096, temperature: 0.15 },
  "trion-1.9": { maxTokens: 2048, temperature: 0.2 },
  "trion-2.3": { maxTokens: 2048, temperature: 0.2 },
};

/**
 * Hard input ceilings per call type, in tokens.
 *
 * A free tier is a request budget as much as a token budget, and a single
 * pathology — a 200KB file read echoed back into six decision calls, a tool
 * description that grew unnoticed — can burn a day's credits inside one turn.
 * These are backstops, not tuning knobs: each is set well above the p100 the
 * benchmark suite actually produces for that call type, so they never bind on
 * healthy traffic and always bind on a runaway.
 *
 * Measured p100 on the 11-case coding suite + 13-case speed suite (baseline):
 * classification 937, plan 895, execution_decision ~2.0k, synthesis ~1.5k.
 */
const INPUT_TOKEN_BUDGET: Record<CallType, number> = {
  classification: 1_500,
  plan: 3_000,
  execution_decision: 8_000,
  synthesis: 5_000,
  synthesis_fallback: 5_000,
  coding_critic: 3_000,
  coding_synthesizer: 4_000,
  design_critic: 3_500,
  design_synthesizer: 6_000,
  design_recheck: 3_000,
  judge: 4_000,
  plan_only: 3_500,
  direct_answer: 3_000,
};

/**
 * Queue priority per call type. LOWER RUNS FIRST.
 *
 * Under a request-rate ceiling the queue is genuinely deep, so this ordering
 * decides perceived latency. Classification goes first because nothing the user
 * can see happens until it returns, and it is the cheapest call in the loop.
 * Synthesis goes last because by the time it runs the work is already done and
 * the trace is already on screen — it is the one call the user is not staring
 * at a blank panel waiting for.
 */
const CALL_PRIORITY: Record<CallType, number> = {
  classification: 0,
  plan: 1,
  execution_decision: 2,
  direct_answer: 2,
  plan_only: 3,
  synthesis: 4,
  synthesis_fallback: 4,
  coding_critic: 3,
  coding_synthesizer: 4,
  design_critic: 3,
  design_synthesizer: 3,
  design_recheck: 3,
  judge: 5,
};

function estimateMessageTokens(message: NimMessage): number {
  return Math.ceil(message.content.length / 4);
}

/**
 * Bring a message array under its call type's ceiling.
 *
 * What may be sacrificed, in order: the OLDEST context messages, which are the
 * ones the context assembler already considers most droppable. What may never
 * be: the system prompt (it is the instructions), and the last user message (it
 * is the request). If trimming everything droppable still leaves the call over
 * budget, the call proceeds and says so loudly — refusing to answer a large
 * legitimate request would be a worse failure than paying for it once.
 */
function enforceInputBudget(messages: NimMessage[], callType: CallType): NimMessage[] {
  const budget = INPUT_TOKEN_BUDGET[callType];
  let total = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  if (total <= budget) return messages;

  const kept = [...messages];
  const isProtected = (index: number) => kept[index].role === "system" || index === kept.length - 1;

  let dropped = 0;
  for (let i = 0; i < kept.length && total > budget; ) {
    if (isProtected(i)) {
      i += 1;
      continue;
    }
    total -= estimateMessageTokens(kept[i]);
    kept.splice(i, 1);
    dropped += 1;
  }

  perf("gateway.budgetEnforced", 0, { callType, budget, droppedMessages: dropped, overBudget: total > budget, finalTokens: total });
  if (total > budget) {
    console.warn(`[trion] ${callType} call is ${total} tokens against a ${budget} budget after trimming everything droppable.`);
  }
  return kept;
}

// Every system prompt the agent loop may send, pre-hashed. A call whose system
// message matches one of these has a byte-identical, cacheable prefix — the
// provider can reuse a cached prefix and the model sees stable instructions.
const STATIC_PROMPT_HASHES = new Set<string>(STATIC_SYSTEM_PROMPTS.map(hashString));

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

function getTierConfig(tier: TrionTier) {
  return TIER_CONFIG[tier] || TIER_CONFIG["trion-1.4"];
}

function promptCacheMeta(messages: NimMessage[]): { promptCacheStable: boolean; sysTokens: number } {
  const system = messages.find((message) => message.role === "system");
  const promptCacheStable = system !== undefined && STATIC_PROMPT_HASHES.has(hashString(system.content));
  return { promptCacheStable, sysTokens: system ? estTokensOf([system]) : 0 };
}

/** Bridge the provider's usage block into the session ledger. Measurement only. */
function usageSink(opts: ModelOptions, messages: NimMessage[]) {
  const { promptCacheStable } = promptCacheMeta(messages);
  return (usage: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
    ms: number;
  }) => {
    recordUsage({
      callType: opts.callType ?? "execution_decision",
      model: usage.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedPromptTokens: usage.cachedPromptTokens,
      promptCacheStable,
      thinking: opts.thinking === true,
      ms: usage.ms,
    });
  };
}

export const modelGateway = {
  async complete(rawMessages: NimMessage[], opts: ModelOptions): Promise<AgentTurn> {
    const config = getTierConfig(opts.tier);
    const maxTokens = opts.maxTokens ?? config.maxTokens;
    const messages = enforceInputBudget(rawMessages, opts.callType ?? "execution_decision");

    const callType = opts.callType ?? "execution_decision";
    const reliability = opts.reliability ?? CALL_RELIABILITY[callType];
    const start = Date.now();
    const raw = await queuedCompletion(messages, maxTokens, {
      fast: opts.fast ?? false,
      tier: opts.tier,
      temperature: opts.temperature ?? config.temperature,
      thinking: opts.thinking,
      allowTruncated: opts.allowTruncated,
      priority: CALL_PRIORITY[callType],
      label: callType,
      timeoutMs: reliability.timeoutMs,
      maxAttempts: reliability.maxAttempts,
      onRoute: opts.onRoute,
      onFallback: opts.onFallback,
      onUsage: usageSink(opts, messages),
    });
    perf("model.complete", Date.now() - start, {
      tier: opts.tier,
      fast: opts.fast ?? false,
      inputTokens: estTokensOf(messages),
      messages: messages.length,
      maxTokens,
      ...promptCacheMeta(messages),
    });

    // Sanitize the response
    const sanitizedTurn = sanitizeAgentTurn(raw);
    
    // Assert no leaks
    assertNoLeaks(JSON.stringify(sanitizedTurn), `model response (${opts.tier})`);
    
    return sanitizedTurn;
  },

  async completeText(rawMessages: NimMessage[], opts: ModelOptions): Promise<string> {
    const config = getTierConfig(opts.tier);
    const maxTokens = opts.maxTokens ?? config.maxTokens;
    const messages = enforceInputBudget(rawMessages, opts.callType ?? "synthesis");

    const callType = opts.callType ?? "synthesis";
    const reliability = opts.reliability ?? CALL_RELIABILITY[callType];
    const start = Date.now();
    const raw = await queuedTextCompletion(messages, maxTokens, {
      fast: opts.fast ?? false,
      tier: opts.tier,
      temperature: opts.temperature ?? config.temperature,
      thinking: opts.thinking,
      allowTruncated: opts.allowTruncated,
      priority: CALL_PRIORITY[callType],
      label: callType,
      timeoutMs: reliability.timeoutMs,
      maxAttempts: reliability.maxAttempts,
      onRoute: opts.onRoute,
      onFallback: opts.onFallback,
      onUsage: usageSink(opts, messages),
    });
    perf("model.completeText", Date.now() - start, {
      tier: opts.tier,
      fast: opts.fast ?? false,
      inputTokens: estTokensOf(messages),
      messages: messages.length,
      maxTokens,
      ...promptCacheMeta(messages),
    });
    
    // Sanitize the response
    const sanitized = sanitize(raw);
    
    // Assert no leaks
    assertNoLeaks(sanitized, `model text (${opts.tier})`);
    
    return sanitized;
  },
};

function sanitizeAgentTurn(turn: AgentTurn): AgentTurn {
  return {
    ...turn,
    thought: sanitize(turn.thought),
    summary: turn.summary ? sanitize(turn.summary) : undefined,
    action_input: sanitizeObject(turn.action_input) as Record<string, unknown>,
  };
}

function sanitizeObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return sanitize(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      out[key] = sanitizeObject(value);
    }
    return out;
  }
  return obj;
}
