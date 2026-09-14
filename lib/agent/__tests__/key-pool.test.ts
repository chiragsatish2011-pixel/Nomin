import { describe, expect, it } from "vitest";
import { createKeyPool, providerKeysFromEnv } from "../../nim/key-pool";

function poolHarness() {
  let time = 1_000_000;
  const pool = createKeyPool(
    ["a", "b", "c"].map((secret, index) => ({ id: `key-${index + 1}`, secret, rpm: 2, tpm: 0 })),
    { now: () => time, cooldownMs: 60_000, independentBilling: true }
  );
  return { pool, advance: (ms: number) => { time += ms; } };
}

describe("provider key pool", () => {

  it("spreads concurrent independent work across the least-loaded keys", () => {
    const { pool } = poolHarness();
    const leases = Array.from({ length: 6 }, () => {
      const choice = pool.pick(100);
      expect(choice.waitMs).toBe(0);
      return pool.acquire(choice.keyId!, 100)!;
    });
    expect(leases.map((lease) => lease.keyId)).toEqual(["key-1", "key-2", "key-3", "key-1", "key-2", "key-3"]);
    expect(pool.pick(100).waitMs).toBeGreaterThan(0);
  });

  it("uses all five configured credentials in least-loaded order", () => {
    const pool = createKeyPool(
      ["a", "b", "c", "d", "e"].map((secret, index) => ({ id: `key-${index + 1}`, secret, rpm: 40, tpm: 0 })),
      { independentBilling: true }
    );
    const leases = Array.from({ length: 5 }, () => {
      const choice = pool.pick(100);
      expect(choice.waitMs).toBe(0);
      return pool.acquire(choice.keyId!, 100)!;
    });
    expect(leases.map((lease) => lease.keyId)).toEqual(["key-1", "key-2", "key-3", "key-4", "key-5"]);
  });

  it("cools a rate-limited key and immediately selects a healthy alternative", () => {
    const { pool } = poolHarness();
    const firstChoice = pool.pick(100);
    const first = pool.acquire(firstChoice.keyId!, 100)!;
    pool.settleFailure(first, 429, 5_000);

    const retryChoice = pool.pick(100);
    expect(retryChoice.waitMs).toBe(0);
    expect(retryChoice.keyId).not.toBe(first.keyId);
    expect(pool.hasAlternative(first.keyId, 100)).toBe(true);
    expect(pool.snapshot().keys.find((key) => key.id === first.keyId)?.coolingDown).toBe(true);
  });

  it("tracks each key rate window independently under simulated load", () => {
    const { pool, advance } = poolHarness();
    for (let index = 0; index < 6; index++) {
      const choice = pool.pick(100);
      const lease = pool.acquire(choice.keyId!, 100)!;
      pool.settleSuccess(lease, 25);
    }
    expect(pool.snapshot().requestsInWindow).toBe(6);
    expect(pool.snapshot().configuredRpm).toBe(6);
    expect(pool.pick(100).waitMs).toBeGreaterThan(0);
    advance(60_000);
    expect(pool.pick(100).waitMs).toBe(0);
  });

  it("uses one shared trial budget by default instead of multiplying capacity by key count", () => {
    let time = 1_000_000;
    const pool = createKeyPool(
      ["a", "b", "c"].map((secret, index) => ({ id: `key-${index + 1}`, secret, rpm: 2, tpm: 0 })),
      { now: () => time, cooldownMs: 60_000 }
    );
    for (let index = 0; index < 2; index++) {
      const choice = pool.pick(100);
      const lease = pool.acquire(choice.keyId!, 100)!;
      pool.settleSuccess(lease, 25);
    }
    expect(pool.snapshot()).toMatchObject({ configuredRpm: 2, requestsInWindow: 2 });
    expect(pool.pick(100).waitMs).toBeGreaterThan(0);
    time += 60_000;
    expect(pool.pick(100).waitMs).toBe(0);
  });

  it("cools every key after an account-wide quota response", () => {
    const { pool } = (() => {
      const time = 1_000_000;
      return {
        pool: createKeyPool(
          ["a", "b", "c"].map((secret, index) => ({ id: `key-${index + 1}`, secret, rpm: 40, tpm: 0 })),
          { now: () => time, cooldownMs: 60_000 }
        ),
      };
    })();
    const choice = pool.pick(100);
    const lease = pool.acquire(choice.keyId!, 100)!;
    pool.settleFailure(lease, 429, 5_000, true);
    expect(pool.snapshot().keys.every((key) => key.coolingDown)).toBe(true);
    expect(pool.pick(100).waitMs).toBeGreaterThanOrEqual(60_000);
  });
});
