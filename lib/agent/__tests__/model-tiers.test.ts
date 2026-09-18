import { describe, expect, it } from "vitest";
import { availableModelTiers, isModelTierAvailable, providerModelForTier } from "../model-tiers";

describe("model tier routing", () => {
  it("keeps unconfigured tiers unavailable instead of relabeling 1.4", () => {
    const environment = {
      TRION_MODEL_PRIMARY: "primary-14",
      TRION_MODEL_FAST: "fast-14",
    };

    expect(availableModelTiers(environment)).toEqual(["trion-1.4"]);
    expect(isModelTierAvailable("trion-1.9", environment)).toBe(false);
    expect(providerModelForTier("trion-1.9", false, environment)).toBeNull();
  });

  it("routes every call stage to a configured tier, with an optional fast route", () => {
    const environment = {
      TRION_MODEL_PRIMARY: "primary-14",
      TRION_MODEL_FAST: "fast-14",
      TRION_MODEL_1_9_PRIMARY: "primary-19",
      TRION_MODEL_1_9_FAST: "fast-19",
      TRION_MODEL_2_3_PRIMARY: "primary-23",
    };

    expect(availableModelTiers(environment)).toEqual(["trion-1.4", "trion-1.9", "trion-2.3"]);
    expect(providerModelForTier("trion-1.9", false, environment)).toBe("primary-19");
    expect(providerModelForTier("trion-1.9", true, environment)).toBe("fast-19");
    // No fast route means no hidden cross-tier fallback: use the selected
    // tier's configured primary, with its explicit latency/cost tradeoff.
    expect(providerModelForTier("trion-2.3", true, environment)).toBe("primary-23");
  });

  it("preserves the existing 1.4 defaults", () => {
    const environment = {};
    expect(providerModelForTier("trion-1.4", false, environment)).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    // The previous default here, `nvidia/nemotron-3-nano-30b-a3b`, was retired by
    // the provider (HTTP 410 Gone, EOL 2026-09-01). Because planning is a
    // fast-tier call, that dead id broke every build request on a default install.
    expect(providerModelForTier("trion-1.4", true, environment)).toBe("nvidia/nemotron-3-super-120b-a12b");
  });
});
