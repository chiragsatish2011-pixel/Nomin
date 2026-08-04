// Drives one agent turn end to end and records what it actually cost.
//
// Plays every role the browser plays: supplies the workspace snapshot, answers
// the plan-approval gate, executes tool calls against the stand-in workspace and
// posts results back. Then reads the session's REAL token spend out of
// /api/trion/usage (provider-reported `usage`, not a char/4 estimate).

import path from "node:path";
import { runTool, seedWorkspace, snapshot } from "./workspace.mjs";

const BASE = process.env.TRION_BENCH_BASE || "http://127.0.0.1:3000";

export async function resetUsage(sessionId) {
  await fetch(`${BASE}/api/trion/usage?sessionId=${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => {});
}

export async function readUsage(sessionId) {
  const res = await fetch(`${BASE}/api/trion/usage?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`usage endpoint returned ${res.status} — is TRION_BENCH=1 set on the server?`);
  return res.json();
}

async function approve(sessionId, decision = "approve") {
  await fetch(`${BASE}/api/trion/approval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, decision }),
  }).catch(() => {});
}

async function postToolResult(sessionId, executionId, result) {
  await fetch(`${BASE}/api/trion/tool-result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, executionId, result }),
  }).catch(() => {});
}

/**
 * Run one turn.
 *
 * @param {object} spec
 * @param {string} spec.sessionId
 * @param {string} spec.userText
 * @param {"plan"|"execute"} spec.mode
 * @param {string} [spec.root]           workspace dir; omit for a snapshot-less turn
 * @param {string[]} [spec.failCommands] substrings whose run_command must fail (retry testing)
 */
export async function runTurn(spec) {
  const { sessionId, userText, mode, root, failCommands, model } = spec;
  const started = Date.now();
  const timeoutMs = Math.max(5_000, Number(process.env.TRION_BENCH_TIMEOUT_MS ?? 120_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const events = [];
  const toolCalls = [];
  let firstEventAt = null;
  let plan = null;
  let result = null;
  let approvalRequested = false;

  const fileTree = root ? await snapshot(root) : [];

  let res;
  try {
    res = await fetch(`${BASE}/api/trion/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ sessionId, userText, mode, workspacePath: "workspace", snapshot: fileTree, model }),
    });
  } catch (error) {
    clearTimeout(timeout);
    return { ok: false, error: controller.signal.aborted ? `Timed out after ${timeoutMs}ms waiting for the agent.` : error.message, events, toolCalls, ms: Date.now() - started };
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    clearTimeout(timeout);
    return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 300)}`, events, toolCalls, ms: Date.now() - started };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Tool execution must not block the read loop: the server streams the next
  // event as soon as the result is posted, and awaiting inline inside the read
  // deadlocks on a turn that emits two calls back to back.
  const pending = [];

  const handle = (event) => {
    events.push(event);
    if (firstEventAt === null) firstEventAt = Date.now();

    if (event.type === "plan") plan = event.plan;

    if (event.type === "plan_approval") {
      approvalRequested = true;
      pending.push(approve(sessionId, spec.approval ?? "approve"));
    }

    if (event.type === "tool_call") {
      const call = event.call;
      toolCalls.push({ step_id: call.step_id, tool: call.tool_name, input: call.tool_input, at: Date.now() - started });
      pending.push(
        (async () => {
          const toolResult = root
            ? await runTool(root, call.tool_name, call.tool_input, call.step_id, { failCommands })
            : { step_id: call.step_id, ok: false, status: "error", output: "", error: "No workspace in this turn." };
          toolCalls[toolCalls.length - 1].ok = toolResult.ok;
          toolCalls[toolCalls.length - 1].error = toolResult.error;
          await postToolResult(sessionId, call.execution_id, toolResult);
        })()
      );
    }

    if (event.type === "result") result = event.data;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handle(JSON.parse(line));
        } catch {
          /* partial line */
        }
      }
      if (done) break;
    }
    if (buffer.trim()) {
      try {
        handle(JSON.parse(buffer));
      } catch {
        /* ignore */
      }
    }
  } catch (error) {
    clearTimeout(timeout);
    return { ok: false, error: controller.signal.aborted ? `Timed out after ${timeoutMs}ms while reading the agent stream.` : error.message, events, toolCalls, ms: Date.now() - started };
  }
  clearTimeout(timeout);

  await Promise.allSettled(pending);

  return {
    ok: true,
    ms: Date.now() - started,
    ttft: firstEventAt ? firstEventAt - started : null,
    events,
    toolCalls,
    plan,
    result,
    approvalRequested,
    statuses: events.filter((e) => e.type === "status").map((e) => e.status),
  };
}

export { seedWorkspace, path };
