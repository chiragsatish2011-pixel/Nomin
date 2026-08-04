import { NextResponse } from "next/server";
import { InputValidationError, parseChatRequest } from "@/lib/agent/input";
import { runTurn } from "@/lib/agent/orchestrator/state-machine";
import { abortSessionExecutions, closePlanApproval } from "@/lib/agent/execution/bridge";
import type { AgentStreamEvent } from "@/lib/agent/protocol";
import { perf } from "@/lib/agent/perf";
import type { AgentStatus } from "@/lib/agent/types";
import { registerActiveTurn, unregisterActiveTurn } from "@/lib/agent/turn-control";
import { withByokProvider } from "@/lib/nim/byok-context";

function timingLog(label: string, startTime: number, meta?: Record<string, unknown>) {
  const elapsed = Date.now() - startTime;
  perf(`timing.${label}`, elapsed, meta);
}

export async function POST(req: Request) {
  const t0 = Date.now();
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    const request = parseChatRequest(payload);
    timingLog("T1_request_parsed", t0, { userText: request.userText.slice(0, 50) });
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        // A single flag guards every write. Without it, an event emitted after
        // the client disconnected threw from `enqueue` deep inside runTurn,
        // which surfaced as a spurious agent error rather than a closed stream.
        let closed = false;
        // A model call may legitimately take longer than the client’s silence
        // watchdog, especially a bounded full-file authoring decision. Repeat
        // the LAST REAL pipeline status while the turn is awaiting work so the
        // UI stays responsive without inventing a tool call or spending another
        // model request. If this route itself dies, the heartbeat dies too and
        // the client can still recover.
        let currentStatus: AgentStatus = "thinking";
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        // A text-only turn can safely finish after its HTTP client goes away:
        // its final response is saved in the session and can be reopened later.
        // Browser-owned tools cannot; they require the originating tab and must
        // stop immediately instead of waiting for a bridge timeout.
        const turnController = new AbortController();
        registerActiveTurn(request.sessionId, turnController);
        let clientDisconnected = false;
        const send = (event: AgentStreamEvent) => {
          if (event.type === "tool_call" || event.type === "plan_approval") {
            if (clientDisconnected) {
              abortSessionExecutions(request.sessionId);
              closePlanApproval(request.sessionId);
              turnController.abort();
              return;
            }
          }
          if (closed) return;
          if (event.type === "status") currentStatus = event.status;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            closed = true;
          }
        };

        const close = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // Controller already closed
          }
        };

        const abort = () => {
          clientDisconnected = true;
          // A disconnected client cannot receive the result. Abort every
          // stage, not only browser-owned tools, so a provider request cannot
          // continue consuming capacity after the page has gone away.
          abortSessionExecutions(request.sessionId);
          closePlanApproval(request.sessionId);
          turnController.abort();
          close();
        };

        req.signal.addEventListener("abort", abort);
        heartbeat = setInterval(() => {
          send({ type: "status", status: currentStatus });
        }, 15_000);

        try {
          await withByokProvider(request.byok, () => runTurn(request, send, t0, turnController.signal));
        } catch {
          const errorEvent: AgentStreamEvent = {
            type: "error",
            error: {
              code: "internal_error",
              // Sanitize at the boundary: an upstream HTTP error body quotes the
              // underlying model id verbatim, and this message is rendered
              // directly in the user's error card.
              // The low-level error belongs in server logs. A customer can act
              // on a retry, not on a stack, tool name, file path or provider
              // response body.
              message: "Trion paused before this request could finish. Retry to continue.",
              retryable: true,
            },
          };
          send(errorEvent);
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          timingLog("T5_response_sent", t0, { sessionId: request.sessionId });
          req.signal.removeEventListener("abort", abort);
          unregisterActiveTurn(request.sessionId, turnController);
          close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "cache-control": "no-cache, no-transform",
        "content-type": "application/x-ndjson; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof InputValidationError ? error.message : "Invalid chat request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
