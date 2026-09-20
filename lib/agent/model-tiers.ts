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

// Verified live against the configured endpoint on 2026-09-18.
//
// PRIMARY is the deep-reasoning model: execution decisions and full-file code
// authoring (`fast: false`). PRIMARY is deliberately the largest model here —
// this is an agentic coding product, and the quality of the written code is the
// product.
//
// FAST serves classification, planning, synthesis and the review chain
// (`fast: true`). It is NOT a throwaway tier: planning runs here, so it has to
// be genuinely capable. Measured on a planning prompt: 11.8s / 11.9s, clean
// `stop`, valid plan JSON.
//
// The previous FAST default, `nvidia/nemotron-3-nano-30b-a3b`, was DEAD — the
// endpoint answers HTTP 410 Gone, end-of-life 2026-09-01. Because planning is a
// fast-tier call, that alone broke every build request on a default install.
// `nvidia/nemotron-3.5-lightning-30b-a3b` was also evaluated and rejected: it
// does not stop (finish_reason "length" at a 1200-token cap on both runs).
const DEFAULT_PRIMARY_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const DEFAULT_FAST_MODEL = "nvidia/nemotron-3-super-120b-a12b";

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
        primary: configured(environment.COLIBRI_MODEL) ?? configured(environment.TRION_MODEL_PRIMARY) ?? configured(environment.NIM_MODEL_PRIMARY) ?? DEFAULT_PRIMARY_MODEL,
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

/**
 * Does this deployment hold ANY server-side credential able to answer a turn?
 *
 * This is deliberately separate from `isModelTierAvailable`, which answers a
 * different question ("is a model id configured for this label?") and returns
 * true for trion-1.4 unconditionally. Conflating the two is what let the app
 * advertise `availableModels: ["trion-1.4"]` and accept every chat request
 * while holding zero keys — so every non-preset message died deep in the stack
 * as a generic "Trion paused" instead of a configuration error at the door.
 *
 * BYOK requests supply their own credential and are checked by the caller.
 */
export function hasProviderCredential(environment: ModelEnvironment = process.env): boolean {
  // ONE supported name. The numbered pool variables and the Gemini lane keys
  // are gone from the codebase, so accepting them here would report a
  // credential the dispatcher cannot actually use. `NIM_API_KEY` survives only
  // as a rename alias so an older deployment does not lose its key on upgrade.
  return Boolean(configured(environment.TRION_API_KEY) ?? configured(environment.NIM_API_KEY));
}
