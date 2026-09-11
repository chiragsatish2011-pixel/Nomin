import { NextResponse } from "next/server";
import { resolveClientExecution } from "@/lib/agent/execution/bridge";
import type { ToolResult } from "@/lib/agent/types";

type ToolResultRequest = {
  sessionId?: string;
  executionId?: string;
  result?: ToolResult;
};

/** The client WebContainer executor posts tool results here. Shape validation,
 *  step binding, replay protection (one-shot pending entries), and expiry all
 *  live in the bridge: this route only checks the envelope and reports whether
 *  a pending execution consumed the payload. A malformed payload for a KNOWN
 *  execution still returns ok:true — the bridge already failed that step fast
 *  with a precise error, so re-posting the same bytes cannot help. */
export async function POST(request: Request) {
  let body: ToolResultRequest;
  try {
    body = (await request.json()) as ToolResultRequest;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const executionId = typeof body.executionId === "string" ? body.executionId : "";

  if (!sessionId || !executionId) {
    return NextResponse.json({ error: "sessionId and executionId are required." }, { status: 400 });
  }

  const resolved = resolveClientExecution(sessionId, executionId, (body.result ?? {}) as ToolResult);
  if (!resolved) {
    return NextResponse.json({ error: "Unknown or expired execution id." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
