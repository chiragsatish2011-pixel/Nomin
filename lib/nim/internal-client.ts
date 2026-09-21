import type { AgentModel, AgentTurn } from "@/lib/agent/types";
import { providerModelForTier } from "@/lib/agent/model-tiers";
import { estimateCallTokens } from "./rate-governor";
import { createCircuitBreaker } from "./circuit-breaker";
import { createKeyLane, providerKeyFromEnv, type KeyLease } from "./single-key";
import {
  localLaneFromEnv,
  localLaneReady,
  noteLocalFailure,
  noteLocalFallback,
  noteLocalSuccess,
  type LocalLaneConfig,
} from "./local-lane";
import { logProviderRequest, logProviderResponse, logProviderError } from "./diagnostics";
import { currentByokProvider, type ByokProviderConfig } from "./byok-context";
import { currentTurnSignal } from "@/lib/agent/turn-control";
import { perf } from "@/lib/agent/perf";

export type NimMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** A single OpenAI-shaped function tool definition, passed through verbatim. */
export type ProviderTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
};

export type ProviderToolChoice =
  | { type: "function"; function: { name: string } }
  | "auto"
  | "none"
  | "required";

/** Provider-reported token accounting for one completion. Passed back to the
 *  gateway so the agent layer can attribute real cost per call type — the
 *  char/4 estimate cannot see completion tokens at all, and a reasoning model
 *  spends most of its output budget there. */
/**
 * Which lane served a call.
 *
 * "local" is a model running on the user's own machine (see local-lane.ts),
 * "hosted" is the configured NVIDIA endpoint, "byok" is the user's own
 * connected provider. A turn may cross from local to hosted mid-call; the
 * route reported is the one that actually produced the answer.
 */
export type ProviderRoute = "hosted" | "local";

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
  /** There is exactly one route. Kept as a field so telemetry and the BYOK
   *  branch keep a stable shape; it no longer selects between providers. */
  route?: ProviderRoute;
  onRoute?: (route: ProviderRoute) => void;
  /** OpenAI-shaped function-calling passthrough. Sent verbatim on the
   *  OpenAI-compatible route only (the hosted lane plus OpenAI-shaped BYOK);
   *  ignored on the Anthropic BYOK route, which uses a different tool schema.
   *  Absent by default so existing calls are byte-identical. */
  tools?: ProviderTool[];
  toolChoice?: ProviderToolChoice;
  /**
   * Token sink. Present means "stream this call": the request is sent with
   * `stream: true` and each content delta is handed over as it arrives.
   *
   * Every call in this codebase used to be a blocking request/response, so the
   * user stared at a spinner for the WHOLE generation — 3s at best and 70s at
   * the measured worst case on the primary tier — before a single character
   * appeared. That is the difference between this product and the assistants it
   * is compared to, and it is a transport property, not a model one.
   *
   * Only prose calls stream. A call whose result is parsed as JSON (a plan, an
   * execution decision) gains nothing from partial text, so it stays on the
   * blocking path where truncation and tool_calls are handled exactly as before.
   */
  onDelta?: (chunk: string) => void;
  /**
   * A retry discards whatever the failed attempt already streamed. Without this
   * the client would append the second attempt's text to the first attempt's
   * half-sentence. Fired before the first delta of any attempt after the first.
   */
  onStreamRestart?: () => void;
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
  route: ProviderRoute;
  /** Set once a local attempt has failed: this task goes hosted from here. */
  forceHosted?: boolean;
  /** Captured at enqueue time so queued work cannot lose the request-scoped
   * provider context when it is dispatched later. */
  byok?: ByokProviderConfig;
  /** Absolute time this call must be settled by, one way or the other. */
  expiresAt: number;
  /** Which attempt has already streamed text to the caller, so a retry can
   *  tell the caller to discard it. */
  streamedAttempt?: number;
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

/** One credential, one provider, one route. Kept as a function (rather than
 *  inlining "hosted") so telemetry and tests keep a single source of truth. */
export function providerFallbackOrder(): Array<QueueTask["route"]> {
  if (localLaneReady()) return ["local", "hosted"];
  return ["hosted"];
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
  __trionKeyLane?: ReturnType<typeof createKeyLane>;
};

/**
 * THE credential lane. One key, one rate budget, one provider.
 *
 * Removed with the pool: the independent-billing flag (meaningless with a
 * single key), the Gemini build lane and its 1-3 numbered credentials, the
 * per-role key preference (gemini-1 plans, gemini-2 executes), the lane
 * topology diagnostics, and the GEMINI_BUILD_CALL_TYPES routing table. Those
 * described a five-credential deployment; this one has a single key, so the
 * routing decision they existed to make no longer exists.
 */
const keyLane = (globalStore.__trionKeyLane ??= createKeyLane(providerKeyFromEnv()));


let inFlight = 0;
let hostedInFlight = 0;
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

/** One credential means one dispatch clock: request spacing is a property of
 *  the account, not of a key that was chosen from several. */
let lastDispatchAt = 0;

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
      const breaker = task.byok ? null : hostedCircuitBreaker;
      if (breaker?.isOpen()) {
        settleTask(task, { ok: false, error: new Error("Trion is briefly pausing requests after repeated upstream failures. Try again in a moment.") });
        continue;
      }

      const usingByok = Boolean(task.byok);
      // A model on this machine has no shared quota to protect and no cost per
      // request, so it takes neither a credential lease nor a slot of the
      // hosted RPM budget. It is also the reason a deployment with NO hosted
      // key at all is still a working install.
      const usingLocal = !usingByok && !task.forceHosted && localLaneReady();
      let lease: KeyLease | null = null;
      if (!usingByok && !usingLocal) {
        // One credential: there is nothing to choose between. Either the lane
        // can take the request now, or the task waits. The former pool version
        // scored keys by load, preferred a per-role key, and could fail over to
        // a second lane — none of which is reachable with a single key.
        if (keyLane.isEmpty()) {
          // Name the situation the operator is actually in. A local lane that
          // is configured but cooling is a completely different problem from
          // nothing being configured at all, and the old message reported both
          // as the latter.
          const local = localLaneFromEnv();
          settleTask(task, {
            ok: false,
            error: new Error(
              local
                ? `The local model at ${local.baseUrl} is not answering, and no fallback is configured. Start it, or set TRION_API_KEY for the hosted fallback.`
                : "No AI provider is configured. Set TRION_LOCAL_BASE_URL + TRION_LOCAL_MODEL for a local model, or TRION_API_KEY for the hosted one."
            ),
          });
          continue;
        }
        const waitMs = keyLane.waitMs(task.estTokens);
        if (waitMs > 0) {
          noteBlocked(task, waitMs);
          continue;
        }
        if (MIN_INTERVAL_MS > 0) {
          const spacing = MIN_INTERVAL_MS - (Date.now() - lastDispatchAt);
          if (spacing > 0) {
            await sleep(spacing);
            continue;
          }
        }
        lease = keyLane.acquire(task.estTokens);
        if (!lease) continue;
        lastDispatchAt = Date.now();
      }
      queue.splice(queue.indexOf(task), 1);
      task.route = usingLocal ? "local" : "hosted";
      inFlight += 1;
      if (!usingByok && !usingLocal) hostedInFlight += 1;
      // Something moved. A task blocked earlier in this pass may have been
      // waiting on budget that this dispatch is about to release, so give every
      // blocked task a fresh look rather than carrying a stale verdict forward.
      blocked.clear();
      blockedWakeAt = null;

      void dispatch(task, lease, usingByok, usingLocal).finally(() => {
        inFlight -= 1;
        if (!usingByok && !usingLocal) hostedInFlight -= 1;
        void pump();
      });
    }
  } finally {
    pumping = false;
  }
}

/** Run exactly one attempt. Success resolves the caller; a retryable failure
 *  re-queues the task with a delay instead of blocking this slot. */
async function dispatch(task: QueueTask, lease: KeyLease | null, usingByok: boolean, usingLocal = false): Promise<void> {
  // The deadline or a user Stop can settle a task between selection and
  // dispatch. Spending a provider request on an already-settled call is pure
  // waste against the rate ceiling and its result has nowhere to go.
  if (task.settled) {
    if (lease) keyLane.settleFailure(lease);
    return;
  }
  task.opts.onRoute?.(task.route);
  // The hosted breaker describes the hosted endpoint. A model on localhost is
  // not affected by it, and must not be withheld because the internet lane is
  // briefly in trouble — that is exactly the moment local is most useful.
  const breaker = usingByok || usingLocal ? null : hostedCircuitBreaker;
  if (breaker?.isOpen()) {
    if (lease) keyLane.settleFailure(lease);
    settleTask(task, { ok: false, error: new Error("Trion is briefly pausing requests after repeated upstream failures. Try again in a moment.") });
    return;
  }

  // Never let one attempt run past the whole call's remaining budget. Without
  // this, a 180s authoring attempt started near the deadline would keep the
  // socket open long after the caller had already been told the call failed.
  const remaining = task.expiresAt - Date.now();
  const sink = task.opts.onDelta;
  const attemptOpts: CompletionOptions = {
    ...task.opts,
    timeoutMs: Math.max(1_000, Math.min(task.opts.timeoutMs ?? REQUEST_TIMEOUT_MS, remaining)),
    // Attempt-aware, so a retry can never concatenate onto the text the failed
    // attempt already delivered. The restart fires on the first delta of the
    // new attempt rather than at dispatch, because an attempt that dies before
    // producing any token has nothing to discard.
    onDelta: sink
      ? (chunk: string) => {
          if (task.streamedAttempt !== task.attempt) {
            if (task.streamedAttempt !== undefined) task.opts.onStreamRestart?.();
            task.streamedAttempt = task.attempt;
          }
          sink(chunk);
        }
      : undefined,
  };

  const local = usingLocal ? localLaneFromEnv() : null;
  if (usingLocal && local && attemptOpts.timeoutMs && local.timeoutMs) {
    attemptOpts.timeoutMs = Math.min(attemptOpts.timeoutMs, local.timeoutMs);
  }

  try {
    const text = await callProviderText(task.messages, task.maxTokens, attemptOpts, lease?.secret, task.byok, (usage) => {
      // Correct this key's pessimistic pre-flight estimate with what it was
      // actually billed. Concurrent responses settle against their own lease.
      if (lease) keyLane.settleSuccess(lease, usage.promptTokens + usage.completionTokens);
    }, (abort) => { task.abortInFlight = abort; }, local ?? undefined);
    if (usingLocal) noteLocalSuccess();
    breaker?.breakSequence();
    settleTask(task, { ok: true, value: task.parse ? parseAgentTurn(text) : text });
  } catch (error) {
    if (task.settled) return;
    if (usingLocal) {
      await failLocal(task, error);
      return;
    }
    await settleFailure(task, error, lease, usingByok);
  } finally {
    task.abortInFlight = undefined;
  }
}

/**
 * A local attempt failed. Move THIS call to the hosted lane.
 *
 * Not a retry: the user asked one question, and answering it on a different
 * lane is not a second attempt at the same thing. `task.attempt` is deliberately
 * untouched, so a local server that is down does not silently eat the retry
 * budget the hosted lane is going to need. A user Stop and the call's absolute
 * deadline both still apply, because `requeue` and the deadline timer are
 * unchanged by which lane serves the work.
 */
async function failLocal(task: QueueTask, error: unknown): Promise<void> {
  const { cooling } = noteLocalFailure(error);
  const config = localLaneFromEnv();
  logProviderError({
    label: task.opts.label ?? "unlabelled",
    route: "local",
    endpoint: config?.baseUrl ?? "<unset>",
    model: config?.model ?? "<unset>",
    keyPresent: Boolean(config?.apiKey),
    keyLength: config?.apiKey?.length ?? 0,
    error,
  });
  perf("provider.localFailed", 0, {
    label: task.opts.label ?? "",
    cooling,
    hostedAvailable: !keyLane.isEmpty(),
  });

  // A user Stop that landed during the local call must not be converted into a
  // hosted request.
  if (task.settled) return;

  if (keyLane.isEmpty()) {
    // Nothing to fall back to. Say what failed and where, not "no provider
    // configured" — the operator configured one, and it is not answering.
    settleTask(task, {
      ok: false,
      error: new Error(
        `The local model at ${config?.baseUrl ?? "the configured address"} could not complete this request, and no hosted fallback is configured. Set TRION_API_KEY to fall back automatically.`
      ),
    });
    return;
  }

  noteLocalFallback();
  // Anything the failed local attempt already streamed is not part of the
  // answer the hosted lane is about to write.
  if (task.streamedAttempt !== undefined) {
    task.opts.onStreamRestart?.();
    task.streamedAttempt = undefined;
  }
  task.forceHosted = true;
  task.route = "hosted";
  requeue(task, "local lane unavailable");
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

async function settleFailure(task: QueueTask, error: unknown, lease: KeyLease | null, usingByok: boolean): Promise<void> {
  const api = error as ApiError;
  const status = typeof api?.status === "number" ? api.status : undefined;
  const rateLimited = isProviderRateLimited(api);
  const breaker = usingByok ? null : hostedCircuitBreaker;

  const retryAfterMs = retryDelayMs(task.attempt, api);
  // The provider can encode an account-wide quota as 503
  // `ResourceExhausted ... total request limit`. Rotating credentials after
  // that response only makes extra failed calls, so cool the pool as one unit.
  if (lease) keyLane.settleFailure(lease, rateLimited ? 429 : status, retryAfterMs);

  // A build route can report a long-lived account allowance as a
  // rate-limit-shaped 429/503. Retrying that response inside the same turn is
  // guaranteed waste: it cannot create a file, and it used to consume three
  // calls before replacing the useful cause with a generic circuit message.
  // There is no second route to advance to. With one credential the only
  // meaningful responses to a failure are: retry this same lane after the
  // provider-directed delay, or settle honestly. The former cross-provider
  // fallback chain (hosted <-> gemini) is removed along with the second lane.

  if (rateLimited) {
    // With a single credential, a rate limit IS the whole lane being cooled.
    if (!usingByok && keyLane.healthyCount() === 0 && breaker?.noteRateLimit()) {
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
  // Always honour the provider-directed delay. The old code could skip it by
  // failing over to a key with headroom; with one credential there is no such
  // key, and retrying early only spends the budget we are being asked to slow.
  task.notBefore = Date.now() + retryAfterMs;
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
      route: "hosted",
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

/** Live rate telemetry for the health route and the UI meter. One lane, so the
 *  per-route breakdown that used to split hosted vs build traffic is gone. */
export function getRateSnapshot() {
  return {
    ...keyLane.snapshot(),
    queued: queue.length,
    inFlight,
    routes: { hosted: { queued: queue.length, inFlight: hostedInFlight } },
  };
}

export function hasConfig() {
  // A local-only install is a configured install. Requiring a hosted key here
  // would report a machine that can answer every request as having no provider
  // at all, and the UI reads this to decide whether any model is selectable.
  return !keyLane.isEmpty() || localLaneFromEnv() !== null;
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
  registerAbort?: (abort: () => void) => void,
  /** Present when this attempt is being served by a model on the user's own
   *  machine. It replaces the hosted endpoint, model and credential; BYOK still
   *  outranks it, because a connection the user set up explicitly is a choice,
   *  not a default. */
  local?: LocalLaneConfig
): Promise<string> {
  const fast = opts.fast ?? false;
  const temperature = opts.temperature ?? 0.15;
  const tier = opts.tier ?? "trion-1.4";
  const model = byok
    ? (fast && byok.fastModel ? byok.fastModel : byok.model)
    : local
      ? (fast && local.fastModel ? local.fastModel : local.model)
      : providerModelForTier(tier, fast);
  const baseUrl = (byok
    ? byok.baseUrl
    : local
      ? local.baseUrl
      : (process.env.TRION_BASE_URL || process.env.NIM_BASE_URL || "https://integrate.api.nvidia.com/v1"))?.replace(/\/$/, "");
  // A local server usually wants no credential at all. An empty string is a
  // valid answer here, not a misconfiguration, so the "no usable route" check
  // below treats a local target as already authorized.
  const apiKey = byok ? byok.apiKey : local ? (local.apiKey ?? "") : providerKey;

  if (!model || !baseUrl || (!apiKey && !local)) {
    // Name the MISSING piece. The old message said only "not configured",
    // which is what let an absent TRION_API_KEY look identical to a bad model
    // id for the entire life of this bug.
    const missing = local
      ? [
          !model ? "no local model id (set TRION_LOCAL_MODEL)" : null,
          !baseUrl ? "no local base URL (set TRION_LOCAL_BASE_URL)" : null,
        ].filter(Boolean).join("; ")
      : [
          !apiKey ? "no API key (set TRION_API_KEY in .env.local)" : null,
          !model ? "no model id (set TRION_MODEL_PRIMARY)" : null,
          !baseUrl ? "no base URL (set TRION_BASE_URL)" : null,
        ].filter(Boolean).join("; ");
    const error = new Error(`Trion has no usable model route: ${missing}.`);
    logProviderError({
      label: opts.label ?? "unlabelled",
      route: byok ? "byok" : local ? "local" : "hosted",
      endpoint: baseUrl ?? "<unset>",
      model: model ?? "<unset>",
      keyPresent: Boolean(apiKey),
      keyLength: apiKey?.length ?? 0,
      error,
    });
    throw error;
  }

  const controller = new AbortController();
  // Step-3 full-file authoring has an explicit 180s ceiling. Gemini used to
  // impose an undocumented 60s transport cap here, which silently overrode
  // that bounded policy and made a healthy long JSON response look like a
  // stalled execution. Ordinary plan/decision calls still use their smaller
  // `opts.timeoutMs` budgets below; this is only the maximum they may request.
  const routeTimeout = REQUEST_TIMEOUT_MS;
  const timeoutMs = Math.max(1_000, Math.min(opts.timeoutMs ?? REQUEST_TIMEOUT_MS, routeTimeout));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  registerAbort?.(() => controller.abort());
  const started = Date.now();

  const anthropic = byok?.provider === "anthropic";
  const endpoint = anthropic ? `${baseUrl}/messages` : `${baseUrl}/chat/completions`;
  const diag = {
    label: opts.label ?? "unlabelled",
    route: byok ? "byok" : local ? "local" : "hosted",
    endpoint,
    model,
    keyPresent: Boolean(apiKey),
    keyLength: apiKey?.length ?? 0,
  };
  logProviderRequest(diag);

  try {
    const system = messages.filter((entry) => entry.role === "system").map((entry) => entry.content).join("\n\n");
    const streaming = typeof opts.onDelta === "function";
    const response = await fetch(
      endpoint,
      {
      method: "POST",
      // A keyless local server gets no Authorization header at all. Sending
      // `Bearer ` with nothing after it is not the same as sending nothing, and
      // some servers reject it outright.
      headers: anthropic
          ? { "content-type": "application/json", "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" }
          : apiKey
            ? { "content-type": "application/json", authorization: `Bearer ${apiKey}` }
            : { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(anthropic ? {
        model,
        system,
        messages: messages.filter((entry) => entry.role !== "system").map((entry) => ({ role: entry.role, content: entry.content })),
        temperature,
        max_tokens: maxTokens,
        ...(streaming ? { stream: true } : {}),
      } : {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        // Only sent when the caller has an opinion. Omitting the key leaves the
        // provider's own default in place, which is what makes it possible to
        // measure a before/after against unmodified behaviour.
        // NVIDIA-specific. A local llama.cpp/Ollama/vLLM server rejects or
        // ignores unknown body keys depending on the build, and an argument
        // this lane cannot honour is not worth risking a 400 over.
        ...(!byok && !local && typeof opts.thinking === "boolean"
          ? { chat_template_kwargs: { thinking: opts.thinking } }
          : {}),
        // Function-calling passthrough for the OpenAI-compatible route only.
        // Same omit-when-absent rule: existing callers send byte-identical
        // bodies, and the Gemini/Anthropic branches above are untouched.
        ...(opts.tools ? { tools: opts.tools } : {}),
        ...(opts.toolChoice !== undefined ? { tool_choice: opts.toolChoice } : {}),
        // `include_usage` keeps the token ledger honest on a streamed call:
        // without it the final chunk carries no usage block and every streamed
        // response would be recorded as costing zero tokens.
        ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
      })
      }
    );

    if (!response.ok) {
      // Gemini is an internal build lane, so its raw response body must never
      // become a user-facing trace or error. Treat it like a protected
      // provider error at this boundary even though it is not user BYOK.
      //
      // `toApiError` consumes the body once and keeps it on the error, so the
      // RAW status and body are logged from there rather than from a clone —
      // a Response body can only be read once. This log line is what was
      // missing while every provider failure surfaced as generic copy.
      const apiError = await toApiError(response, Boolean(byok));
      logProviderResponse({
        ...diag,
        status: response.status,
        ms: Date.now() - started,
        bodyPreview: (apiError.body ?? "").slice(0, 600),
      });
      throw apiError;
    }

    logProviderResponse({ ...diag, status: response.status, ms: Date.now() - started });

    if (streaming) {
      const streamed = await consumeEventStream(response, anthropic, opts.onDelta!);
      const usage: CompletionUsage = {
        model,
        promptTokens: streamed.promptTokens,
        completionTokens: streamed.completionTokens,
        cachedPromptTokens: streamed.cachedPromptTokens,
        ms: Date.now() - started,
      };
      onSettle?.(usage);
      opts.onUsage?.(usage);
      if ((streamed.finishReason === "length" || streamed.finishReason === "MAX_TOKENS" || streamed.finishReason === "max_tokens") && !opts.allowTruncated) {
        throw new Error("Trion response reached its output limit before the file was complete.");
      }
      const streamedContent = streamed.content || streamed.toolCallText;
      if (!streamedContent) throw new Error("Trion returned an empty response.");
      return streamedContent;
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string;
      }>;
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

    const finishReason = data.choices?.[0]?.finish_reason;
    if ((finishReason === "length" || finishReason === "MAX_TOKENS") && !opts.allowTruncated) {
      throw new Error("Trion response reached its output limit before the file was complete.");
    }

    const message = data.choices?.[0]?.message;
    // A tool_choice call typically comes back with empty content and the
    // payload in tool_calls. Serialize those calls as the text result so a
    // function-calling turn has something to parse; without this every
    // tool_choice response would die here as "empty response". Plain-text
    // turns are unaffected: they never carry tool_calls.
    const toolCallText = message?.tool_calls?.length
      ? JSON.stringify(
          message.tool_calls.map((call) => ({ name: call.function?.name, arguments: call.function?.arguments })),
        )
      : undefined;
    const content = anthropic
      ? data.content?.find((entry) => entry.type === "text")?.text
      : (message?.content || toolCallText);
    if (!content) throw new Error("Trion returned an empty response.");
    return content;
  } catch (error) {
    logProviderError({ ...diag, error });
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Trion request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

type StreamedCompletion = {
  content: string;
  toolCallText: string;
  finishReason?: string;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
};

/**
 * Suppress reasoning that leaks into the visible channel.
 *
 * Prose calls are sent with thinking off, but a reasoning model can still open
 * a `<think>` block on its own, and on a streamed call there is no post-hoc
 * sanitize between the model and the user's screen — the tokens ARE the screen.
 * This is a streaming-safe gate: it holds back a partial opening tag rather than
 * printing "<thi" and then deleting it.
 */
function createThinkFilter() {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let inside = false;
  let pending = "";

  /** Could `tail` be the start of `token`? Used to hold an incomplete tag. */
  const partialOf = (tail: string, token: string) => {
    const max = Math.min(tail.length, token.length - 1);
    for (let take = max; take > 0; take--) {
      if (token.startsWith(tail.slice(tail.length - take))) return take;
    }
    return 0;
  };

  return (chunk: string): string => {
    pending += chunk;
    let visible = "";
    for (;;) {
      if (!inside) {
        const open = pending.indexOf(OPEN);
        if (open >= 0) {
          visible += pending.slice(0, open);
          pending = pending.slice(open + OPEN.length);
          inside = true;
          continue;
        }
        const hold = partialOf(pending, OPEN);
        visible += pending.slice(0, pending.length - hold);
        pending = pending.slice(pending.length - hold);
        return visible;
      }
      const close = pending.indexOf(CLOSE);
      if (close >= 0) {
        pending = pending.slice(close + CLOSE.length);
        inside = false;
        continue;
      }
      // Still inside the reasoning block: keep only enough tail to recognise a
      // closing tag split across chunks.
      pending = pending.slice(Math.max(0, pending.length - CLOSE.length));
      return visible;
    }
  };
}

/**
 * Consume a Server-Sent Events completion, handing each visible delta to the
 * caller as it lands and returning the assembled text at the end.
 *
 * Handles both wire formats this client speaks: OpenAI-compatible
 * (`choices[].delta`) and Anthropic (`content_block_delta`). A malformed or
 * truncated `data:` line is skipped rather than failing the call — the stream is
 * a best-effort transport for text that is also fully returned at the end.
 */
async function consumeEventStream(
  response: Response,
  anthropic: boolean,
  onDelta: (chunk: string) => void
): Promise<StreamedCompletion> {
  const body = response.body;
  if (!body) throw new Error("Trion returned an empty response.");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const visible = createThinkFilter();
  const toolArgs = new Map<number, { name: string; args: string }>();
  const result: StreamedCompletion = {
    content: "",
    toolCallText: "",
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
  };

  let buffer = "";
  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }

    if (anthropic) {
      const type = event.type as string | undefined;
      if (type === "content_block_delta") {
        const delta = event.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === "text_delta" && delta.text) {
          result.content += delta.text;
          const shown = visible(delta.text);
          if (shown) onDelta(shown);
        }
        return;
      }
      if (type === "message_start") {
        const usage = (event.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number } } | undefined)?.usage;
        result.promptTokens = usage?.input_tokens ?? 0;
        result.cachedPromptTokens = usage?.cache_read_input_tokens ?? 0;
        return;
      }
      if (type === "message_delta") {
        const usage = event.usage as { output_tokens?: number } | undefined;
        if (usage?.output_tokens) result.completionTokens = usage.output_tokens;
        const stop = (event.delta as { stop_reason?: string } | undefined)?.stop_reason;
        if (stop) result.finishReason = stop;
        return;
      }
      return;
    }

    const usage = event.usage as
      | { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
      | undefined;
    if (usage) {
      result.promptTokens = usage.prompt_tokens ?? result.promptTokens;
      result.completionTokens = usage.completion_tokens ?? result.completionTokens;
      result.cachedPromptTokens = usage.prompt_tokens_details?.cached_tokens ?? result.cachedPromptTokens;
    }

    const choice = (event.choices as Array<{
      delta?: { content?: string | null; tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }> };
      finish_reason?: string | null;
    }> | undefined)?.[0];
    if (!choice) return;
    if (choice.finish_reason) result.finishReason = choice.finish_reason;
    const text = choice.delta?.content;
    if (typeof text === "string" && text) {
      result.content += text;
      const shown = visible(text);
      if (shown) onDelta(shown);
    }
    for (const call of choice.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const entry = toolArgs.get(index) ?? { name: "", args: "" };
      if (call.function?.name) entry.name = call.function.name;
      if (call.function?.arguments) entry.args += call.function.arguments;
      toolArgs.set(index, entry);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) handleLine(buffer.trim());
  } finally {
    reader.releaseLock();
  }

  if (toolArgs.size > 0) {
    result.toolCallText = JSON.stringify(
      [...toolArgs.values()].map((entry) => ({ name: entry.name, arguments: entry.args })),
    );
  }
  return result;
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

/**
 * A native function-calling reply, if that is what this is.
 *
 * When a response comes back as `tool_calls` rather than as content, this
 * client serializes the calls as `[{name, arguments}]` so the text path has
 * something to carry (see `toolCallText`). Nothing downstream understood that
 * shape, so a provider that honoured `tools` — the reliable way to get a
 * schema-correct tool call — produced an UNPARSEABLE decision, which is the
 * opposite of what asking for tools is for.
 *
 * `arguments` is a JSON string by the OpenAI spec, so it is parsed separately
 * from the envelope. A call naming a tool this agent does not have is not
 * rescued into a `finish`; it falls through to the raw-output wrapper so the
 * executor re-asks.
 */
function toolCallTurn(content: string): AgentTurn | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("[")) return null;
  let calls: unknown;
  try {
    calls = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const first = calls[0] as { name?: unknown; arguments?: unknown };
  const name = typeof first?.name === "string" ? first.name.trim() : "";
  if (!VALID_ACTIONS.has(name)) return null;

  let args: unknown = first.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args || "{}");
    } catch {
      return null;
    }
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;

  const input = args as Record<string, unknown>;
  // The schema carries `thought` alongside the call's own fields; keep it out
  // of the tool input so a tool never receives an argument it did not declare.
  const { thought, ...toolInput } = input;
  return {
    thought: typeof thought === "string" ? thought : "",
    action: name as AgentTurn["action"],
    action_input: toolInput,
    summary: typeof input.summary === "string" ? input.summary : undefined,
    done: name === "finish",
  };
}

/** Exported for tests only: the decision parser is the contract between the
 *  provider's reply and the executor, and it is worth testing directly. */
export function parseAgentTurnForTest(content: string): AgentTurn {
  return parseAgentTurn(content);
}

function parseAgentTurn(content: string): AgentTurn {
  const fromTool = toolCallTurn(content);
  if (fromTool) return fromTool;

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
    done: true,
    // Carried, not swallowed. See AgentTurn.parse_error: a caller that can
    // re-ask should re-ask rather than accept this as a finished turn.
    parse_error: "The response was not a valid tool-call object.",
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
