import { NextResponse } from "next/server";
import { resolveClientExecution } from "@/lib/agent/execution/bridge";
import type { ToolResult } from "@/lib/agent/types";

type ToolResultRequest = {
  sessionId?: string;
  executionId?: string;
  result?: ToolResult;
};

/** The client WebContainer executor posts tool results here. The server
 *  resolves the pending execution and the Step 3 loop continues. */
export async function POST(request: Request) {
  let body: ToolResultRequest;
  try {
    body = (await request.json()) as ToolResultRequest;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const executionId = typeof body.executionId === "string" ? body.executionId : "";
  const result = body.result;

  if (!sessionId || !executionId) {
    return NextResponse.json({ error: "sessionId and executionId are required." }, { status: 400 });
  }

  if (!result || typeof result.ok !== "boolean" || typeof result.output !== "string") {
    return NextResponse.json({ error: "Invalid tool result payload." }, { status: 400 });
  }

  const resolved = resolveClientExecution(sessionId, executionId, result);
  if (!resolved) {
    return NextResponse.json({ error: "Unknown or expired execution id." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
