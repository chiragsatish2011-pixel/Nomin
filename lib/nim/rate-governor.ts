// Requests-per-minute and tokens-per-minute governance for the model queue.
//
// WHY THIS EXISTS
//
// `internal-client.ts` bounded CONCURRENCY (how many calls are in flight at
// once) and nothing else. Concurrency is not a rate: six calls in flight,
// completing in two seconds each, is 180 requests/minute against a provider
// ceiling that is typically 40. The queue therefore could not prevent a 429 —
// it could only react to one after the fact, by retrying, which costs another
// request against the same exhausted budget.
//
// This module is the missing half: a sliding-window accountant that makes a
// call WAIT for budget instead of failing and retrying into a wall. A request
// that is delayed 900ms costs nothing; a request that 429s costs a request slot,
// a retry slot, and the backoff sleep in between.
//
// AIMD
//
// The configured ceiling is a guess — providers publish limits per plan, change
// them, and enforce them per-key rather than per-process. So the effective
// ceiling is adaptive, using the same additive-increase / multiplicative-decrease
// rule TCP uses for congestion:
//
//   - a 429 HALVES the effective ceiling (multiplicative decrease), because the
//     provider has just told us we are provably over.
//   - each subsequent quiet minute adds one request back (additive increase),
//     so a single bad burst does not permanently cripple throughput.
//
// The result converges just under the real limit without ever being told what
// it is.
//
// Everything here is pure bookkeeping over an injected clock, so the tests run
// without timers and without a network.

export type RateGovernorConfig = {
  /** Requests per 60s. 0 disables request-rate governance. */
  rpm: number;
  /** Tokens per 60s, counting prompt + expected completion. 0 disables it. */
  tpm: number;
  /** Never adapt below this many requests/minute — a floor keeps the agent
   *  alive (slowly) rather than deadlocked after a burst of 429s. */
  minRpm: number;
  now: () => number;
};

const WINDOW_MS = 60_000;

export type RateGovernor = ReturnType<typeof createRateGovernor>;

export function createRateGovernor(config: Partial<RateGovernorConfig> = {}) {
  const cfg: RateGovernorConfig = {
    rpm: config.rpm ?? 35,
    tpm: config.tpm ?? 0,
    minRpm: config.minRpm ?? 4,
    now: config.now ?? Date.now,
  };

  /** Start timestamps of requests admitted in the trailing window. */
  let requests: number[] = [];
  /** Token charges in the trailing window, paired with their own dispatch id.
   *  Provider responses can complete out of order, so settlement must never
   *  assume the most recent dispatch is the request now responding. */
  let tokens: Array<{ id: number; at: number; amount: number }> = [];
  let nextTokenChargeId = 0;

  /** The adaptive ceiling. Starts at the configured limit and moves under AIMD. */
  let effectiveRpm = cfg.rpm;
  /** When the last additive-increase step was applied. */
  let lastIncrease = cfg.now();
  /** Counters, for the telemetry readout the UI renders. */
  let admitted = 0;
  let throttleWaitMs = 0;
  let rateLimitHits = 0;

  function prune(now: number) {
    const cutoff = now - WINDOW_MS;
    // A plain filter each call is O(n) over at most `rpm` entries — a few dozen.
    // Not worth a ring buffer, and this stays obviously correct.
    if (requests.length && requests[0] <= cutoff) requests = requests.filter((t) => t > cutoff);
    if (tokens.length && tokens[0].at <= cutoff) tokens = tokens.filter((t) => t.at > cutoff);
  }

  /** Additive increase: claw back one request/minute for each quiet window that
   *  passes without a 429, up to the configured ceiling. */
  function recover(now: number) {
    if (effectiveRpm >= cfg.rpm) return;
    const elapsed = now - lastIncrease;
    if (elapsed < WINDOW_MS) return;
    const steps = Math.floor(elapsed / WINDOW_MS);
    effectiveRpm = Math.min(cfg.rpm, effectiveRpm + steps);
    lastIncrease = now;
  }

  /**
   * How long the caller must wait before this request fits both budgets.
   * Returns 0 when it fits now. Does NOT reserve anything — call `charge()`
   * once you have actually decided to dispatch, so that a caller which changes
   * its mind (or re-picks a higher-priority task) does not leak budget.
   */
  function waitMs(estTokens: number): number {
    const now = cfg.now();
    prune(now);
    recover(now);

    let wait = 0;

    if (cfg.rpm > 0 && requests.length >= effectiveRpm) {
      // The oldest in-window request is the one whose expiry frees a slot.
      const oldest = requests[requests.length - effectiveRpm];
      wait = Math.max(wait, oldest + WINDOW_MS - now);
    }

    if (cfg.tpm > 0 && estTokens > 0) {
      const used = tokens.reduce((sum, t) => sum + t.amount, 0);
      if (used + estTokens > cfg.tpm) {
        // Walk the window oldest-first and find the point at which enough
        // tokens have aged out for this request to fit.
        let freed = 0;
        const needed = used + estTokens - cfg.tpm;
        for (const entry of tokens) {
          freed += entry.amount;
          if (freed >= needed) {
            wait = Math.max(wait, entry.at + WINDOW_MS - now);
            break;
          }
        }
        // Even an empty window cannot fit it: the single request is larger than
        // the whole per-minute token budget. Waiting will never help, so admit
        // it and let the provider be the judge — refusing outright would make a
        // large legitimate request permanently impossible.
        if (freed < needed) wait = Math.max(wait, 0);
      }
    }

    return Math.max(0, Math.ceil(wait));
  }

  /** Record that a request was dispatched, charging it against both windows. */
  function charge(estTokens: number): number | undefined {
    const now = cfg.now();
    prune(now);
    requests.push(now);
    const tokenChargeId = estTokens > 0 ? ++nextTokenChargeId : undefined;
    if (tokenChargeId !== undefined) tokens.push({ id: tokenChargeId, at: now, amount: estTokens });
    admitted += 1;
    return tokenChargeId;
  }

  /**
   * Reconcile an estimate against what the provider actually billed.
   *
   * The pre-flight number is `chars/4 + max_tokens`, which over-counts the
   * completion badly (a call allowed 4096 output tokens usually emits a few
   * hundred). Left uncorrected the TPM window reads several times high and
   * throttles traffic that would have fit comfortably.
   */
  function settle(estTokens: number, actualTokens: number, tokenChargeId?: number) {
    if (estTokens <= 0 && actualTokens <= 0) return;
    const delta = actualTokens - estTokens;
    if (delta === 0) return;
    const now = cfg.now();
    prune(now);
    // The optional id pins a completion to its dispatch. Keep the newest-row
    // fallback for single-call callers that predate concurrent settlement.
    const charge = tokenChargeId === undefined
      ? tokens[tokens.length - 1]
      : tokens.find((entry) => entry.id === tokenChargeId);
    if (charge) charge.amount = Math.max(0, charge.amount + delta);
  }

  /** The provider said we are over. Halve the ceiling and restart recovery. */
  function penalize() {
    rateLimitHits += 1;
    effectiveRpm = Math.max(cfg.minRpm, Math.floor(effectiveRpm / 2));
    lastIncrease = cfg.now();
  }

  function noteWait(ms: number) {
    throttleWaitMs += ms;
  }

  function snapshot() {
    const now = cfg.now();
    prune(now);
    recover(now);
    return {
      configuredRpm: cfg.rpm,
      effectiveRpm,
      requestsInWindow: requests.length,
      tokensInWindow: tokens.reduce((sum, t) => sum + t.amount, 0),
      tpm: cfg.tpm,
      admitted,
      throttleWaitMs,
      rateLimitHits,
      /** Fraction of the effective ceiling currently consumed. Drives the UI meter. */
      saturation: effectiveRpm > 0 ? Math.min(1, requests.length / effectiveRpm) : 0,
    };
  }

  function reset() {
    requests = [];
    tokens = [];
    nextTokenChargeId = 0;
    effectiveRpm = cfg.rpm;
    lastIncrease = cfg.now();
    admitted = 0;
    throttleWaitMs = 0;
    rateLimitHits = 0;
  }

  return { waitMs, charge, settle, penalize, noteWait, snapshot, reset };
}

/**
 * Estimate what a call will cost against the token window BEFORE sending it.
 *
 * Deliberately pessimistic on the completion side: `maxTokens` is the ceiling
 * the model is allowed, and budgeting for the ceiling is what stops a burst of
 * long generations from blowing through a TPM limit that a mean-based estimate
 * would have said was fine. `settle()` corrects it downward afterwards.
 */
export function estimateCallTokens(messages: Array<{ content: string }>, maxTokens: number): number {
  let prompt = 0;
  for (const message of messages) prompt += Math.ceil(message.content.length / 4);
  return prompt + Math.max(0, maxTokens);
}

// The process-wide instance the model queue uses. Pinned to globalThis for the
// same reason the token ledger is: a dev hot-reload that swaps module identity
// would otherwise hand out a fresh, empty window and silently stop governing.
const globalStore = globalThis as typeof globalThis & { __trionRateGovernor?: RateGovernor };

export const rateGovernor: RateGovernor = (globalStore.__trionRateGovernor ??= createRateGovernor({
  rpm: Number(process.env.TRION_RPM_LIMIT ?? 35),
  tpm: Number(process.env.TRION_TPM_LIMIT ?? 0),
  minRpm: Number(process.env.TRION_MIN_RPM ?? 4),
}));
