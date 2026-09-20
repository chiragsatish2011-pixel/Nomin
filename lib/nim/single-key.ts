import { createRateGovernor } from "./rate-governor";

/**
 * ONE credential, ONE budget, ONE lane.
 *
 * This replaces the former `key-pool.ts`, which modelled up to five keys with
 * per-key governors, a shared-account governor, cooldown rotation and
 * "is there a healthier alternative" failover. All of that machinery existed to
 * spread load across credentials this deployment does not have: the pool was
 * gated behind TRION_KEY_POOL_ENABLED + TRION_KEY_POOL_TOS_CONFIRMED and, in
 * practice, always collapsed to a single key — so every one of those branches
 * was dead weight on the only path that ever ran.
 *
 * With one key there is no selection decision to make. What remains is the part
 * that genuinely matters on a single shared free-tier credential: pace requests
 * so we do not trip the provider's rate limit, and back off when it says 429.
 */

export type ProviderKeyConfig = {
  secret: string;
  rpm: number;
  tpm: number;
};

export type KeyLease = {
  secret: string;
  tokenChargeId?: number;
  estTokens: number;
};

export type KeyLane = ReturnType<typeof createKeyLane>;

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Read THE key. Numbered variants (TRION_API_KEY_1..5) and the comma-separated
 * TRION_API_KEYS list are gone; `TRION_API_KEY` is the single supported name,
 * with `NIM_API_KEY` kept only as a rename alias so an older deployment does
 * not silently lose its credential on upgrade.
 */
export function providerKeyFromEnv(env: Record<string, string | undefined> = process.env): ProviderKeyConfig | null {
  const secret = (env.COLIBRI_API_KEY ?? env.TRION_API_KEY ?? env.NIM_API_KEY)?.trim();
  if (!secret) return null;
  return {
    secret,
    rpm: positiveNumber(env.TRION_RPM_LIMIT, 40),
    tpm: positiveNumber(env.TRION_TPM_LIMIT, 0),
  };
}

export function createKeyLane(
  config: ProviderKeyConfig | null,
  options: { now?: () => number; cooldownMs?: number; minRpm?: number } = {}
) {
  const now = options.now ?? Date.now;
  // 60s with a POOL meant "park this key, use another one". With a single
  // credential there is no other one, so a flat 60s cooldown is 60s of total
  // downtime for the whole app after one 429. The caller always supplies a
  // computed delay (the provider's own retry-after, else exponential backoff),
  // so this default only covers the case where nothing at all is known.
  const cooldownMs = options.cooldownMs ?? 5_000;
  const governor = config
    ? createRateGovernor({ rpm: config.rpm, tpm: config.tpm, minRpm: options.minRpm ?? 4, now })
    : null;
  let inFlight = 0;
  let coolingUntil = 0;

  /** How long until this lane can accept a request. 0 means "go now". */
  function waitMs(estTokens: number): number {
    if (!governor) return 0;
    const cooling = Math.max(0, coolingUntil - now());
    return Math.max(cooling, governor.waitMs(estTokens));
  }

  function acquire(estTokens: number): KeyLease | null {
    if (!config || !governor || waitMs(estTokens) > 0) return null;
    inFlight += 1;
    return { secret: config.secret, estTokens, tokenChargeId: governor.charge(estTokens) };
  }

  function settleSuccess(lease: KeyLease, actualTokens: number) {
    if (!governor) return;
    inFlight = Math.max(0, inFlight - 1);
    governor.settle(lease.estTokens, actualTokens, lease.tokenChargeId);
  }

  function settleFailure(lease: KeyLease, status?: number, retryAfterMs?: number) {
    if (!governor) return;
    inFlight = Math.max(0, inFlight - 1);
    governor.settle(lease.estTokens, 0, lease.tokenChargeId);
    // Sustained pressure is handled by the governor, which halves effective RPM
    // on a 429 and recovers additively. That is the mechanism that should slow
    // a single key down — it paces every later request instead of blocking all
    // of them for a fixed window.
    if (status === 429) governor.penalize();
    if (status === 429 || status === 503) {
      // Honour the provider EXACTLY. The old `Math.max(60s, retryAfter)` floor
      // overrode a provider that said "retry now" and idled the only lane for a
      // full minute; with one credential that is the entire app stalling.
      coolingUntil = Math.max(coolingUntil, now() + (retryAfterMs ?? cooldownMs));
    }
  }

  /** 1 when the single credential is usable right now, 0 while it is cooling. */
  function healthyCount(): number {
    return config && coolingUntil <= now() ? 1 : 0;
  }

  function snapshot() {
    const rate = governor?.snapshot();
    return {
      keyCount: config ? 1 : 0,
      configuredRpm: rate?.configuredRpm ?? 0,
      effectiveRpm: rate?.effectiveRpm ?? 0,
      requestsInWindow: rate?.requestsInWindow ?? 0,
      tokensInWindow: rate?.tokensInWindow ?? 0,
      saturation: rate?.saturation ?? 0,
      inFlight,
      coolingDown: coolingUntil > now(),
    };
  }

  return { waitMs, acquire, settleSuccess, settleFailure, healthyCount, snapshot, isEmpty: () => !config };
}
