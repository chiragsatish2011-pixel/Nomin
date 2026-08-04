import { NextResponse } from "next/server";
import { touchClientExecution } from "@/lib/agent/execution/bridge";

/** Keep a live browser tool connected while it installs, builds, or starts.
 * This does not advance the agent or reveal any workspace data. */
export async function POST(request: Request) {
  let body: { sessionId?: unknown; executionId?: unknown };
  try {
    body = await request.json() as { sessionId?: unknown; executionId?: unknown };
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const executionId = typeof body.executionId === "string" ? body.executionId : "";
  if (!sessionId || !executionId) {
    return NextResponse.json({ error: "sessionId and executionId are required." }, { status: 400 });
  }
  const active = touchClientExecution(sessionId, executionId);
  return NextResponse.json({ ok: active }, { status: active ? 200 : 404 });
}
