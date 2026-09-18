import { NextResponse } from "next/server";
import { getSessionCount } from "@/lib/agent/session-store";
import { getCircuitState, getQueueDepth, getRateSnapshot, hasConfig } from "@/lib/nim/internal-client";
import { availableModelTiers, hasProviderCredential } from "@/lib/agent/model-tiers";
import { getPendingApprovalCount, getPendingExecutionCount } from "@/lib/agent/execution/bridge";

export async function GET() {
  // Keep this diagnostic payload provider-neutral: it is a user-facing route,
  // so it reports service health rather than implementation/vendor names.
  return NextResponse.json({
    ok: true,
    service: "trion-web",
    // Deploy marker: Vercel injects VERCEL_GIT_COMMIT_SHA at build time.
    // Compare against git HEAD to rule out stale-bundle incidents before
    // debugging behavior that "should already be fixed".
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
    // Static pipeline marker: present only in bundles containing the
    // tool_choice plan path. If a deployed /health lacks this key, the
    // deployment predates Task 4 no matter what the dashboard claims.
    planPipeline: "tool_choice/plan_tools",
    modelProviderConfigured: hasConfig(),
    sessions: getSessionCount(),
    modelQueueDepth: getQueueDepth(),
    modelCircuit: getCircuitState(),
    pendingApprovals: getPendingApprovalCount(),
    pendingBrowserExecutions: getPendingExecutionCount(),
    // A tier label is only genuinely selectable when this deployment also holds
    // a credential able to serve it. Reporting ["trion-1.4"] with zero keys is
    // what made a completely unconfigured server look healthy.
    availableModels: hasProviderCredential() ? availableModelTiers() : [],
    providerCredentialPresent: hasProviderCredential(),
    rate: getRateSnapshot()
  });
}
