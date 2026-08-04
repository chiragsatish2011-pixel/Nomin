import { createRateGovernor, type RateGovernor } from "./rate-governor";

/** A key is a throughput bucket, never a model-tier assignment. Keep the pool
 * deliberately small: more keys are not an authorization to evade provider
 * limits or to multiply trial accounts. */
// Five is a configuration ceiling, not a permission to multiply a shared
// provider allowance. The shared governor below remains the default.
export const MAX_PROVIDER_KEYS = 5;

export type ProviderKeyConfig = {
  id: string;
  secret: string;
  rpm: number;
  tpm: number;
};

type KeyState = ProviderKeyConfig & {
  governor: RateGovernor;
  inFlight: number;
  coolingUntil: number;
};

export type KeyLease = {
  keyId: string;
  secret: string;
  tokenChargeId?: number;
  sharedTokenChargeId?: number;
  estTokens: number;
};

export type KeyPool = ReturnType<typeof createKeyPool>;

/** Read pool credentials only from process environment. Values are never
 * returned in telemetry, error messages, or test snapshots. */
export function providerKeysFromEnv(env: Record<string, string | undefined> = process.env): ProviderKeyConfig[] {
  const enabled = env.TRION_KEY_POOL_ENABLED === "1" && env.TRION_KEY_POOL_TOS_CONFIRMED === "1";
  const rawPool = enabled ? (env.TRION_API_KEYS ?? env.NIM_API_KEYS ?? "") : "";
  const candidates = rawPool
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);

  // Numbered variables are easier to manage in hosted secret stores than one
  // comma-separated value. They are accepted only under the same explicit gate.
  if (enabled) {
    for (let index = 1; index <= MAX_PROVIDER_KEYS; index++) {
      const value = env[`TRION_API_KEY_${index}`] ?? env[`NIM_API_KEY_${index}`];
      if (value?.trim()) candidates.push(value.trim());
    }
  }

  // Existing installations remain exactly one-key until the pool is explicitly
  // enabled and acknowledged. This preserves the previous production behavior.
  if (!candidates.length) {
    const legacy = env.TRION_API_KEY ?? env.NIM_API_KEY;
    if (legacy?.trim()) candidates.push(legacy.trim());
  }

  const seen = new Set<string>();
  return candidates
    .filter((secret) => {
      if (seen.has(secret)) return false;
      seen.add(secret);
      return true;
    })
    .slice(0, MAX_PROVIDER_KEYS)
    .map((secret, index) => ({
      id: `key-${index + 1}`,
      secret,
      rpm: positiveNumber(env.TRION_RPM_LIMIT, 40),
      tpm: positiveNumber(env.TRION_TPM_LIMIT, 0),
    }));
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function createKeyPool(
  configs: ProviderKeyConfig[],
  options: {
    now?: () => number;
    cooldownMs?: number;
    minRpm?: number;
    /** NIM trial capacity is account-wide unless the deployment explicitly
     * proves otherwise. Never multiply a shared allowance by key count. */
    independentBilling?: boolean;
  } = {}
) {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? 60_000;
  const states: KeyState[] = configs.slice(0, MAX_PROVIDER_KEYS).map((config) => ({
    ...config,
    governor: createRateGovernor({ rpm: config.rpm, tpm: config.tpm, minRpm: options.minRpm ?? 4, now }),
    inFlight: 0,
    coolingUntil: 0,
  }));
  // Credentials can improve availability, but they are not evidence of
  // separate rate-limit allocations. Keep one shared trial budget unless a
  // deployment with independently billed pools opted in explicitly.
  const sharedGovernor = options.independentBilling || !states.length
    ? null
    : createRateGovernor({
      rpm: states[0].rpm,
      tpm: states[0].tpm,
      minRpm: options.minRpm ?? 4,
      now,
    });

  function pick(estTokens: number, preferredKeyId?: string): { keyId?: string; waitMs: number } {
    const at = now();
    const sharedWait = sharedGovernor?.waitMs(estTokens) ?? 0;
    if (sharedWait > 0) return { waitMs: sharedWait };
    const eligible = states.filter((state) => state.coolingUntil <= at);
    if (!eligible.length) {
      const next = states.reduce((earliest, state) => Math.min(earliest, state.coolingUntil), Number.POSITIVE_INFINITY);
      return { waitMs: Number.isFinite(next) ? Math.max(1, next - at) : 0 };
    }

    const ready = eligible.filter((state) => state.governor.waitMs(estTokens) === 0);
    const preferred = preferredKeyId ? (ready.length ? ready : eligible).find((state) => state.id === preferredKeyId) : undefined;
    const candidates = preferred ? [preferred] : ready.length ? ready : eligible;
    const selected = [...candidates].sort((left, right) => {
      const leftSnapshot = left.governor.snapshot();
      const rightSnapshot = right.governor.snapshot();
      const leftLoad = left.inFlight + leftSnapshot.saturation;
      const rightLoad = right.inFlight + rightSnapshot.saturation;
      if (leftLoad !== rightLoad) return leftLoad - rightLoad;
      return left.id.localeCompare(right.id);
    })[0];

    return { keyId: selected.id, waitMs: selected.governor.waitMs(estTokens) };
  }

  function acquire(keyId: string, estTokens: number): KeyLease | null {
    const state = states.find((entry) => entry.id === keyId);
    if (!state || state.coolingUntil > now() || state.governor.waitMs(estTokens) > 0 || (sharedGovernor?.waitMs(estTokens) ?? 0) > 0) return null;
    state.inFlight += 1;
    return {
      keyId: state.id,
      secret: state.secret,
      estTokens,
      tokenChargeId: state.governor.charge(estTokens),
      sharedTokenChargeId: sharedGovernor?.charge(estTokens),
    };
  }

  function settleSuccess(lease: KeyLease, actualTokens: number) {
    const state = states.find((entry) => entry.id === lease.keyId);
    if (!state) return;
    state.inFlight = Math.max(0, state.inFlight - 1);
    state.governor.settle(lease.estTokens, actualTokens, lease.tokenChargeId);
    sharedGovernor?.settle(lease.estTokens, actualTokens, lease.sharedTokenChargeId);
  }

  function settleFailure(lease: KeyLease, status?: number, retryAfterMs?: number, accountWide = false) {
    const state = states.find((entry) => entry.id === lease.keyId);
    if (!state) return;
    state.inFlight = Math.max(0, state.inFlight - 1);
    state.governor.settle(lease.estTokens, 0, lease.tokenChargeId);
    sharedGovernor?.settle(lease.estTokens, 0, lease.sharedTokenChargeId);
    const rateLimited = status === 429 || accountWide;
    if (rateLimited) {
      state.governor.penalize();
      sharedGovernor?.penalize();
    }
    if (status === 429 || status === 503 || accountWide) {
      const until = now() + Math.max(cooldownMs, retryAfterMs ?? 0);
      if (accountWide || sharedGovernor) {
        for (const entry of states) entry.coolingUntil = Math.max(entry.coolingUntil, until);
      } else {
        state.coolingUntil = until;
      }
    }
  }

  function hasAlternative(excludingKeyId: string, estTokens: number): boolean {
    const at = now();
    if ((sharedGovernor?.waitMs(estTokens) ?? 0) > 0) return false;
    return states.some((state) => state.id !== excludingKeyId && state.coolingUntil <= at && state.governor.waitMs(estTokens) === 0);
  }

  function healthyCount(): number {
    const at = now();
    return states.filter((state) => state.coolingUntil <= at).length;
  }

  function snapshot() {
    const rows = states.map((state) => {
      const rate = state.governor.snapshot();
      return {
        id: state.id,
        configuredRpm: rate.configuredRpm,
        effectiveRpm: rate.effectiveRpm,
        requestsInWindow: rate.requestsInWindow,
        tokensInWindow: rate.tokensInWindow,
        tpm: rate.tpm,
        inFlight: state.inFlight,
        coolingDown: state.coolingUntil > now(),
      };
    });
    const shared = sharedGovernor?.snapshot();
    return {
      keyCount: rows.length,
      configuredRpm: shared?.configuredRpm ?? rows.reduce((sum, row) => sum + row.configuredRpm, 0),
      effectiveRpm: shared?.effectiveRpm ?? rows.reduce((sum, row) => sum + row.effectiveRpm, 0),
      requestsInWindow: shared?.requestsInWindow ?? rows.reduce((sum, row) => sum + row.requestsInWindow, 0),
      tokensInWindow: shared?.tokensInWindow ?? rows.reduce((sum, row) => sum + row.tokensInWindow, 0),
      saturation: rows.length
        ? (shared?.saturation ?? Math.min(1, rows.reduce((sum, row) => sum + row.requestsInWindow, 0) / Math.max(1, rows.reduce((sum, row) => sum + row.effectiveRpm, 0))))
        : 0,
      keys: rows,
    };
  }

  return { pick, acquire, settleSuccess, settleFailure, hasAlternative, healthyCount, snapshot, isEmpty: () => states.length === 0 };
}
