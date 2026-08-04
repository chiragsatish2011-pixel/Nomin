import { NextResponse } from "next/server";
import { getSessionCount } from "@/lib/agent/session-store";
import { getCircuitState, getQueueDepth, getRateSnapshot, hasConfig } from "@/lib/nim/internal-client";
import { availableModelTiers } from "@/lib/agent/model-tiers";
import { getPendingApprovalCount, getPendingExecutionCount } from "@/lib/agent/execution/bridge";

export async function GET() {
  // Keep this diagnostic payload provider-neutral: it is a user-facing route,
  // so it reports service health rather than implementation/vendor names.
  return NextResponse.json({
    ok: true,
    service: "trion-web",
    modelProviderConfigured: hasConfig(),
    sessions: getSessionCount(),
    modelQueueDepth: getQueueDepth(),
    modelCircuit: getCircuitState(),
    pendingApprovals: getPendingApprovalCount(),
    pendingBrowserExecutions: getPendingExecutionCount(),
    availableModels: availableModelTiers(),
    rate: getRateSnapshot()
  });
}
