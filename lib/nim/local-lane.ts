/**
 * The local model lane.
 *
 * A locally hosted model — Ollama, LM Studio, llama.cpp's server, vLLM, or
 * anything else that speaks the OpenAI chat-completions shape — is the best
 * lane this app can have when it exists: no shared rate ceiling, no per-request
 * cost, no network round trip, and nothing about the user's code leaving their
 * machine. It is also the lane most likely to be absent, half-configured, or
 * serving a model that was unloaded five minutes ago.
 *
 * So it is treated as PREFERRED BUT UNTRUSTED. Every call tries local first;
 * a local failure does not fail the user's turn, it moves that same call to the
 * hosted NVIDIA lane. Repeated failures stop the attempt entirely for a cooling
 * window, because a dead port should cost one connection refusal per minute,
 * not one in front of every model call in a build.
 *
 * Configuration is two variables. Both must be present — a base URL with no
 * model id cannot be called, and a model id with no base URL has nowhere to go:
 *
 *   TRION_LOCAL_BASE_URL   e.g. http://127.0.0.1:11434/v1   (Ollama)
 *                               http://127.0.0.1:1234/v1    (LM Studio)
 *                               http://127.0.0.1:8000/v1    (vLLM)
 *   TRION_LOCAL_MODEL      the model id that server serves
 *
 * Optional:
 *   TRION_LOCAL_FAST_MODEL a smaller local model for classification/synthesis
 *   TRION_LOCAL_API_KEY    only if the local server demands one
 *   TRION_LOCAL_TIMEOUT_MS per-request ceiling for the local lane
 *   TRION_LOCAL_DISABLED=1 keep the configuration but stop using the lane
 */

export type LocalLaneConfig = {
  baseUrl: string;
  model: string;
  fastModel?: string;
  apiKey?: string;
  timeoutMs?: number;
};

/** After this many consecutive failures the lane is parked for a cooldown. */
const FAILURES_BEFORE_COOLDOWN = 3;
/** How long to stop trying. One connection refusal a minute, not one per call. */
const COOLDOWN_MS = 60_000;
/**
 * A local model that cannot answer in this long is not helping. The hosted lane
 * budgets up to 180s because a request crossing the internet to a 550B model
 * legitimately takes that long; a localhost socket that has not produced a
 * token in 60s is a model that is not loaded, a GPU that is thrashing, or a
 * server that is wedged — all three are better served by failing over.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

function positiveNumber(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function localLaneFromEnv(env: Record<string, string | undefined> = process.env): LocalLaneConfig | null {
  if (env.TRION_LOCAL_DISABLED === "1") return null;
  const baseUrl = env.TRION_LOCAL_BASE_URL?.trim().replace(/\/$/, "");
  const model = env.TRION_LOCAL_MODEL?.trim();
  if (!baseUrl || !model) return null;
  return {
    baseUrl,
    model,
    fastModel: env.TRION_LOCAL_FAST_MODEL?.trim() || undefined,
    apiKey: env.TRION_LOCAL_API_KEY?.trim() || undefined,
    timeoutMs: positiveNumber(env.TRION_LOCAL_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
  };
}

/** Health is per-process and deliberately in-memory: it is a description of a
 *  socket on this machine right now, not a fact worth persisting. */
type LocalHealth = {
  consecutiveFailures: number;
  coolingUntil: number;
  lastError: string | null;
  calls: number;
  failures: number;
  fallbacks: number;
};

const health: LocalHealth = {
  consecutiveFailures: 0,
  coolingUntil: 0,
  lastError: null,
  calls: 0,
  failures: 0,
  fallbacks: 0,
};

export function localLaneReady(now: () => number = Date.now): boolean {
  return localLaneFromEnv() !== null && health.coolingUntil <= now();
}

export function noteLocalSuccess(): void {
  health.consecutiveFailures = 0;
  health.coolingUntil = 0;
  health.lastError = null;
  health.calls += 1;
}

/**
 * Record a local failure and say whether the lane is now parked.
 *
 * Connection-level failures (refused, DNS, timeout) mean the server is not
 * there; those count toward the cooldown. So does everything else, because
 * from this side there is no useful difference between "the model id is wrong"
 * and "the server is wedged" — both need a human, and neither gets better by
 * being retried on the next call.
 */
export function noteLocalFailure(error: unknown, now: () => number = Date.now): { cooling: boolean } {
  health.consecutiveFailures += 1;
  health.failures += 1;
  health.lastError = error instanceof Error ? error.message : String(error);
  if (health.consecutiveFailures >= FAILURES_BEFORE_COOLDOWN) {
    health.coolingUntil = now() + COOLDOWN_MS;
    return { cooling: true };
  }
  return { cooling: false };
}

export function noteLocalFallback(): void {
  health.fallbacks += 1;
}

/** For the health route. Never includes the local URL's credential. */
export function localLaneSnapshot(now: number = Date.now()) {
  const config = localLaneFromEnv();
  return {
    configured: config !== null,
    baseUrl: config?.baseUrl ?? null,
    model: config?.model ?? null,
    fastModel: config?.fastModel ?? null,
    ready: config !== null && health.coolingUntil <= now,
    coolingDown: health.coolingUntil > now,
    consecutiveFailures: health.consecutiveFailures,
    calls: health.calls,
    failures: health.failures,
    /** Calls that ran locally, failed, and were completed by the hosted lane. */
    fallbacks: health.fallbacks,
    lastError: health.lastError,
  };
}

/** Tests only: forget the health this process has accumulated. */
export function resetLocalLaneHealth(): void {
  health.consecutiveFailures = 0;
  health.coolingUntil = 0;
  health.lastError = null;
  health.calls = 0;
  health.failures = 0;
  health.fallbacks = 0;
}
