import { NextResponse } from "next/server";
import { resolvePlanApproval, type ApprovalDecision } from "@/lib/agent/execution/bridge";

// POST /api/trion/approval — the client's answer to the Step 1.5 plan gate.
// While the gate is pending, the server's turn is blocked; this endpoint
// releases it. "approve" lets Step 3 begin; "cancel" ends the turn cleanly.

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { sessionId, decision } = (body ?? {}) as { sessionId?: unknown; decision?: unknown };

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return NextResponse.json({ error: "approval requires a sessionId." }, { status: 400 });
  }
  if (decision !== "approve" && decision !== "cancel") {
    return NextResponse.json({ error: "approval requires decision: 'approve' | 'cancel'." }, { status: 400 });
  }

  const resolved = resolvePlanApproval(sessionId, decision as ApprovalDecision);
  if (!resolved) {
    return NextResponse.json({ error: "No approval request is pending for this session." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, decision });
}
