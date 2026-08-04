import { NextResponse } from "next/server";
import { capacityOverview } from "@/lib/agent/token-ledger";
import { getRateSnapshot, hasConfig } from "@/lib/nim/internal-client";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get("sessionId") ?? undefined;
  const rate = getRateSnapshot();
  return NextResponse.json({
    ready: hasConfig(),
    requestWindow: {
      used: rate.requestsInWindow,
      limit: rate.effectiveRpm,
      saturation: rate.saturation,
    },
    activity: {
      planning: rate.routes.geminiBuild.queued,
      building: rate.routes.geminiBuild.queued + rate.routes.geminiBuild.inFlight,
    },
    ...capacityOverview(new Date(), sessionId),
  });
}
