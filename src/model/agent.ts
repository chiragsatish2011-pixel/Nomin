import { CORE_PROMPT, EMPTY_RETRY_NUDGE, WORK_PROMPT, needsWorkPrompt } from "./prompt.js";
import { getModel } from "./registry.js";
import { NvidiaProvider } from "./nvidia.js";
import { createSupervisor, type TurnDigest, type Verdict } from "./supervisor.js";
import type { Message, Provider, ToolCall, ToolDefinition } from "./types.js";

/* ------------------------------------------------------------------ */
/*  Built-in tools — these run server-side, never in the browser.     */
/* ------------------------------------------------------------------ */

const WEB_FETCH_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "web_fetch",
    description:
      "Fetch the content of a URL. Returns the text body (HTML, JSON, plain text) " +
      "up to 12 000 characters. Use this to read documentation, check APIs, or " +
      "pull reference material. Only HTTP/HTTPS URLs are supported.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch.",
        },
      },
      required: ["url"],
    },
  },
};

const BUILTIN_TOOLS: ToolDefinition[] = [WEB_FETCH_TOOL];

const MAX_FETCH_CHARS = 12_000;
const FETCH_TIMEOUT_MS = 15_000;

async function executeToolCall(call: ToolCall): Promise<string> {
  if (call.function.name === "web_fetch") {
    try {
      const args = JSON.parse(call.function.arguments) as { url?: string };
      const url = args.url?.trim();
      if (!url) return JSON.stringify({ error: "No URL provided" });
      if (!/^https?:\/\//i.test(url)) return JSON.stringify({ error: "Only http/https URLs are supported" });
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "NominCode/1.0 (Trion)" },
      });
      if (!response.ok) {
        return JSON.stringify({ error: `HTTP ${response.status} ${response.statusText}` });
      }
      const text = await response.text();
      return text.slice(0, MAX_FETCH_CHARS);
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : "Fetch failed",
      });
    }
  }
  return JSON.stringify({ error: `Unknown tool: ${call.function.name}` });
}

/**
 * One assistant turn, translated into the streams the UI consumes: the answer
 * text, the work-tree event log, and the supervisor's verdict on whether the
 * work was actually delivered.
 *
 * Tree events use the same names as the work tree, so the live view is driven
 * by what really happened — including a rate-limit stall, which parks the
 * branch and resumes the same turn instead of restarting it.
 */
export type TurnFrame =
  | { kind: "tree"; event: TreeFrame }
  | { kind: "text"; text: string }
  | { kind: "error"; message: string }
  | { kind: "usage"; promptTokens: number; completionTokens: number }
  | { kind: "verdict"; verdict: Verdict }
  | { kind: "end" };

export interface TreeFrame {
  type: string;
  id?: string;
  parent?: string;
  label?: string;
  detail?: string;
  waitSeconds?: number;
}

/**
 * How much room the model gets. These are real settings, not labels: each one
 * changes the token budget and temperature sent to the provider.
 */
export type Mode = "quick" | "balanced" | "deep";

const MODE_SETTINGS: Record<Mode, { maxTokens: number; temperature: number }> = {
  quick: { maxTokens: 1024, temperature: 0.1 },
  balanced: { maxTokens: 4096, temperature: 0.2 },
  deep: { maxTokens: 8192, temperature: 0.35 },
};

/**
 * On a reasoning model the token budget *is* the latency dial: the bigger the
 * ceiling, the longer it thinks before the first visible word. Balanced is
 * therefore adaptive — conversation gets a small ceiling and answers almost
 * immediately, engineering work gets the full budget. Quick and DeepThink are
 * explicit choices and are left exactly as asked for.
 */
function resolveBudget(mode: Mode, request: string) {
  if (mode !== "balanced") return MODE_SETTINGS[mode];
  // Building: take the full ceiling so a file is written in as few passes as
  // possible. Talking: a small ceiling, so the reply arrives almost at once.
  return needsWorkPrompt(request) ? MODE_SETTINGS.deep : { maxTokens: 900, temperature: 0.15 };
}

export interface TurnOptions {
  messages: Message[];
  model?: string;
  mode?: Mode;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /** Short title for the task node — usually the first line of the request. */
  title?: string;
}

/** How many times a truncated turn may be continued before giving up. */
const MAX_CONTINUATIONS = 6;

/**
 * A turn is unfinished if the model was cut off, or if it stopped while a code
 * fence was still open — a half-written file is not a delivered file.
 */
function needsMore(state: { answer: string; finish: string }): boolean {
  if (!state.answer) return false;
  if (state.finish === "length") return true;
  return (state.answer.match(/```/g)?.length ?? 0) % 2 === 1;
}

const CONTINUE_NUDGE =
  "You were cut off. Continue from exactly where you stopped — do not repeat anything you already wrote, do not summarise, and do not start over. If a code fence was left open, continue inside it.";

export function createProvider(modelName?: string, env = process.env): Provider {
  const model = getModel(modelName);
  const key = env[model.apiKeyEnv ?? "NVIDIA_API_KEY"] ?? "";
  return new NvidiaProvider(model, key);
}

export async function* runTurn(options: TurnOptions): AsyncGenerator<TurnFrame> {
  const model = getModel(options.model);
  const provider = createProvider(options.model);
  const supervisor = createSupervisor();
  const startedAt = Date.now();

  const log: TreeFrame[] = [];
  const state = {
    answer: "",
    failed: false,
    rateLimited: false,
    thinking: false,
    answering: false,
    /** Why the model stopped. "length" means it was cut off mid-work. */
    finish: "" as string,
  };

  /** Emit a tree event and keep it for the supervisor's digest. */
  const tree = (event: TreeFrame): TurnFrame => {
    log.push(event);
    return { kind: "tree", event };
  };

  const request = lastUserMessage(options.messages);
  const messages = buildPrompt(options.messages, request);
  const settings = resolveBudget(options.mode ?? "balanced", request);

  yield tree({ type: "task.started", id: "task", label: options.title ?? "Task" });

  /** One pass at the model. Yields frames; records what happened in `state`. */
  async function* attempt(history: Message[], pass: number): AsyncGenerator<TurnFrame> {
    state.thinking = true;
    yield tree({
      type: "thinking.started",
      id: `thinking-${pass}`,
      parent: "task",
      label: "Thinking",
    });

    const allTools = [...BUILTIN_TOOLS, ...(options.tools ?? [])];
    const stream = provider.stream({
      messages: history,
      tools: model.capabilities.tools && allTools.length ? allTools : undefined,
      maxTokens: Math.min(settings.maxTokens, model.maxOutputTokens ?? settings.maxTokens),
      temperature: settings.temperature,
      signal: options.signal,
    });

    let cooldowns = 0;
    const pendingCalls: ToolCall[] = [];

    for await (const event of stream) {
      switch (event.type) {
        case "reasoning":
          // Private. Its arrival is a signal, never content.
          break;

        case "delta": {
          if (state.thinking) {
            yield tree({
              type: "thinking.completed",
              id: `thinking-${pass}`,
              label: "Thought through it",
            });
            state.thinking = false;
          }
          if (!state.answering) {
            yield tree({
              type: "step.started",
              id: "answer",
              parent: "task",
              label: "Writing response",
            });
            state.answering = true;
          }
          state.answer += event.text;
          yield { kind: "text", text: event.text };
          break;
        }

        case "tool_call":
          pendingCalls.push(event.call);
          yield tree({
            type: "tool.started",
            id: event.call.id,
            parent: "task",
            label: event.call.function.name,
            detail: summarise(event.call.function.arguments),
          });
          break;

        case "rate_limit": {
          state.rateLimited = true;
          cooldowns += 1;
          yield tree({
            type: "rate_limit.detected",
            parent: "task",
            label: event.status === 429 ? "Rate limit reached" : "Provider overloaded",
            detail: event.status ? `HTTP ${event.status}` : "network",
          });
          yield tree({
            type: "cooldown.started",
            id: `cooldown-${pass}-${cooldowns}`,
            parent: "task",
            label: "Waiting for cooldown",
            waitSeconds: event.waitSeconds,
          });
          break;
        }

        case "cooldown_done":
          yield tree({
            type: "cooldown.completed",
            id: `cooldown-${pass}-${cooldowns}`,
            label: "Cooldown complete",
            detail: "state preserved",
          });
          yield tree({ type: "agent.resumed", label: "Resumed" });
          break;

        case "usage":
          yield {
            kind: "usage",
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
          };
          break;

        case "error":
          state.failed = true;
          if (state.thinking) {
            yield tree({ type: "thinking.completed", id: `thinking-${pass}`, label: "Stopped" });
            state.thinking = false;
          }
          yield { kind: "error", message: event.message };
          break;

        case "done":
          state.finish = event.finishReason ?? "";
          break;
      }
    }

    if (state.thinking) {
      yield tree({
        type: "thinking.completed",
        id: `thinking-${pass}`,
        label: state.answer ? "Thought through it" : "No answer produced",
      });
      state.thinking = false;
    }
    
    return pendingCalls;
  }

  let turnHistory = [...messages];
  let pass = 1;
  while (true) {
    const pendingCalls = yield* attempt(turnHistory, pass);
    if (!pendingCalls.length || state.failed) break;

    // We have tools to run. The assistant just said something (and/or called tools).
    if (state.answer) {
      turnHistory.push({ role: "assistant", content: state.answer, tool_calls: pendingCalls });
    } else {
      turnHistory.push({ role: "assistant", content: null, tool_calls: pendingCalls });
    }
    state.answer = ""; // reset for the next pass
    state.answering = false;

    // Execute them all concurrently
    const results = await Promise.all(
      pendingCalls.map(async (call: ToolCall) => {
        const result = await executeToolCall(call);
        return { call, result };
      })
    );

    for (const { call, result } of results) {
      yield tree({
        type: "tool.completed",
        id: call.id,
        label: "Tool finished",
      });
      turnHistory.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
    pass++;
  }

  // Hitting the token ceiling mid-file is the single most common way a build
  // "finishes" with one truncated page. Continue from exactly where it stopped
  // instead of accepting half the work.
  let continuations = 0;
  while (needsMore(state) && continuations < MAX_CONTINUATIONS) {
    continuations += 1;
    yield tree({
      type: "step.started",
      id: `continue-${continuations}`,
      parent: "task",
      label: "Continuing",
      detail: `part ${continuations + 1}`,
    });
    state.finish = "";
    if (state.answer) {
      turnHistory.push({ role: "assistant", content: state.answer });
      state.answer = "";
    }
    turnHistory.push({ role: "user", content: CONTINUE_NUDGE });
    
    yield* attempt(turnHistory, 10 + continuations);
    
    yield tree({
      type: "step.completed",
      id: `continue-${continuations}`,
      label: `Part ${continuations + 1} written`,
    });
  }

  const fullAnswer = turnHistory
    .slice(messages.length)
    .filter((m) => m.role === "assistant" && typeof m.content === "string")
    .map((m) => m.content as string)
    .join("\n") + (state.answer ? "\n" + state.answer : "");

  // A reasoning model sometimes spends the whole turn in its private channel
  // and closes the stream with nothing to show. That is a failure, not a
  // success — retry once with a direct nudge, then say so plainly.
  if (!fullAnswer && turnHistory.length === messages.length && !state.failed) {
    yield tree({
      type: "step.started",
      id: "retry",
      parent: "task",
      label: "Empty reply — retrying",
    });
    yield* attempt([...messages, { role: "user", content: EMPTY_RETRY_NUDGE }], 2);
    yield tree({
      type: state.answer ? "step.completed" : "step.failed",
      id: "retry",
      label: state.answer ? "Recovered" : "Still empty",
    });
  }

  // Check again after potential retry
  const finalAnswer = fullAnswer || state.answer;
  if (!finalAnswer && !state.failed) {
    state.failed = true;
    yield {
      kind: "error",
      message: "Trion 1.5 returned an empty reply twice. Try again, or rephrase the request.",
    };
  }

  if (state.answering && !state.failed) {
    yield tree({ type: "step.completed", id: "answer", label: "Response complete" });
  }

  // --- supervisor -------------------------------------------------------
  const digest: TurnDigest = {
    request,
    answer: finalAnswer,
    events: log.map(({ type, label, detail }) => ({ type, label, detail })),
    durationMs: Date.now() - startedAt,
    rateLimited: state.rateLimited,
    empty: !finalAnswer,
  };

  yield tree({
    type: "verification.started",
    id: "verify",
    parent: "task",
    label: supervisor.shouldReview(digest) ? "Manager review" : "Checking the record",
  });

  let verdict = await supervisor.review(digest);
  let passed = verdict.status === "verified" || verdict.status === "unverified";
  
  yield tree({
    type: passed ? "verification.passed" : "verification.failed",
    id: "verify",
    label: verdict.summary,
    detail: verdict.usedModel ? "manager" : "evidence",
  });

  if (!passed && verdict.report && !state.failed) {
    yield tree({
      type: "step.started",
      id: "manager-retry",
      parent: "task",
      label: "Manager requested fixes",
      detail: "redoing work",
    });

    const managerNudge = `The manager reviewed your work and found issues. You must fix them.\n\nManager's Report:\n${verdict.report}`;
    turnHistory.push(
      { role: "assistant", content: finalAnswer },
      { role: "user", content: managerNudge }
    );
    state.answer = "";
    
    yield* attempt(turnHistory, 99);
    
    yield tree({
      type: state.answer ? "step.completed" : "step.failed",
      id: "manager-retry",
      label: state.answer ? "Fixes applied" : "Failed to apply fixes",
    });

    // Re-verify after fixes
    const newAnswer = finalAnswer + "\n\n" + state.answer;
    const finalDigest = { ...digest, answer: newAnswer };
    verdict = await supervisor.review(finalDigest);
    passed = verdict.status === "verified" || verdict.status === "unverified";
    
    yield tree({
      type: passed ? "verification.passed" : "verification.failed",
      id: "verify-2",
      parent: "task",
      label: verdict.summary,
      detail: verdict.usedModel ? "manager" : "evidence",
    });
  }

  yield { kind: "verdict", verdict };

  yield tree({
    type: state.failed || verdict.status === "failed" ? "step.failed" : "task.completed",
    id: "task",
    label: state.failed ? "Turn failed" : "Turn complete",
  });
  yield { kind: "end" };
}

/**
 * Assemble the request: the frozen core prompt first (so the provider's KV
 * cache can reuse the prefix across every call in the session), the history
 * next, and the engineering preamble last — only when the request warrants it.
 * Appending at the end is what keeps the cached prefix byte-identical.
 */
function buildPrompt(messages: Message[], request: string): Message[] {
  const history = messages[0]?.role === "system" ? messages : [{ role: "system" as const, content: CORE_PROMPT }, ...messages];
  if (!needsWorkPrompt(request)) return history;
  return [...history, { role: "system", content: WORK_PROMPT }];
}

function lastUserMessage(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const { content } = message;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join(" ");
    }
  }
  return "";
}

/** A one-line preview of tool arguments — never the whole payload. */
function summarise(args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const first = Object.values(parsed)[0];
    return typeof first === "string" ? first.slice(0, 48) : "";
  } catch {
    return "";
  }
}
