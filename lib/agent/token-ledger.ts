// Real per-call token accounting for the agent loop.
//
// Everything here is MEASUREMENT, not behaviour: nothing in this module changes
// what is sent to a model or what comes back. It exists because
// "tokens per completed task" cannot be optimised against an estimate — the
// char/4 approximation in perf.ts is off by a wide margin on JSON-heavy
// payloads, and it cannot see completion tokens at all (a reasoning model can
// spend 200 output tokens thinking before emitting 19 tokens of answer, and the
// estimator would report 19).
//
// The provider returns a real `usage` block on every completion. This module is
// where it lands, keyed by session, tagged by which call in the loop spent it.

import { AsyncLocalStorage } from "node:async_hooks";

/** Which call in the loop spent the tokens. Used to attribute cost per stage. */
export type CallType =
  | "classification"
  | "plan"
  | "plan_tools"
  | "execution_decision"
  | "synthesis"
  | "synthesis_fallback"
  | "coding_critic"
  | "coding_synthesizer"
  | "design_critic"
  | "design_synthesizer"
  | "design_recheck"
  | "judge"
  | "plan_only"
  | "direct_answer";

export type UsageRecord = {
  callType: CallType;
  /** Concrete model the provider billed, not the Trion tier label. */
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Provider-reported cached prefix tokens, when it reports any. */
  cachedPromptTokens: number;
  /** Whether the system prefix was one of the byte-identical static prompts. */
  promptCacheStable: boolean;
  /** Whether the call asked the model to emit chain-of-thought. */
  thinking: boolean;
  ms: number;
  at: number;
};

export type SessionLedger = {
  sessionId: string;
  records: UsageRecord[];
};

// Pinned to globalThis, not a plain module-level Map.
//
// In dev, an edit anywhere in the agent module graph hot-reloads this module,
// and the readout route can end up holding a DIFFERENT instance from the one
// the turn wrote to — which reports a turn that really cost 8,000 tokens as
// having made zero calls. A benchmark that silently reads zero is worse than no
// benchmark, so the store outlives module identity.
const globalStore = globalThis as typeof globalThis & { __trionLedgers?: Map<string, SessionLedger> };
const ledgers: Map<string, SessionLedger> = (globalStore.__trionLedgers ??= new Map());

/** Session attribution is ambient — the gateway does not thread a sessionId
 *  through every call site. AsyncLocalStorage rather than a module-level
 *  variable because the model queue runs up to six calls concurrently: a plain
 *  "current session" global cross-attributes tokens between overlapping turns,
 *  which would silently corrupt exactly the per-task numbers this exists to
 *  produce. Anything recorded outside a scope lands in "unattributed". */
const scope = new AsyncLocalStorage<string>();

export function withLedgerSession<T>(sessionId: string, fn: () => T): T {
  return scope.run(sessionId || "unattributed", fn);
}

export function recordUsage(record: Omit<UsageRecord, "at">) {
  const sessionId = scope.getStore() ?? "unattributed";
  const ledger = ledgers.get(sessionId) ?? { sessionId, records: [] };
  ledger.records.push({ ...record, at: Date.now() });
  ledgers.set(sessionId, ledger);
}

export function getLedger(sessionId: string): SessionLedger | undefined {
  return ledgers.get(sessionId);
}

export function resetLedger(sessionId: string) {
  ledgers.delete(sessionId);
}

/** Privacy-preserving capacity view for the product UI. It intentionally does
 * not expose raw token counts, provider model ids, costs, or hidden reasoning.
 * Providers do not expose a portable daily/weekly allowance through this
 * server-side ledger, so this reports only Trion's observed activity and the model's configured
 * context pressure. */
export function capacityOverview(now = new Date(), sessionId?: string) {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 6);
  const all = [...ledgers.values()].flatMap((ledger) => ledger.records);
  const today = all.filter((record) => record.at >= todayStart.getTime());
  const week = all.filter((record) => record.at >= weekStart.getTime());
  const contextRecords = sessionId ? ledgers.get(sessionId)?.records ?? [] : all;
  const latest = contextRecords.at(-1);
  const latestContext = latest ? latest.promptTokens + latest.completionTokens : 0;
  const contextRatio = Math.min(1, latestContext / 262_144);
  const context = contextRatio < 0.15 ? "Light" : contextRatio < 0.5 ? "Comfortable" : contextRatio < 0.8 ? "Busy" : "Near capacity";
  const activity = (records: UsageRecord[]) => records.length === 0 ? "No activity yet" : records.length < 12 ? "Light activity" : records.length < 40 ? "Active" : "High activity";
  return {
    today: activity(today),
    week: activity(week),
    context,
    allowance: "Longer-term limits are not exposed by the connected service. Trion will show a clear warning if capacity affects a request.",
  };
}

export type LedgerTotals = {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  ms: number;
  byCallType: Record<string, { calls: number; promptTokens: number; completionTokens: number; ms: number }>;
  byModel: Record<string, { calls: number; promptTokens: number; completionTokens: number }>;
};

export function totalsFor(sessionId: string): LedgerTotals {
  const records = ledgers.get(sessionId)?.records ?? [];
  const totals: LedgerTotals = {
    calls: records.length,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    ms: 0,
    byCallType: {},
    byModel: {},
  };

  for (const record of records) {
    totals.promptTokens += record.promptTokens;
    totals.completionTokens += record.completionTokens;
    totals.cachedPromptTokens += record.cachedPromptTokens;
    totals.ms += record.ms;

    const stage = (totals.byCallType[record.callType] ??= { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0 });
    stage.calls += 1;
    stage.promptTokens += record.promptTokens;
    stage.completionTokens += record.completionTokens;
    stage.ms += record.ms;

    const model = (totals.byModel[record.model] ??= { calls: 0, promptTokens: 0, completionTokens: 0 });
    model.calls += 1;
    model.promptTokens += record.promptTokens;
    model.completionTokens += record.completionTokens;
  }

  totals.totalTokens = totals.promptTokens + totals.completionTokens;
  return totals;
}

// ---------------------------------------------------------------------------
// Cost
//
// The hosted endpoint this project uses (build.nvidia.com) meters the developer
// tier in REQUEST CREDITS, not tokens — there is no per-token price on the free
// tier at all. To report a comparable dollar figure the ledger uses published
// per-token reference rates for the same two models, and reports the credit /
// request count alongside it. Both numbers are stated in the report; neither is
// presented as the other.
// ---------------------------------------------------------------------------

/** USD per 1M tokens. Reference rates for the same model on a token-metered
 *  host; see the report for provenance. Override via env for a different plan. */
export const REFERENCE_RATES: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "nvidia/nemotron-3-ultra-550b-a55b": { inputPerMTok: 0.5, outputPerMTok: 2.2 },
  "nvidia/nemotron-3-nano-30b-a3b": { inputPerMTok: 0.05, outputPerMTok: 0.2 },
};

export function costUsd(totals: LedgerTotals): number {
  let usd = 0;
  for (const [model, use] of Object.entries(totals.byModel)) {
    const rate = REFERENCE_RATES[model];
    if (!rate) continue;
    usd += (use.promptTokens / 1e6) * rate.inputPerMTok + (use.completionTokens / 1e6) * rate.outputPerMTok;
  }
  return usd;
}
