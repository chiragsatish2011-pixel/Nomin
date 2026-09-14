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
      used: rate.hosted.pool.requestsInWindow,
      limit: rate.hosted.pool.effectiveRpm,
      saturation: rate.hosted.pool.saturation,
    },
    activity: {
      planning: rate.hosted.queued,
      building: rate.hosted.queued + rate.inFlight,
    },
    ...capacityOverview(new Date(), sessionId),
  });
}
