import type { AgentModel, AgentTurn } from "@/lib/agent/types";
import { providerModelForTier } from "@/lib/agent/model-tiers";
import { estimateCallTokens } from "./rate-governor";
import { createCircuitBreaker } from "./circuit-breaker";
import { createKeyPool, providerKeysFromEnv, type KeyLease } from "./key-pool";
import { currentByokProvider, type ByokProviderConfig } from "./byok-context";
import { currentTurnSignal } from "@/lib/agent/turn-control";
import { perf } from "@/lib/agent/perf";

export type NimMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** Provider-reported token accounting for one completion. Passed back to the
 *  gateway so the agent layer can attribute real cost per call type — the
 *  char/4 estimate cannot see completion tokens at all, and a reasoning model
 *  spends most of its output budget there. */
export type CompletionUsage = {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  ms: number;
};

export type CompletionOptions = {
  /** The user-selected Trion tier. Each tier has an explicit provider route;
   * this is never allowed to silently fall back to another tier. */
  tier?: AgentModel;
  fast?: boolean;
  maxTokens?: number;
  /** Per-call sampling temperature. The gateway computes one per tier; it was
   *  previously discarded and every call ran at a hardcoded 0.15. */
  temperature?: number;
  /** Ask the model to emit chain-of-thought before its answer.
   *
   *  These are reasoning models: left to themselves they spend a large,
   *  variable share of the completion budget narrating their own deliberation
   *  before emitting the JSON the loop actually parses — measured at 222
   *  completion tokens vs 19 for the identical classification answer. The
   *  reasoning is discarded by every parser in this codebase, so it is pure
   *  waste on calls whose answer is mechanical. It is worth paying for only
   *  where the decision is genuinely ambiguous.
   *
   *  Defaults to OFF. Callers opt in per call. */
  thinking?: boolean;
  /** Text-only callers may opt into handling a length-truncated prefix. The
   * caller is responsible for proving a safe structural boundary. */
  allowTruncated?: boolean;
  /** Sink for the provider's `usage` block. Measurement only. */
  onUsage?: (usage: CompletionUsage) => void;
  /**
   * Scheduling priority. LOWER RUNS FIRST; default 5.
   *
   * The queue was strictly FIFO, which meant a 40-token classification call —
   * the one blocking the user's first visible feedback — waited behind whatever
   * large synthesis happened to be enqueued ahead of it. Under a request-rate
   * ceiling that ordering decides perceived latency outright, because the
   * ceiling makes the queue genuinely deep rather than instantaneous.
   */
  priority?: number;
  /** Label used only in throttle diagnostics. */
  label?: string;
  /**
   * Reliability bounds for this particular kind of model call.  A timeout is
   * not an instruction to keep a user-facing turn "working" for ten minutes:
   * it is an uncertain transport failure.  Callers choose a small, explicit
   * budget so retries remain deliberate and visible in cost telemetry.
   */
  timeoutMs?: number;
  /** Total dispatch attempts, including the first one. */
  maxAttempts?: number;
  /**
   * ABSOLUTE wall-clock budget for the whole call, measured from enqueue.
   *
   * `timeoutMs` bounds a single in-flight request and nothing else. It does not
   * bound time spent queued behind a cooled key, provider-directed `retry-after`
   * backoff (deliberately uncapped — see `retryDelayMs`), or route-fallback hops
   * that each restart the per-attempt budget. Those gaps are what allowed a call
   * declaring 30s to stay pending for minutes: the recurring Step 3 stall.
   *
   * This is the one budget a caller can rely on. When it expires the call
   * rejects with a real, user-actionable error instead of holding the turn.
   */
  deadlineMs?: number;
  /** Cancels the call whether it is queued or already in flight. Without this,
   *  Stop could only be observed between steps, never during a model call. */
  signal?: AbortSignal;
  /** Internal route selected by the checkpointed provider fallback chain. */
  route?: "hosted" | "gemini";
  onRoute?: (route: "hosted" | "gemini") => void;
  onFallback?: (from: "hosted" | "gemini", to: "hosted" | "gemini") => void;
};

/** A single dispatch attempt. Retries re-enter the queue as a NEW attempt of the
 *  same task rather than looping inside a held slot — see `settleFailure`. */
type QueueTask = {
  messages: NimMessage[];
  maxTokens: number;
  opts: CompletionOptions;
  /** Whether the resolved value is parsed into an AgentTurn or left as text. */
  parse: boolean;
  priority: number;
  estTokens: number;
  /** Earliest time this task may be dispatched. Non-zero only after a retry. */
  notBefore: number;
  /** FIFO tiebreak within a priority band, so equal-priority work stays fair. */
  seq: number;
  attempt: number;
  maxAttempts: number;
  route: "hosted" | "gemini";
  fallbackHops: number;
  /** Captured at enqueue time so queued work cannot lose the request-scoped
   * provider context when it is dispatched later. */
  byok?: ByokProviderConfig;
  /** Absolute time this call must be settled by, one way or the other. */
  expiresAt: number;
  /** Aborts the CURRENT in-flight attempt, if there is one. Re-pointed on each
   *  dispatch so a deadline or a user Stop reaches the live request. */
  abortInFlight?: () => void;
  /** Guards against a task being settled twice — e.g. the deadline firing at the
   *  same moment a slow response lands. */
  settled: boolean;
  /** Clears the deadline timer and removes the caller's abort listener. */
  cleanup?: () => void;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

/** Settle a task exactly once, clearing its deadline and detaching listeners. */
function settleTask(task: QueueTask, outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): void {
  if (task.settled) return;
  task.settled = true;
  const index = queue.indexOf(task);
  if (index >= 0) queue.splice(index, 1);
  task.cleanup?.();
  if (outcome.ok) task.resolve(outcome.value);
  else task.reject(outcome.error);
}

function preferredRoute(opts: CompletionOptions): QueueTask["route"] {
  const label = opts.label ?? "";
  if (label === "plan" || GEMINI_BUILD_CALL_TYPES.has(label)) return geminiConfigured() ? "gemini" : "hosted";
  return "hosted";
}

/** Safe, provider-label-free route order used by tests and internal telemetry.
 * The label is never serialized into user-facing output. */
export function providerFallbackOrder(label: string, env: Record<string, string | undefined> = process.env): Array<QueueTask["route"]> {
  if (label === "plan" || GEMINI_BUILD_CALL_TYPES.has(label)) {
    return [...(geminiConfigured(env) ? ["gemini" as const] : []), "hosted"];
  }
  return ["hosted"];
}

function fallbackRoute(task: QueueTask): QueueTask["route"] | null {
  if (task.fallbackHops >= 2) return null;
  const order = providerFallbackOrder(task.opts.label ?? "");
  const currentIndex = order.indexOf(task.route);
  return currentIndex >= 0 ? order[currentIndex + 1] ?? null : null;
}

/** A provider HTTP failure, captured with everything the retry policy needs.
 *  The body is read EAGERLY at throw time: a Response body can only be consumed
 *  once, and the old code read it inside the error formatter, which meant the
 *  rate-limit detector downstream had nothing left to inspect. */
type ApiError = Error & {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
};

const queue: QueueTask[] = [];

const globalStore = globalThis as typeof globalThis & {
  __trionKeyPool?: ReturnType<typeof createKeyPool>;
  __trionGeminiPool?: ReturnType<typeof createKeyPool>;
};
// Multiple credentials are not proof of multiple free-tier allocations. Keep
// the pool on its shared account budget unless independently billed capacity is
// explicitly authorised in this deployment.
const independentBilling = process.env.TRION_KEY_POOL_INDEPENDENT_BILLING === "1" && process.env.TRION_KEY_POOL_TOS_CONFIRMED === "1";
const keyPool = (globalStore.__trionKeyPool ??= createKeyPool(providerKeysFromEnv(), { independentBilling }));

/** Gemini is an optional build/design lane. Its credentials are a separate
 * pool from the hosted Trion pool: keys are rotated for availability, never
 * assigned to a model tier, and never exposed in telemetry. */
function geminiKeysFromEnv(env: Record<string, string | undefined> = process.env) {
  // Key identity is SLOT-based, not positional.
  //
  // These ids are addressed by role elsewhere (`pump` prefers `gemini-1` for
  // planning and `gemini-2` for execution/review), so they must mean the same
  // credential every time. The previous version numbered keys by their position
  // AFTER filtering and de-duplication, which meant an unset `GEMINI_API_KEY_1`
  // silently promoted `GEMINI_API_KEY_2` to `gemini-1` — so the credential the
  // operator designated for execution was doing the planning, and the execution
  // role's preferred key did not exist at all. Nothing reported this, because a
  // missing preferred key falls back silently and correctly.
  const rpm = Number(env.GEMINI_RPM_LIMIT ?? 10);
  const tpm = Number(env.GEMINI_TPM_LIMIT ?? 0);
  const slots: Array<string | undefined> = [env.GEMINI_API_KEY_1, env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3]
    .map((value) => value?.trim() || undefined);

  // The unnumbered variable is a single-key convenience. Give it the first slot
  // that is still free rather than a slot of its own, so a one-key deployment
  // is `gemini-1` and never leaves a hole ahead of itself.
  const unnumbered = env.GEMINI_API_KEY?.trim();
  if (unnumbered && !slots.includes(unnumbered)) {
    const free = slots.findIndex((value) => value === undefined);
    if (free >= 0) slots[free] = unnumbered;
  }

  // Two variables holding the SAME secret are one credential with one quota,
  // not two. Collapse duplicates onto their earliest slot so the pool never
  // believes it has headroom it does not have.
  const seen = new Set<string>();
  return slots
    .map((secret, index) => ({ secret, id: `gemini-${index + 1}` }))
    .filter((entry): entry is { secret: string; id: string } => {
      if (!entry.secret || seen.has(entry.secret)) return false;
      seen.add(entry.secret);
      return true;
    })
    .map((entry) => ({
      id: entry.id,
      secret: entry.secret,
      rpm: Number.isFinite(rpm) && rpm >= 0 ? rpm : 10,
      tpm: Number.isFinite(tpm) && tpm >= 0 ? tpm : 0,
    }));
}

/**
 * Whether the build lane actually has the topology it is configured to assume.
 *
 * Planning and execution are routed to different credentials so a long build
 * does not spend one key's whole per-minute allowance on its own decisions. When
 * both roles resolve to the same credential that separation is imaginary: every
 * plan, execution decision and review call queues against a single RPM budget,
 * which is a direct cause of slow, serialized Step 3 execution.
 *
 * This is reported rather than corrected — the fix is a second credential, which
 * is an operator decision. Surfacing it means it can no longer be invisible.
 */
export function geminiLaneDiagnostics(env: Record<string, string | undefined> = process.env) {
  const keys = geminiKeysFromEnv(env);
  const ids = new Set(keys.map((key) => key.id));
  const planKey = ids.has("gemini-1") ? "gemini-1" : keys[0]?.id;
  const executionKey = ids.has("gemini-2") ? "gemini-2" : keys[0]?.id;
  return {
    configured: keys.length > 0,
    distinctKeys: keys.length,
    planKey,
    executionKey,
    /** True when plan and execution contend for one credential's rate budget. */
    sharesOneCredential: keys.length > 0 && planKey === executionKey,
    rpmPerKey: keys[0]?.rpm ?? 0,
  };
}

const geminiPool = (globalStore.__trionGeminiPool ??= createKeyPool(geminiKeysFromEnv(), { independentBilling: true }));

/** Gemini is used for the expensive build decisions only. The final user
 * summary deliberately stays on the hosted route so infrastructure identity
 * and provider-specific errors never leak into the conversation. */
export const GEMINI_BUILD_CALL_TYPES = new Set([
  "plan",
  "execution_decision",
  "coding_critic",
  "coding_synthesizer",
  "design_critic",
  "design_synthesizer",
  "design_recheck",
]);

export function geminiConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return geminiKeysFromEnv(env).length > 0;
}

export function shouldRouteToGemini(
  opts: CompletionOptions,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return geminiConfigured(env) && GEMINI_BUILD_CALL_TYPES.has(opts.label ?? "");
}

let inFlight = 0;
let hostedInFlight = 0;
let geminiInFlight = 0;
let seqCounter = 0;
let pumping = false;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * How many model calls may be in flight at once.
 *
 * This bounds PARALLELISM. It is not a rate — six calls in flight completing in
 * two seconds each is 180 requests/minute, which is several times the ceiling a
 * typical plan allows. Rate is governed separately, in `rate-governor.ts`; the
 * two limits are independent and both are load-bearing.
 */
const MAX_CONCURRENCY = Math.max(1, Number(process.env.TRION_MAX_CONCURRENCY || 6));
/**
 * Keep request starts below the shared 40-RPM free-tier ceiling even when a
 * burst of concurrent turns arrives. A 1.6s default permits 37.5 starts/min
 * (a small safety margin) rather than the 20 RPM a blanket 3s delay would
 * impose. An explicit positive TRION_MIN_INTERVAL_MS can make this stricter.
 * Zero does not disable shared-pool pacing: the free-tier allowance is still
 * account-wide even when several credentials are configured.
 */
export function defaultDispatchIntervalMs(rpm: number): number {
  if (!Number.isFinite(rpm) || rpm <= 0) return 0;
  return Math.ceil(60_000 / rpm) + 100;
}

const configuredRpm = Number(process.env.TRION_RPM_LIMIT ?? 40);
const intervalOverride = process.env.TRION_MIN_INTERVAL_MS ?? process.env.NIM_MIN_INTERVAL_MS;
const requestedIntervalMs = intervalOverride === undefined ? 0 : Math.max(0, Number(intervalOverride) || 0);
const MIN_INTERVAL_MS = requestedIntervalMs > 0 ? requestedIntervalMs : defaultDispatchIntervalMs(configuredRpm);
// Transport ceiling for a single provider attempt. 180s matches the Step-3
// full-file authoring budget: a lower hosted cap used to truncate healthy
// authoring responses at 120s while Gemini honored the full 180s, so the same
// logical call had a 60s divergent budget by route. Per-call timeoutMs values
// still govern ordinary calls; this is only the maximum they may request.
const REQUEST_TIMEOUT_MS = Number(process.env.TRION_REQUEST_TIMEOUT_MS || process.env.NIM_REQUEST_TIMEOUT_MS || 180000);
const DEFAULT_MAX_ATTEMPTS = 5;
/** A quota response is not a malformed request. Keep the same queued turn
 * alive through a small number of provider-paced cooldowns so the user does
 * not have to press Retry for a transient shared-pool limit. This is never an
 * immediate burst: `keyPool` keeps every key cooled and `retry-after` wins. */
const RATE_LIMIT_MAX_ATTEMPTS = Math.max(2, Number(process.env.TRION_RATE_LIMIT_MAX_ATTEMPTS ?? 4) || 4);
const CIRCUIT_FAILURE_LIMIT = 5;
const CIRCUIT_OPEN_MS = Math.max(1_000, Number(process.env.TRION_CIRCUIT_OPEN_MS || 60_000));
const VALID_ACTIONS = new Set(["read_file", "write_file", "run_command", "search_codebase", "web_fetch", "finish"]);

const hostedCircuitBreaker = createCircuitBreaker({
  failureLimit: CIRCUIT_FAILURE_LIMIT,
  openMs: CIRCUIT_OPEN_MS,
});
const geminiCircuitBreaker = createCircuitBreaker({
  failureLimit: CIRCUIT_FAILURE_LIMIT,
  openMs: CIRCUIT_OPEN_MS,
});

const lastDispatchByKey = new Map<string, number>();
let lastSharedDispatchAt = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Highest-priority task whose `notBefore` has passed. Does not dequeue.
 *
 * `blocked` holds tasks this pass already proved undispatchable — their route's
 * pool has no key with headroom right now. Skipping them lets the pump fall
 * through to work that CAN run instead of returning.
 *
 * That fall-through is the point. Previously the pump returned as soon as its
 * single best candidate could not get a key, so one cooled build-route key
 * froze every unrelated hosted call in the queue — including the
 * classification that gates the user's first visible feedback — for the whole
 * cooldown. Priority is meant to order work, never to let a stalled task hold
 * a slot no one else may use.
 */
function peekReady(now: number, blocked?: Set<QueueTask>): QueueTask | null {
  let best: QueueTask | null = null;
  for (const task of queue) {
    if (task.notBefore > now) continue;
    if (blocked?.has(task)) continue;
    if (!best || task.priority < best.priority || (task.priority === best.priority && task.seq < best.seq)) {
      best = task;
    }
  }
  return best;
}

/** Earliest future readiness time, so the pump can sleep exactly long enough. */
function nextWakeAt(now: number): number | null {
  let soonest: number | null = null;
  for (const task of queue) {
    if (task.notBefore <= now) continue;
    if (soonest === null || task.notBefore < soonest) soonest = task.notBefore;
  }
  return soonest;
}

function scheduleWake(at: number) {
  const delay = Math.max(1, at - Date.now());
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    void pump();
  }, delay);
  // A pending retry must never keep a serverless process alive on its own.
  (wakeTimer as unknown as { unref?: () => void }).unref?.();
}

/**
 * The dispatch loop.
 *
 * Rate budget is checked BEFORE a concurrency slot is taken, and the wait
 * happens outside the slot. That ordering is the whole point: the previous
 * design slept inside `callWithRetry` while holding `inFlight`, so five 429
 * retries at up to 30s each could occupy every slot in the pool and starve
 * traffic that had nothing to do with the limit.
 *
 * Each iteration re-selects the best task rather than committing to one before
 * the wait, so a high-priority call arriving during a throttle sleep is not
 * stuck behind the low-priority one that happened to be chosen first.
 */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;

  // Tasks proved undispatchable on this pass (their route has no key with
  // headroom right now). Cleared whenever anything is actually dispatched,
  // because a completed call frees budget that may unblock them.
  const blocked = new Set<QueueTask>();
  /** Soonest moment a blocked task might become dispatchable. */
  let blockedWakeAt: number | null = null;
  const noteBlocked = (task: QueueTask, waitMs: number) => {
    blocked.add(task);
    const at = Date.now() + Math.max(1, waitMs);
    blockedWakeAt = blockedWakeAt === null ? at : Math.min(blockedWakeAt, at);
  };

  try {
    for (;;) {
      if (queue.length === 0) return;
      if (inFlight >= MAX_CONCURRENCY) return;

      const now = Date.now();
      const task = peekReady(now, blocked);

      if (!task) {
        // Nothing dispatchable. Wake for whichever comes first: a task whose
        // retry delay expires, or a blocked task whose key budget recovers.
        const wake = nextWakeAt(now);
        const at = wake === null ? blockedWakeAt : blockedWakeAt === null ? wake : Math.min(wake, blockedWakeAt);
        if (at !== null) scheduleWake(at);
        return;
      }

      // A task can be settled by its deadline or by Stop while it sits in the
      // queue. Drop it here rather than spending a request on a dead call.
      if (task.settled) {
        const index = queue.indexOf(task);
        if (index >= 0) queue.splice(index, 1);
        continue;
      }

      // Reject while the breaker is open BEFORE consulting or charging the
      // local budget. A breaker rejection never crossed the network, so
      // recording it as an admitted request creates phantom saturation and
      // delays the first healthy request after recovery.
      const breaker = task.byok ? null : task.route === "gemini" ? geminiCircuitBreaker : hostedCircuitBreaker;
      if (breaker?.isOpen()) {
        settleTask(task, { ok: false, error: new Error("Trion is briefly pausing requests after repeated upstream failures. Try again in a moment.") });
        continue;
      }

      const usingGemini = task.route === "gemini";
      const usingByok = Boolean(task.byok);
      let lease: KeyLease | null = null;
      if (usingGemini) {
        if (geminiPool.isEmpty()) {
          task.route = fallbackRoute(task) ?? "hosted";
          continue;
        }
        const preferredGeminiKey = task.opts.label === "plan" ? "gemini-1" : "gemini-2";
        const choice = geminiPool.pick(task.estTokens, preferredGeminiKey);
        if (!choice.keyId || choice.waitMs > 0) {
          // The build lane cannot serve this call right now.
          //
          // Waiting out a cooled route while a healthy alternative sits idle is
          // never the right trade: the wait buys nothing the fallback would not
          // deliver sooner. This matters far more than it looks, because the
          // build lane's real free-tier limit is a DAILY request quota — once it
          // is spent, every remaining call in the day finds the pool cooling and
          // would queue behind a 60s cooldown that resets on each attempt. That
          // is the recurring Step 3 stall, and it is why the switch is immediate
          // rather than conditional on the remaining budget.
          //
          // The route order still means the build lane is always TRIED first
          // while it has capacity; this only decides what to do once it does not.
          const alternative = fallbackRoute(task);
          const waitIsPointless = choice.waitMs > MIN_USEFUL_ATTEMPT_MS ||
            Date.now() + choice.waitMs > task.expiresAt - MIN_USEFUL_ATTEMPT_MS;
          if (alternative && waitIsPointless) {
            perf("provider.fallback", 0, { from: task.route, to: alternative, reason: "route_unavailable_alternative_ready", waitMs: choice.waitMs });
            task.opts.onFallback?.(task.route, alternative);
            task.route = alternative;
            task.opts.route = alternative;
            task.fallbackHops += 1;
            continue;
          }
          // Otherwise do not stop the whole pump for one cooled build key: mark
          // this task blocked and let hosted work behind it proceed.
          noteBlocked(task, choice.waitMs);
          continue;
        }
        lease = geminiPool.acquire(choice.keyId, task.estTokens);
        if (!lease) continue;
      } else if (!usingByok) {
        // Select the least-loaded credential independently from the requested
        // model tier. The shared governor still protects one shared allowance.
        if (keyPool.isEmpty()) {
          settleTask(task, { ok: false, error: new Error("No AI provider is configured.") });
          continue;
        }
        const choice = keyPool.pick(task.estTokens);
        if (!choice.keyId || choice.waitMs > 0) {
          noteBlocked(task, choice.waitMs);
          continue;
        }
        if (MIN_INTERVAL_MS > 0) {
          const previousDispatch = independentBilling
            ? (lastDispatchByKey.get(choice.keyId) ?? 0)
            : lastSharedDispatchAt;
          const spacing = MIN_INTERVAL_MS - (Date.now() - previousDispatch);
          if (spacing > 0) {
            await sleep(spacing);
            continue;
          }
        }
        lease = keyPool.acquire(choice.keyId, task.estTokens);
        if (!lease) continue;
        lastDispatchByKey.set(lease.keyId, Date.now());
        if (!independentBilling) lastSharedDispatchAt = Date.now();
      }
      queue.splice(queue.indexOf(task), 1);
      inFlight += 1;
      if (usingGemini) geminiInFlight += 1;
      else if (!usingByok) hostedInFlight += 1;
      // Something moved. A task blocked earlier in this pass may have been
      // waiting on budget that this dispatch is about to release, so give every
      // blocked task a fresh look rather than carrying a stale verdict forward.
      blocked.clear();
      blockedWakeAt = null;

      void dispatch(task, lease, usingByok, usingGemini).finally(() => {
        inFlight -= 1;
        if (usingGemini) geminiInFlight -= 1;
        else if (!usingByok) hostedInFlight -= 1;
        void pump();
      });
    }
  } finally {
    pumping = false;
  }
}

/** Run exactly one attempt. Success resolves the caller; a retryable failure
 *  re-queues the task with a delay instead of blocking this slot. */
async function dispatch(task: QueueTask, lease: KeyLease | null, usingByok: boolean, usingGemini: boolean): Promise<void> {
  // The deadline or a user Stop can settle a task between selection and
  // dispatch. Spending a provider request on an already-settled call is pure
  // waste against the rate ceiling and its result has nowhere to go.
  if (task.settled) {
    if (lease) (usingGemini ? geminiPool : keyPool).settleFailure(lease);
    return;
  }
  task.opts.onRoute?.(task.route);
  const breaker = usingByok ? null : usingGemini ? geminiCircuitBreaker : hostedCircuitBreaker;
  if (breaker?.isOpen()) {
    if (lease) (usingGemini ? geminiPool : keyPool).settleFailure(lease);
    settleTask(task, { ok: false, error: new Error("Trion is briefly pausing requests after repeated upstream failures. Try again in a moment.") });
    return;
  }

  // Never let one attempt run past the whole call's remaining budget. Without
  // this, a 180s authoring attempt started near the deadline would keep the
  // socket open long after the caller had already been told the call failed.
  const remaining = task.expiresAt - Date.now();
  const attemptOpts: CompletionOptions = {
    ...task.opts,
    timeoutMs: Math.max(1_000, Math.min(task.opts.timeoutMs ?? REQUEST_TIMEOUT_MS, remaining)),
  };

  try {
    const text = await callProviderText(task.messages, task.maxTokens, attemptOpts, lease?.secret, task.byok, (usage) => {
      // Correct this key's pessimistic pre-flight estimate with what it was
      // actually billed. Concurrent responses settle against their own lease.
      if (lease) (usingGemini ? geminiPool : keyPool).settleSuccess(lease, usage.promptTokens + usage.completionTokens);
    }, (abort) => { task.abortInFlight = abort; });
    breaker?.breakSequence();
    settleTask(task, { ok: true, value: task.parse ? parseAgentTurn(text) : text });
  } catch (error) {
    if (task.settled) return;
    await settleFailure(task, error, lease, usingByok, usingGemini);
  } finally {
    task.abortInFlight = undefined;
  }
}

/**
 * Put a task back on the queue for another attempt — but only if that attempt
 * could actually finish inside the call's remaining budget.
 *
 * Re-queuing a task whose `notBefore` already sits past its deadline is the
 * shape of the stall this module used to produce: the work is technically
 * "still being retried" while no attempt can ever run in time, and the caller
 * waits with no error and no result. Failing here converts that dead wait into
 * an immediate, accurate message the turn can act on.
 *
 * Returns false when the task was settled instead of re-queued.
 */
function requeue(task: QueueTask, reason: string): boolean {
  if (task.settled) return false;
  const now = Date.now();
  if (task.notBefore >= task.expiresAt) {
    perf("provider.deadlineExceeded", 0, { reason, waitMs: task.notBefore - now, label: task.opts.label ?? "" });
    settleTask(task, {
      ok: false,
      error: new Error(
        "Trion is at its shared model-request limit and the wait exceeds this request's budget. Please retry in about a minute."
      ),
    });
    return false;
  }
  queue.push(task);
  void pump();
  return true;
}

async function settleFailure(task: QueueTask, error: unknown, lease: KeyLease | null, usingByok: boolean, usingGemini: boolean): Promise<void> {
  const api = error as ApiError;
  const status = typeof api?.status === "number" ? api.status : undefined;
  const rateLimited = isProviderRateLimited(api);
  const breaker = usingByok ? null : usingGemini ? geminiCircuitBreaker : hostedCircuitBreaker;

  const retryAfterMs = retryDelayMs(task.attempt, api);
  // The provider can encode an account-wide quota as 503
  // `ResourceExhausted ... total request limit`. Rotating credentials after
  // that response only makes extra failed calls, so cool the pool as one unit.
  if (lease) (usingGemini ? geminiPool : keyPool).settleFailure(lease, rateLimited ? 429 : status, retryAfterMs, rateLimited);

  // A build route can report a long-lived account allowance as a
  // rate-limit-shaped 429/503. Retrying that response inside the same turn is
  // guaranteed waste: it cannot create a file, and it used to consume three
  // calls before replacing the useful cause with a generic circuit message.
  // Stop after the first authoritative response. The approved plan remains
  // checkpointed by the orchestrator and can resume when capacity changes or
  // the user connects their own provider.
  const nextRoute = !usingByok ? fallbackRoute(task) : null;
  // Internal provider misconfiguration/model retirement (401/403/404) is
  // still a reason to advance to the next internal route. Only user BYOK
  // requests keep the normal no-retry rule for deterministic 4xx errors.
  const canAdvanceFallback = isRetryable(error) ||
    (!usingByok && usingGemini && status !== undefined && status >= 400);
  if (nextRoute && canAdvanceFallback) {
    const previousRoute = task.route;
    task.route = nextRoute;
    task.opts.route = nextRoute;
    task.fallbackHops += 1;
    task.opts.onFallback?.(previousRoute, nextRoute);
    perf("provider.fallback", 0, { from: previousRoute, to: nextRoute, attempt: task.attempt, reason: status ?? "timeout_or_transport" });
    task.attempt += 1;
    // Do NOT inherit the exhausted route's cooldown.
    //
    // This line used to read `rateLimited ? Date.now() + retryAfterMs : ...`,
    // which meant a call that had just failed over to a DIFFERENT, healthy
    // provider still sat out the cooldown the ORIGINAL provider asked for. With
    // a two-minute `retry-after` from the build route, the hosted route was
    // available and answering the whole time and the turn stalled anyway. That
    // is the recurring Step 3 stall: the fallback fired correctly and was then
    // neutralised by a backoff that did not apply to it.
    //
    // A different route has its own pool, its own governor and its own limits,
    // so it is eligible immediately. `keyPool.pick` still enforces whatever the
    // NEW route's real budget is before anything is dispatched.
    task.notBefore = Date.now();
    if (!requeue(task, "provider fallback")) return;
    return;
  }

  if (rateLimited) {
    // One cooled key must not take healthy independent keys down with it.
    if (!usingByok && (usingGemini || keyPool.healthyCount() === 0) && breaker?.noteRateLimit()) {
      settleTask(task, { ok: false, error: new Error("Trion is briefly pausing requests after repeated upstream rate limits. Try again in a moment.") });
      return;
    }
  } else {
    breaker?.breakSequence();
  }

  // A full-file authoring decision normally gets one attempt, which avoids
  // duplicating slow generation after a timeout. A provider-declared quota is
  // different: no content was generated. Keep the SAME queued request through
  // a few provider-paced cooldown windows rather than handing the unfinished
  // build back to the user. Healthy-path RPM is unchanged; attempts occur only
  // after a real limit response and never before the pool cooldown expires.
  const allowedAttempts = rateLimited ? Math.max(task.maxAttempts, RATE_LIMIT_MAX_ATTEMPTS) : task.maxAttempts;
  if (!isRetryable(error) || task.attempt >= allowedAttempts) {
    settleTask(task, { ok: false, error: new Error(describeError(error)) });
    return;
  }

  task.attempt += 1;
  // 429/503 fail over immediately when another key currently has headroom;
  // otherwise preserve the provider-directed retry delay on the cooled key.
  // A generic 503 can fail over to another independent credential. An explicit
  // quota response cannot: it has already told us the budget is shared.
  const activePool = usingGemini ? geminiPool : keyPool;
  const canFailOver = lease !== null && !rateLimited && status === 503 && activePool.hasAlternative(lease.keyId, task.estTokens);
  task.notBefore = canFailOver ? Date.now() : Date.now() + retryAfterMs;
  // Re-queued at its original priority: a call that has already burned an
  // attempt is MORE urgent than one that has not, not less. `requeue` refuses
  // the retry outright when the provider's own backoff would push it past this
  // call's deadline, rather than parking the caller on a wait it cannot use.
  requeue(task, rateLimited ? "rate limit backoff" : "transport retry");
}

/**
 * How long to wait before the next attempt.
 *
 * The provider is the authority when it says anything at all. `retry-after-ms`
 * wins, then `retry-after` as either seconds or an HTTP date. Only when the
 * response carries no guidance do we guess with exponential backoff — and only
 * the GUESS is capped at 30s. Capping a server-specified delay is how a client
 * retries straight back into a limit that had not reset yet, spending a request
 * to be told the same thing again.
 */
export function retryDelayMs(attempt: number, error?: { headers?: Record<string, string> }): number {
  const headers = error?.headers;

  if (headers) {
    const ms = Number.parseFloat(headers["retry-after-ms"] ?? "");
    if (Number.isFinite(ms) && ms >= 0) return Math.ceil(ms);

    const retryAfter = headers["retry-after"];
    if (retryAfter) {
      const seconds = Number.parseFloat(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
      const asDate = Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(asDate) && asDate > 0) return Math.ceil(asDate);
    }
  }

  const backoff = 1000 * Math.pow(2, attempt - 1);
  return Math.min(backoff, 30000);
}

/**
 * Whether another attempt could plausibly succeed.
 *
 * The rule that matters for the rate budget is the NEGATIVE one: a request that
 * cannot succeed must not be retried. Context-overflow and malformed-request
 * failures are deterministic — five attempts produce five identical failures,
 * spend five requests against the ceiling, and delay the user by the sum of the
 * backoffs before showing the same error that was available immediately.
 */
export function isRetryable(error: unknown): boolean {
  const api = error as ApiError;
  const status = typeof api?.status === "number" ? api.status : undefined;
  const body = typeof api?.body === "string" ? api.body.toLowerCase() : "";
  const message = (api?.message ?? "").toLowerCase();
  const haystack = `${body} ${message}`;

  // Deterministic failures — never retry, whatever the status code says.
  if (
    haystack.includes("context length") ||
    haystack.includes("context_length") ||
    haystack.includes("maximum context") ||
    haystack.includes("too many tokens") ||
    haystack.includes("string too long") ||
    haystack.includes("contextoverflow")
  ) {
    return false;
  }

  if (status === 429 || status === 408 || status === 409) return true;
  if (status !== undefined && status >= 500 && status < 600) return true;

  // 4xx other than the above is a request WE got wrong. Retrying is waste.
  if (status !== undefined && status >= 400 && status < 500) return false;

  // No status: a transport error, or a provider that reports rate limits in the
  // body with a 200-shaped envelope. NIM does the latter, which is why the text
  // patterns are checked and not just the code.
  if (
    haystack.includes("rate limit") ||
    haystack.includes("rate_limit") ||
    haystack.includes("too many requests") ||
    haystack.includes("rate increased too quickly") ||
    haystack.includes("overloaded") ||
    haystack.includes("unavailable") ||
    haystack.includes("exhausted")
  ) {
    return true;
  }

  // Timeouts and socket failures.
  return status === undefined;
}

/** NIM can return shared quota exhaustion in a 503 envelope rather than HTTP
 * 429. Only explicit quota markers trigger account-wide cooling; a transient
 * generic 503 remains eligible for normal failover. */
export function isProviderRateLimited(error: { status?: number; body?: string; message?: string } | undefined): boolean {
  const status = error?.status;
  const text = `${error?.body ?? ""} ${error?.message ?? ""}`.toLowerCase();
  return status === 429 ||
    text.includes("resourceexhausted") ||
    text.includes("resource exhausted") ||
    text.includes("total request limit") ||
    text.includes("rate limit") ||
    text.includes("too many requests");
}

/**
 * Absolute ceiling on any single model call, however it is configured.
 *
 * A caller can ask for less. Nothing may ask for more: an interactive turn that
 * has been "working" for four minutes on one decision has already failed the
 * user, whatever the provider is doing.
 */
const MAX_CALL_DEADLINE_MS = Math.max(30_000, Number(process.env.TRION_CALL_DEADLINE_MAX_MS || 240_000));

/**
 * Slack added on top of `timeoutMs * maxAttempts` when a caller does not name an
 * explicit deadline. It covers the legitimate non-request time in a healthy
 * call: queue wait under a rate ceiling, one route-fallback hop, and provider
 * backoff between attempts. It is deliberately generous — the deadline exists to
 * kill unbounded waits, not to fail slow-but-progressing work.
 */
const DEADLINE_SLACK_MS = Math.max(0, Number(process.env.TRION_CALL_DEADLINE_SLACK_MS || 45_000));

/**
 * The least remaining budget in which a fresh attempt is still worth starting.
 * Below this, waiting for a cooled route to recover cannot produce an answer in
 * time, so the pump switches routes instead of queueing against the cooldown.
 */
const MIN_USEFUL_ATTEMPT_MS = Math.max(1_000, Number(process.env.TRION_MIN_USEFUL_ATTEMPT_MS || 5_000));

export function callDeadlineMs(opts: CompletionOptions): number {
  const attempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const perAttempt = Math.max(1_000, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const derived = perAttempt * attempts + DEADLINE_SLACK_MS;
  return Math.min(opts.deadlineMs ?? derived, MAX_CALL_DEADLINE_MS);
}

function enqueue(messages: NimMessage[], maxTokens: number, opts: CompletionOptions, parse: boolean) {
  return new Promise<unknown>((resolve, reject) => {
    const deadlineMs = callDeadlineMs(opts);
    // An explicit signal wins; otherwise inherit the active turn's. This is what
    // makes Stop reach calls whose call sites never asked to be cancellable.
    const signal = opts.signal ?? currentTurnSignal();
    const task: QueueTask = {
      messages,
      maxTokens,
      opts,
      parse,
      priority: opts.priority ?? 5,
      estTokens: estimateCallTokens(messages, maxTokens),
      notBefore: 0,
      seq: seqCounter++,
      attempt: 1,
      maxAttempts: Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
      route: opts.route ?? preferredRoute(opts),
      fallbackHops: 0,
      byok: currentByokProvider(),
      expiresAt: Date.now() + deadlineMs,
      settled: false,
      resolve,
      reject,
    };

    // The deadline is armed HERE, at enqueue, not at dispatch. A task that never
    // reaches a provider — because every key is cooling, or because the pump
    // never selected it — is exactly the case the old per-request timeout could
    // not see, and exactly how the turn used to hang with nothing in flight.
    const deadlineTimer = setTimeout(() => {
      perf("provider.deadlineExceeded", deadlineMs, { reason: "wall clock", label: opts.label ?? "", route: task.route });
      task.abortInFlight?.();
      settleTask(task, {
        ok: false,
        error: new Error("Trion could not complete this step in time. Retry, and it will resume from the saved workspace state."),
      });
    }, deadlineMs);
    (deadlineTimer as unknown as { unref?: () => void }).unref?.();

    // Stop must reach a call that is queued behind a cooled key just as surely
    // as one that is already in flight.
    const onAbort = () => {
      task.abortInFlight?.();
      const cancelled = new Error("Turn cancelled by the user.");
      cancelled.name = "AbortError";
      settleTask(task, { ok: false, error: cancelled });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    task.cleanup = () => {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    queue.push(task);
    void pump();
  });
}

export function queuedCompletion(messages: NimMessage[], maxTokens: number, opts: CompletionOptions = {}) {
  return enqueue(messages, maxTokens, opts, true) as Promise<AgentTurn>;
}

export function queuedTextCompletion(messages: NimMessage[], maxTokens: number, opts: CompletionOptions = {}) {
  return enqueue(messages, maxTokens, opts, false) as Promise<string>;
}

export function getQueueDepth() {
  return queue.length + inFlight;
}

export function getCircuitState() {
  const hosted = hostedCircuitBreaker.snapshot().state;
  return hosted === "open" ? "open" : "closed";
}

/** Live rate telemetry for the health route and the UI meter. */
export function getRateSnapshot() {
  const geminiQueued = queue.filter((task) => task.route === "gemini").length;
  const hostedQueued = queue.length - geminiQueued;
  const lane = geminiLaneDiagnostics();
  const routes = {
    hosted: { queued: hostedQueued, inFlight: hostedInFlight },
    geminiBuild: {
      configured: lane.configured,
      queued: geminiQueued,
      inFlight: geminiInFlight,
      // Operational health, not credentials: how many DISTINCT keys the lane
      // resolved to, and whether planning and execution are sharing one budget.
      distinctKeys: lane.distinctKeys,
      sharesOneCredential: lane.sharesOneCredential,
    },
  };
  return { ...keyPool.snapshot(), queued: queue.length, inFlight, routes };
}

export function hasConfig() {
  return geminiConfigured() || !keyPool.isEmpty();
}

async function callProviderText(
  messages: NimMessage[],
  maxTokens: number,
  opts: CompletionOptions,
  providerKey: string | undefined,
  byok: ByokProviderConfig | undefined,
  onSettle?: (usage: CompletionUsage) => void,
  /** Hands the caller a way to abort THIS request, so a wall-clock deadline or a
   *  user Stop can close the socket instead of waiting for the response. */
  registerAbort?: (abort: () => void) => void
): Promise<string> {
  const fast = opts.fast ?? false;
  const temperature = opts.temperature ?? 0.15;
  const tier = opts.tier ?? "trion-1.4";
  const route = byok ? "hosted" : (opts.route ?? preferredRoute(opts));
  const useGemini = !byok && route === "gemini";
  const model = byok
    ? (fast && byok.fastModel ? byok.fastModel : byok.model)
    : useGemini
      ? (fast ? process.env.GEMINI_MODEL_FAST : process.env.GEMINI_MODEL_EXECUTOR)?.trim() || (fast ? "gemini-3.5-flash-lite" : "gemini-3.5-flash")
      : providerModelForTier(tier, fast);
  const baseUrl = (byok ? byok.baseUrl : useGemini
    ? "https://generativelanguage.googleapis.com/v1beta"
    : (process.env.TRION_BASE_URL || process.env.NIM_BASE_URL || "https://integrate.api.nvidia.com/v1"))?.replace(/\/$/, "");
  const apiKey = byok ? byok.apiKey : providerKey;

  if (!model || !baseUrl || !apiKey) {
    throw new Error(`Trion ${tier.slice("trion-".length)} is not configured in this environment.`);
  }

  const controller = new AbortController();
  // Step-3 full-file authoring has an explicit 180s ceiling. Gemini used to
  // impose an undocumented 60s transport cap here, which silently overrode
  // that bounded policy and made a healthy long JSON response look like a
  // stalled execution. Ordinary plan/decision calls still use their smaller
  // `opts.timeoutMs` budgets below; this is only the maximum they may request.
  const routeTimeout = useGemini
      ? Number(process.env.TRION_GEMINI_REQUEST_TIMEOUT_MS || 180_000)
      : REQUEST_TIMEOUT_MS;
  const timeoutMs = Math.max(1_000, Math.min(opts.timeoutMs ?? REQUEST_TIMEOUT_MS, routeTimeout));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  registerAbort?.(() => controller.abort());
  const started = Date.now();

  try {
    const anthropic = byok?.provider === "anthropic";
    const system = messages.filter((entry) => entry.role === "system").map((entry) => entry.content).join("\n\n");
    const response = await fetch(
      useGemini
        ? `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
        : anthropic ? `${baseUrl}/messages` : `${baseUrl}/chat/completions`,
      {
      method: "POST",
      headers: useGemini
        ? { "content-type": "application/json" }
        : anthropic
          ? { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
          : { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify(useGemini ? {
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: messages.filter((entry) => entry.role !== "system").map((entry) => ({
          role: entry.role === "assistant" ? "model" : "user",
          parts: [{ text: entry.content }],
        })),
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      } : anthropic ? {
        model,
        system,
        messages: messages.filter((entry) => entry.role !== "system").map((entry) => ({ role: entry.role, content: entry.content })),
        temperature,
        max_tokens: maxTokens,
      } : {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        // Only sent when the caller has an opinion. Omitting the key leaves the
        // provider's own default in place, which is what makes it possible to
        // measure a before/after against unmodified behaviour.
        ...(!byok && typeof opts.thinking === "boolean"
          ? { chat_template_kwargs: { thinking: opts.thinking } }
          : {})
      })
      }
    );

    if (!response.ok) {
      // Gemini is an internal build lane, so its raw response body must never
      // become a user-facing trace or error. Treat it like a protected
      // provider error at this boundary even though it is not user BYOK.
      throw await toApiError(response, Boolean(byok || useGemini));
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      content?: Array<{ type?: string; text?: string }>;
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        input_tokens?: number;
        output_tokens?: number;
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
      };
      usageMetadata?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        input_tokens?: number;
        output_tokens?: number;
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
      };
    };

    const usageData = data.usageMetadata ?? data.usage;
    const usage: CompletionUsage = {
      model,
      promptTokens: usageData?.prompt_tokens ?? usageData?.input_tokens ?? usageData?.promptTokenCount ?? 0,
      completionTokens: usageData?.completion_tokens ?? usageData?.output_tokens ?? usageData?.candidatesTokenCount ?? 0,
      cachedPromptTokens: usageData?.prompt_tokens_details?.cached_tokens ?? usageData?.cachedContentTokenCount ?? 0,
      ms: Date.now() - started,
    };
    onSettle?.(usage);
    opts.onUsage?.(usage);

    const finishReason = useGemini ? (data.candidates?.[0] as { finishReason?: string } | undefined)?.finishReason : data.choices?.[0]?.finish_reason;
    if ((finishReason === "length" || finishReason === "MAX_TOKENS") && !opts.allowTruncated) {
      throw new Error("Trion response reached its output limit before the file was complete.");
    }

    const content = useGemini
      ? data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim()
      : anthropic ? data.content?.find((entry) => entry.type === "text")?.text : data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Trion returned an empty response.");
    return content;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Trion request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Read status, headers and body off a failed Response once, up front. */
async function toApiError(response: Response, byok = false): Promise<ApiError> {
  const body = await response.text().catch(() => "");
  const headers: Record<string, string> = {};
  response.headers?.forEach?.((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const userMessage = response.status === 401 || response.status === 403
    ? "Your API key was rejected. Check the connection in Settings."
    : response.status === 404
      ? "Your selected model or provider endpoint was not found. Check the connection in Settings."
      : response.status === 429
        ? "Your provider is rate-limiting this connection. Wait briefly, then continue."
        : "Your provider could not complete this request.";
  const error = new Error(byok ? userMessage : `Trion request failed with HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : "."}`) as ApiError;
  error.status = response.status;
  error.headers = headers;
  error.body = body;
  return error;
}

function describeError(error: unknown): string {
  if (isProviderRateLimited(error as ApiError)) {
    return "Trion is temporarily at its shared model-request limit. Please retry in about a minute.";
  }
  if (error instanceof Error) return error.message;
  return "Trion request failed.";
}

function parseAgentTurn(content: string): AgentTurn {
  let parsed: Partial<AgentTurn>;

  try {
    parsed = JSON.parse(extractJsonObject(content)) as Partial<AgentTurn>;
  } catch {
    return wrapRawModelOutput(content);
  }

  // A real tool call is a real tool call even if a cosmetic field is missing.
  // Requiring `thought` and `done` to be present rewrote any turn that omitted
  // them into `finish`/done:true — so the model asked to write a file, the file
  // was never written, and the turn reported itself complete. Only the fields
  // that decide WHAT RUNS are mandatory; the rest get defaults.
  const action = typeof parsed.action === "string" ? parsed.action.trim() : "";
  if (!VALID_ACTIONS.has(action) || typeof parsed.action_input !== "object" || parsed.action_input === null || Array.isArray(parsed.action_input)) {
    return wrapRawModelOutput(content);
  }

  return {
    thought: typeof parsed.thought === "string" ? parsed.thought : "",
    action: action as AgentTurn["action"],
    action_input: parsed.action_input,
    summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
    // `done` is only meaningful on `finish`; anywhere else, more work follows.
    done: typeof parsed.done === "boolean" ? parsed.done : action === "finish"
  };
}

function wrapRawModelOutput(content: string): AgentTurn {
  return {
    thought: "The model returned non-schema text, so Trion wrapped it into a completed response.",
    action: "finish",
    action_input: { raw_model_output: content },
    summary: content.slice(0, 900),
    done: true
  };
}

export function extractJsonObject(content: string) {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);

  return trimmed;
}
