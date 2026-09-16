// Model tier configuration — the one authority for whether a user-selectable
// Trion tier has a real upstream route. A label must never silently fall back
// to a different model: that makes cost, latency, and quality impossible to
// reason about.

import type { AgentModel } from "./types";

/** Only string-keyed reads happen here, so the parameter is typed by what is
 *  USED rather than by NodeJS.ProcessEnv. That type now requires NODE_ENV, so
 *  demanding it forced every caller and test to fabricate unrelated fields or
 *  cast through `unknown`. process.env satisfies this structurally. */
export type ModelEnvironment = Record<string, string | undefined>;

export const AGENT_MODEL_TIERS: readonly AgentModel[] = ["trion-1.4", "trion-1.9", "trion-2.3"];
export type AgentRole = "planner" | "executor" | "verifier";

const DEFAULT_PRIMARY_MODEL = "meta/llama-3.2-11b-vision-instruct";
const DEFAULT_FAST_MODEL = "meta/llama-3.2-11b-vision-instruct";

/** `null` rather than `undefined`, matching what `configured()` returns: an
 *  env var that is absent and one that is set to whitespace are the same thing
 *  — deliberately unset — and collapsing both to one value keeps every check
 *  below a single comparison. */
type TierEnvironment = {
  primary: string | null;
  fast: string | null;
};

function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function tierEnvironment(tier: AgentModel, environment: ModelEnvironment = process.env): TierEnvironment {
  switch (tier) {
    case "trion-1.9":
      return {
        primary: configured(environment.TRION_MODEL_1_9_PRIMARY),
        fast: configured(environment.TRION_MODEL_1_9_FAST),
      };
    case "trion-2.3":
      return {
        primary: configured(environment.TRION_MODEL_2_3_PRIMARY),
        fast: configured(environment.TRION_MODEL_2_3_FAST),
      };
    case "trion-1.4":
      return {
        primary: configured(environment.TRION_MODEL_PRIMARY) ?? configured(environment.NIM_MODEL_PRIMARY) ?? DEFAULT_PRIMARY_MODEL,
        fast: configured(environment.TRION_MODEL_FAST) ?? DEFAULT_FAST_MODEL,
      };
  }
}

/** A tier is available only when every non-default tier names its own primary
 * model. We intentionally do not infer availability from an API key or reuse
 * 1.4's primary model: choosing 1.9/2.3 must be a real routing decision. */
export function isModelTierAvailable(tier: AgentModel, environment: ModelEnvironment = process.env): boolean {
  return tier === "trion-1.4" || Boolean(tierEnvironment(tier, environment).primary);
}

/** Safe to return from a public health endpoint: labels only, never provider
 * model ids or credentials. */
export function availableModelTiers(environment: ModelEnvironment = process.env): AgentModel[] {
  return AGENT_MODEL_TIERS.filter((tier) => isModelTierAvailable(tier, environment));
}

/** Resolve the actual provider model for one call. Callers must first check
 * availability; null is returned rather than falling back across tiers. Fast
 * calls use a tier-specific fast model when supplied, otherwise that tier's
 * primary model — preserving the user's selected tier at the explicit cost of
 * using a larger model for quick stages. */
export function providerModelForTier(tier: AgentModel, fast: boolean, environment: ModelEnvironment = process.env): string | null {
  const config = tierEnvironment(tier, environment);
  if (!config.primary) return null;
  return fast ? config.fast ?? config.primary : config.primary;
}

/**
 * Role routing is an explicit configuration decision, separate from API-key
 * routing. A missing or unavailable role tier falls back to the tier the user
 * selected; it never masquerades as a different model. This lets a deployment
 * use, for example, a deliberate planner, an implementation model, and an
 * evidence verifier without making model choice depend on credentials.
 */
export function tierForRole(
  selected: AgentModel,
  role: AgentRole,
  environment: ModelEnvironment = process.env
): AgentModel {
  const configuredTier = role === "planner"
    ? environment.TRION_PLANNER_TIER
    : role === "executor"
      ? environment.TRION_EXECUTOR_TIER
      : environment.TRION_VERIFIER_TIER;
  const candidate = AGENT_MODEL_TIERS.includes(configuredTier as AgentModel)
    ? configuredTier as AgentModel
    : selected;
  return isModelTierAvailable(candidate, environment) ? candidate : selected;
}
