import { NextResponse } from "next/server";
import { abortSessionExecutions, closePlanApproval } from "@/lib/agent/execution/bridge";
import { cancelActiveTurn } from "@/lib/agent/turn-control";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null) as { sessionId?: unknown } | null;
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
  if (!sessionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
    return NextResponse.json({ error: "A valid session is required." }, { status: 400 });
  }

  const cancelled = cancelActiveTurn(sessionId);
  abortSessionExecutions(sessionId);
  closePlanApproval(sessionId);
  return NextResponse.json({ ok: true, cancelled });
}

