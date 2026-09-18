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
    // One lane now serves every stage, so "planning" and "building" are no
    // longer separable by route. Report the single lane's real queue and
    // in-flight counts rather than inventing a split that no longer exists.
    // One lane now serves every stage, so these are no longer a per-route
    // split. The field NAMES are kept because the UI reads them: "planning"
    // means work is waiting for the lane, "building" means waiting or running.
    activity: {
      planning: rate.routes.hosted.queued,
      building: rate.routes.hosted.queued + rate.routes.hosted.inFlight,
    },
    ...capacityOverview(new Date(), sessionId),
  });
}
